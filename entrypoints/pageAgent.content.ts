import { checkMonitorNow } from "@/lib/monitors/client";
import {
  buildFingerprint,
  findLikelyContainer,
  type ElementFingerprint,
} from "@/lib/monitors/fingerprint";
import { resolveSourceUrl } from "@/lib/monitors/itemUrl";
import {
  locateAndExtractWithReanchor,
  resolveSettledValue,
  type LocateAndExtractResult,
} from "@/lib/monitors/locate";
import {
  formatPickerTooltip,
  resolvePickerTargetAtPoint,
  type PickerTarget,
} from "@/lib/monitors/pickerTarget";
import {
  sleep,
  waitForPageReady,
  waitForRegionReady,
  type ReadinessResult,
} from "@/lib/monitors/readiness";
import {
  searchByScrolling,
  type ScrollHost,
} from "@/lib/monitors/scrollRecovery";
import { type SemanticValue } from "@/lib/monitors/semanticValue";
import { createMonitor } from "@/lib/monitors/store";
import { getSettings } from "@/lib/storage";

export interface PickResult {
  /** `true` once a monitor was actually created and saved - not just that a click happened. */
  saved: boolean;
  monitorName: string | null;
  monitorId?: string | null;
}

export interface PageAgentLocateOptions {
  maxTotalWaitMs?: number;
  /**
   * Last known good value for value-anchored re-anchor retries (see
   * `locateAndExtractWithReanchor`). Optional; absent means the plain
   * pipeline runs exactly as before (new/healthy monitors).
   */
  reanchorLastValue?: string | null;
}

export interface PageAgentLocateResponse {
  value: string | null;
  diagnosticCode: string;
  diagnosticMessage: string;
  diagnosticDetail: string | null;
  updatedFingerprint: ElementFingerprint | null;
  confidence: number;
  method: string;
  semanticValue: SemanticValue | null;
}

/**
 * Not auto-registered in the manifest (`registration: 'runtime'` below)
 * — this script only runs when explicitly injected via
 * `chrome.scripting.executeScript`, and only into a tab the extension
 * already has permission for. It attaches its API to `window` so a
 * tiny, fully self-contained follow-up `executeScript({ func })` call
 * can invoke it and get a structured, JSON-serializable result back.
 * This split (a real bundled module with normal imports + a minimal
 * invocation shim) is what lets the fingerprinting/scoring/readiness
 * logic live in shared, testable, importable modules instead of being
 * duplicated inline the way single-function page injection requires.
 */
export default defineContentScript({
  // No `matches`: this script is never auto-registered by the browser —
  // it's only ever injected on demand via `chrome.scripting.executeScript`
  // into a tab the extension already holds a (per-origin, user-granted)
  // host permission for. Declaring `matches` here would make WXT add a
  // broad `<all_urls>` entry to the manifest's `host_permissions`, which
  // defeats the whole incremental-permission model in `lib/permissions`.
  registration: "runtime",
  world: "ISOLATED",
  runAt: "document_idle",
  main() {
    const api = {
      ready: true,
      pick: runPicker,
      locate: runLocate,
    };
    (
      window as unknown as { __monitorPageAgent: typeof api }
    ).__monitorPageAgent = api;
  },
});

/**
 * A captured feed/list item (see `ElementFingerprint.itemAnchor`)
 * reserves this share of its total time budget for the ordinary
 * readiness+recovery path, leaving the rest for a scroll-assisted
 * retry (see `maybeRecoverByScrolling` below) in case it simply isn't
 * mounted yet on a virtualized/infinite-scroll list. Every other
 * monitor keeps the full budget for the ordinary path unchanged, since
 * scrolling only ever runs for a fingerprint with an `itemAnchor`.
 */
const PRIMARY_BUDGET_SHARE = 0.6;
/** Below this, there's not enough budget left for even one meaningful scroll-and-settle round - skip straight to reporting the ordinary outcome rather than starting (and immediately abandoning) a scroll attempt. */
const MIN_SCROLL_BUDGET_MS = 1_500;
/** Diagnostics where the element genuinely wasn't found (as opposed to being blocked by auth/automation walls, which scrolling can't fix). */
const SCROLL_RETRY_CODES = new Set([
  "ELEMENT_NOT_FOUND",
  "SELECTOR_RECOVERY_LOW_CONFIDENCE",
]);

/**
 * Whether scroll recovery may run for this outcome. Reserved for
 * fingerprints carrying an `itemAnchor` (see `scrollRecovery.ts`):
 * only a virtualized list can mount new content in response to
 * scrolling, so an ordinary non-feed monitor - however deep on the
 * page - must never burn budget scrolling. Exported for tests.
 */
export function shouldAttemptScrollRecovery(
  fp: Pick<ElementFingerprint, "itemAnchor">,
  diagnosticCode: string,
): boolean {
  return Boolean(fp.itemAnchor) && SCROLL_RETRY_CODES.has(diagnosticCode);
}

/**
 * Runs `task`, then restores the exact scroll position from before it -
 * on success, on failure, and on early exit alike - so recovery never
 * leaves the user's page scrolled somewhere they didn't put it. Adds
 * no waiting, polling, or retries of its own. Exported for tests.
 */
export async function withRestoredScrollY<T>(
  getY: () => number,
  scrollToY: (y: number) => void,
  task: () => Promise<T>,
): Promise<T> {
  const savedY = getY();
  try {
    return await task();
  } finally {
    scrollToY(savedY);
  }
}

/** Exported for tests (scroll-gate coverage); production calls it via the injected page agent. */
export async function runLocate(
  fpJson: string,
  extractMode: "text" | "attribute",
  attributeName: string | null,
  options?: PageAgentLocateOptions,
): Promise<PageAgentLocateResponse> {
  let fp = JSON.parse(fpJson) as ElementFingerprint;
  const totalBudgetMs = options?.maxTotalWaitMs ?? 16_000;
  const start = Date.now();
  const isFeedItem = Boolean(fp.itemAnchor);
  const primaryBudgetMs = isFeedItem
    ? Math.round(totalBudgetMs * PRIMARY_BUDGET_SHARE)
    : totalBudgetMs;

  const read = (): LocateAndExtractResult => {
    const result = locateAndExtractWithReanchor(
      document,
      fp,
      extractMode,
      attributeName,
      window,
      options?.reanchorLastValue ?? null,
    );
    // Self-heal the working fingerprint across retries too, not just
    // on the final accepted result - otherwise a relocation found on
    // one attempt would be thrown away and re-discovered from scratch
    // (or missed) on the next attempt's confirmation read.
    if (result.updatedFingerprint) fp = result.updatedFingerprint;
    return result;
  };

  // Prefer a region-scoped readiness wait over the page-wide one
  // whenever some ancestor of the originally-captured element still
  // resolves - it lets recovery proceed once the target's own
  // neighborhood has settled, without being held hostage by unrelated
  // parts of the page that may never go fully quiet (a live ticker, a
  // chat widget, a lazily-loading recommendation rail). Recomputed on
  // every call (self-healing if the container itself gets replaced by
  // a re-render) rather than cached - it's a handful of bounded
  // `querySelector` calls up an ancestor chain, not a full-page scan,
  // so recomputing it per attempt is cheap. Falls back to the
  // page-wide signal, unchanged from before, whenever no ancestor
  // resolves yet - i.e. the target's whole neighborhood hasn't mounted
  // at all, so there's nothing meaningful to scope a wait to.
  const waitForReady = (maxWaitMs: number): Promise<ReadinessResult> => {
    const container = findLikelyContainer(document, fp);
    if (container) {
      return waitForRegionReady(window, container, { maxWaitMs });
    }
    return waitForPageReady(window, { maxWaitMs });
  };

  let outcome = await resolveSettledValue(waitForReady, read, {
    maxTotalWaitMs: primaryBudgetMs,
  });

  // Both conditions: the monitor must have started as a feed item
  // (healed fingerprints re-derive their anchor from wherever recovery
  // landed, so the current one alone must not widen recovery to
  // originally ordinary monitors) and the outcome must be a genuine
  // miss that scrolling could fix.
  const shouldTryScroll =
    isFeedItem && shouldAttemptScrollRecovery(fp, outcome.diagnostic.code);
  if (outcome.value === null && shouldTryScroll) {
    const remainingMs = totalBudgetMs - (Date.now() - start);
    if (remainingMs >= MIN_SCROLL_BUDGET_MS) {
      const scrolled = await maybeRecoverByScrolling(read, remainingMs);
      if (scrolled) outcome = scrolled;
    }
  }

  return {
    value: outcome.value,
    diagnosticCode: outcome.diagnostic.code,
    diagnosticMessage: outcome.diagnostic.message,
    diagnosticDetail: outcome.diagnostic.detail ?? null,
    updatedFingerprint: outcome.updatedFingerprint,
    confidence: outcome.confidence,
    method: outcome.method,
    semanticValue: outcome.semanticValue,
  };
}

/**
 * Last-resort recovery for a captured feed/list item that the ordinary
 * readiness+recovery path couldn't find: scrolls the live page
 * downward in bounded rounds, giving a virtualized/infinite-scroll
 * list a chance to mount content it hasn't rendered yet, re-trying
 * `read` after each round. See `scrollRecovery.ts` for why this exists
 * and is scoped to feed items only.
 *
 * Returns `null` (never a failing result) when nothing better than the
 * caller's existing outcome was found, so the caller keeps its
 * original diagnostic rather than a less-informative "gave up while
 * scrolling" one.
 */
async function maybeRecoverByScrolling(
  read: () => LocateAndExtractResult,
  remainingMs: number,
): Promise<LocateAndExtractResult | null> {
  return withRestoredScrollY(
    () => window.scrollY,
    (y) => window.scrollTo(0, y),
    async () => {
      const host: ScrollHost = {
        read: () => ({
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
        }),
        scrollDown: () => {
          window.scrollBy(0, Math.max(window.innerHeight * 0.85, 400));
        },
      };

      const { result } = await searchByScrolling(
        host,
        () => {
          const attempt = read();
          return attempt.value !== null ? attempt : null;
        },
        sleep,
        { deadline: Date.now() + remainingMs },
      );

      return result;
    },
  );
}

/**
 * Interactive picker: hover highlights the best monitorable element
 * near the cursor (not necessarily the literal element under it - see
 * `resolvePickerTarget`) with a live preview of what would be
 * captured. A click on a valid target moves to a short naming step -
 * a small field anchored to the picked element - and the monitor is
 * only actually created once that name is submitted.
 *
 * On-page footprint is deliberately minimal at every step - the
 * cursor-following tooltip and highlight box while hovering, then
 * just the highlight and a small naming field once something's
 * picked. There's no banner, no backdrop, nothing else added to the
 * page: the panel that triggered this has already closed itself, and
 * the picker shouldn't put anything bigger in its place.
 */
async function runPicker(): Promise<PickResult> {
  const settings = await getSettings();
  const isDark = settings.ok && settings.value.theme === "dark";
  return new Promise((resolve) => {
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";

    // Same grayscale palette as styles/globals.css (--foreground,
    // --muted-foreground, --border, --muted) - the picker is injected
    // directly into the host page, outside the app's own CSS, so its
    // colors are hard-coded here rather than shared via variables. Kept
    // in lockstep with the app's tokens so the on-page UI reads as the
    // same product as the panel, not a bolted-on tool.
    const FONT = `-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif`;
    const FOREGROUND = isDark ? "#edf0f4" : "#171717";
    const MUTED_FOREGROUND = isDark ? "#a4acb8" : "#737373";
    const BORDER = isDark ? "rgba(255,255,255,0.13)" : "rgba(0,0,0,0.08)";
    const SURFACE = isDark ? "rgba(35,38,43,0.92)" : "rgba(255,255,255,0.92)";
    const SURFACE_SOLID = isDark ? "#23262b" : "#ffffff";
    const MUTED_FILL = isDark ? "#30343a" : "#f5f5f5";
    // A touch darker than MUTED_FILL, used only for the naming form's
    // "No, keep it" button hover - matches --accent in styles/globals.css.
    const ACCENT_FILL = isDark ? "#3b4047" : "#f0f0f0";
    // Translucent overlay of FOREGROUND, same alpha-overlay convention
    // as BORDER/ACCENT_FILL above (this UI paints over arbitrary page
    // backgrounds, so tokens here are alpha overlays rather than the
    // app's own solid --ring hex). Used for the input's focus glow and
    // the buttons' focus-visible ring - the on-page equivalent of the
    // app's `focus-visible:ring-2 ring-ring ring-offset-2` recipe.
    const RING = isDark ? "rgba(237,240,244,0.35)" : "rgba(23,23,23,0.22)";

    // Every on-page picker element (highlight box, tooltip, naming
    // form) lives inside its own closed shadow root instead of being
    // appended straight to `document.documentElement`, for the same
    // two-way isolation reason `panel.content.tsx` uses one for the
    // main panel: without it, a page's own global resets, dark-mode
    // overrides, or broad tag/class selectors (YouTube's Polymer
    // components being a good example) can reach in and restyle this
    // UI, and this UI's own namespaced `<style>` tag - however
    // unlikely - is technically sitting in the page's global style
    // scope too. A shadow boundary closes off both directions, so the
    // picker looks and behaves identically on every site instead of
    // depending on what CSS that particular page happens to ship.
    const host = document.createElement("div");
    const hostStyle = host.style;
    hostStyle.setProperty("all", "initial", "important");
    hostStyle.setProperty("display", "block", "important");
    hostStyle.setProperty("position", "static", "important");
    hostStyle.setProperty("width", "0", "important");
    hostStyle.setProperty("height", "0", "important");
    hostStyle.setProperty("margin", "0", "important");
    hostStyle.setProperty("padding", "0", "important");
    hostStyle.setProperty("overflow", "visible", "important");
    document.documentElement.appendChild(host);
    // 'open', not 'closed' like the main panel: the naming step's
    // outside-click detection (below) has to run from a `document`
    // -level listener, since it needs to catch clicks anywhere on the
    // page, not just inside this tree. That requires `composedPath()`
    // to reveal this shadow tree's contents to that external listener
    // - which the spec only allows for 'open' roots; a 'closed' root
    // hides its contents from `composedPath()` too, not just from
    // `element.shadowRoot`, which made every click (including on Save
    // itself) look like an outside click and immediately cancel the
    // pick before it could save. 'open' still gets full CSS
    // encapsulation either way (that part isn't mode-dependent) - it
    // only gives a page script the ability to inspect this transient
    // picker UI's markup while it's on screen, which isn't a concern
    // here the way it would be for the panel's persisted monitor data.
    const shadow = host.attachShadow({ mode: "open" });

    // Same top-layer promotion the panel uses, and for the same
    // reason: an ancestor anywhere above this host with a `transform`,
    // `filter`, `backdrop-filter`, `will-change`, etc. would otherwise
    // silently repoint every `position: fixed` element below into that
    // ancestor's box instead of the real viewport. Feature-detected -
    // the fixed/inset styles already work correctly without it, just
    // not immune to that one class of interference.
    if (typeof host.showPopover === "function") {
      host.setAttribute("popover", "manual");
      try {
        host.showPopover();
      } catch {
        // Already shown, or the page did something unusual first - the
        // plain fixed positioning below still works either way.
      }
    }

    // Handles every bit of styling raw inline `style.cssText` can't
    // express - :focus/:hover/:active states and the entrance keyframe
    // - scoped to the shadow root so it can never collide with (or be
    // collided into by) the host page's own classes or stylesheet.
    const styleTag = document.createElement("style");
    styleTag.textContent = `
      @keyframes __monitorext-in {
        from { opacity: 0; transform: translateY(4px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .__monitorext-input {
        transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
      }
      .__monitorext-input:focus {
        border-color: ${FOREGROUND} !important;
        box-shadow: 0 0 0 3px ${RING} !important;
      }
      .__monitorext-btn {
        transition: background-color 120ms ease-out, color 120ms ease-out, opacity 120ms ease-out, transform 80ms ease-out, box-shadow 120ms ease-out;
      }
      .__monitorext-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px ${SURFACE_SOLID}, 0 0 0 4px ${RING}; }
      .__monitorext-btn:active:not(:disabled) { transform: scale(0.97); }
      .__monitorext-btn-cancel:hover:not(:disabled) { background-color: ${ACCENT_FILL} !important; }
      .__monitorext-btn-save:hover:not(:disabled) { background-color: ${isDark ? "#ffffff" : "#000"} !important; color: ${isDark ? "#171717" : "#ffffff"} !important; }
      .__monitorext-btn-save:disabled { opacity: 0.4; cursor: default; }
    `;
    shadow.appendChild(styleTag);

    // The highlight box traced around the hovered element. Rounded,
    // softly shadowed rather than a hard line, so it reads as a gentle
    // focus ring instead of a debugger's inspect overlay.
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;" +
      `border:2px solid ${FOREGROUND};background:rgba(23,23,23,0.045);` +
      "box-shadow:0 0 0 4px rgba(23,23,23,0.045);" +
      "border-radius:6px;display:none;" +
      "transition:top 100ms cubic-bezier(0.22,1,0.36,1),left 100ms cubic-bezier(0.22,1,0.36,1)," +
      "width 100ms cubic-bezier(0.22,1,0.36,1),height 100ms cubic-bezier(0.22,1,0.36,1)," +
      "border-color 120ms ease-out,background-color 120ms ease-out;";
    shadow.appendChild(overlay);

    // The cursor-following hint. Frosted white to match the panel's own
    // surface (bg-background + its shadow recipe) instead of the flat
    // black chip this used to be - the same material reused at a
    // smaller size, not a separate visual language.
    const tooltip = document.createElement("div");
    tooltip.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;" +
      `background:${SURFACE};backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);` +
      `border:0.5px solid ${BORDER};` +
      `color:${FOREGROUND};font:500 12px/1.5 ${FONT};` +
      "padding:5px 10px;border-radius:8px;display:none;" +
      "max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "box-shadow:0 12px 28px -6px rgba(0,0,0,0.18),0 2px 6px rgba(0,0,0,0.06);" +
      "transition:opacity 100ms ease-out;";
    shadow.appendChild(tooltip);

    let currentTarget: PickerTarget | null = null;
    // `settled` guards against a second click committing while a
    // naming step is already in progress (or after Escape/an outside
    // click). `cleanedUp` guards the teardown itself so it's safe to
    // call from more than one exit path without double-removing nodes
    // or double-resolving.
    let settled = false;
    let cleanedUp = false;

    // Every listener attached anywhere in this session — hovering or
    // naming — registers its own removal here, so `cleanup()` can tear
    // the whole session down from a single call regardless of which
    // phase it was in when it ended. This is what makes it safe to add
    // the naming step's own listeners without hand-tracking a second
    // parallel set of add/remove calls.
    const teardownFns: Array<() => void> = [];
    function on<K extends keyof DocumentEventMap>(
      target: Document | HTMLElement,
      type: K,
      handler: (event: DocumentEventMap[K]) => void,
      useCapture = false,
    ): void {
      target.addEventListener(type, handler as EventListener, useCapture);
      teardownFns.push(() =>
        target.removeEventListener(type, handler as EventListener, useCapture),
      );
    }

    /**
     * Tears down every trace of a picker session - listeners, cursor,
     * highlight, tooltip, naming field - exactly once. This is the
     * single exit path for every way a session can end (save, Escape,
     * an outside click while naming, or otherwise) so a session can
     * never leave a stray overlay or dangling listener behind for the
     * next "Add monitor" to trip over, and so the user can always
     * start a fresh pick without reloading the page.
     */
    function cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      for (const off of teardownFns.splice(0)) off();
      document.documentElement.style.cursor = previousCursor;
      host.remove();
    }

    function positionTooltip(clientX: number, clientY: number): void {
      // Offset below-right of the cursor; flipped to above-right once
      // there's no room below, so it never runs off the viewport.
      const OFFSET = 14;
      tooltip.style.left = `${Math.min(clientX + OFFSET, window.innerWidth - 260)}px`;
      const spaceBelow = window.innerHeight - clientY;
      if (spaceBelow < 60) {
        tooltip.style.top = `${clientY - 34}px`;
      } else {
        tooltip.style.top = `${clientY + OFFSET}px`;
      }
    }

    function showValid(target: PickerTarget): void {
      const rect =
        target.range?.getBoundingClientRect() ??
        target.element.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.borderColor = FOREGROUND;
      overlay.style.borderStyle = target.isAmbiguous ? "dashed" : "solid";
      overlay.style.background = target.isAmbiguous
        ? "rgba(23,23,23,0.02)"
        : "rgba(23,23,23,0.045)";
      overlay.style.top = `${rect.top}px`;
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      tooltip.style.display = "block";
      tooltip.style.color = FOREGROUND;
      tooltip.textContent = formatPickerTooltip(target);
      document.documentElement.style.cursor = target.isAmbiguous
        ? "help"
        : "crosshair";
    }

    function showInvalid(): void {
      // No highlight box at all — its absence is the "this isn't
      // selectable" signal, on top of the tooltip explaining why.
      overlay.style.display = "none";
      tooltip.style.display = "block";
      tooltip.style.color = MUTED_FOREGROUND;
      tooltip.textContent = "✕ Not a readable value";
      document.documentElement.style.cursor = "not-allowed";
    }

    function onMouseMove(event: MouseEvent): void {
      positionTooltip(event.clientX, event.clientY);

      const resolved = resolvePickerTargetAtPoint(
        document,
        event.clientX,
        event.clientY,
      );
      if (resolved) {
        currentTarget = resolved;
        showValid(resolved);
      } else {
        currentTarget = null;
        showInvalid();
      }
    }

    function onClick(event: MouseEvent): void {
      event.preventDefault();
      event.stopPropagation();
      if (settled) return;

      // Not a readable value under the cursor right now - refuse the
      // click entirely rather than moving on to naming something
      // meaningless. The picker stays active so the user can keep
      // looking.
      if (!currentTarget) return;

      const target = currentTarget;
      const resolved = resolvePickerTargetAtPoint(
        document,
        event.clientX,
        event.clientY,
      );
      // Re-resolve at click time rather than trusting the hover state:
      // cheap, and guards against the rare case of the DOM changing
      // between the last mousemove and this click.
      if (!resolved || !sameSelection(target, resolved)) {
        showInvalid();
        return;
      }

      // If confidence is low or multiple numeric candidates are plausible,
      // clearly indicate the ambiguity instead of silently choosing the wrong value.
      if (resolved.isAmbiguous) {
        showValid(resolved);
        return;
      }

      settled = true;
      // Fingerprint the target right now, while `resolved.element` is
      // known-fresh (just re-validated above) - not later, in
      // `commit()`. Naming is a free-form text step with no time
      // limit, and the one thing it must never affect is *what gets
      // captured*: the monitor's identity has to be exactly what the
      // user clicked, independent of how long they spend on the name.
      // Deferring this call to commit() used to mean an SPA re-render
      // during typing (framework churn is constant on sites like
      // this) could detach `resolved.element` from the document
      // first, silently fingerprinting a phantom node instead - see
      // the `buildFingerprint` call this replaces for the full
      // rationale. `fingerprint` itself is plain structural/context
      // data (no DOM node or Range), so holding onto it through the
      // whole naming step is safe.
      const fingerprint = buildFingerprint(
        resolved.element,
        window,
        resolved.textAnchor,
      );
      promptForName(resolved, fingerprint);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || settled) return;
      settled = true;
      cleanup();
      resolve({ saved: false, monitorName: null });
    }

    /**
     * The naming step: hover-tracking stops the instant an element is
     * picked, leaving only the highlight (now pinned to that element)
     * and a small field anchored beside it. Nothing is saved until
     * this is submitted — Escape, the "No, keep it" button, or a click
     * outside the field all back out with nothing created.
     */
    function promptForName(
      resolved: PickerTarget,
      fingerprint: ElementFingerprint,
    ): void {
      // Done hovering - only the (now-pinned) highlight remains behind
      // the naming field.
      for (const off of teardownFns.splice(0)) off();
      tooltip.remove();
      document.documentElement.style.cursor = previousCursor;

      // Opaque white card - a small step up from the frosted, cursor-
      // anchored tooltip/highlight above: naming is the one moment in
      // the whole pick where the user actually reads and types, so it
      // gets a solid surface and real hierarchy (title + description).
      // Same grayscale tokens and font stack as the rest of the picker
      // either way, so it still reads as one continuous flow, not a
      // different surface. Radius matches the app's own DialogContent
      // (`rounded-lg`); button/input radius below matches its Button
      // and Input components (`rounded-md`) - same tokens, not a new
      // design system.
      const form = document.createElement("div");
      form.style.cssText =
        `position:fixed;z-index:2147483647;width:${FORM_WIDTH}px;box-sizing:border-box;` +
        `background:${SURFACE_SOLID};` +
        `color:${FOREGROUND};font:14px/1.4 ${FONT};` +
        `border:1px solid ${BORDER};` +
        "padding:16px;border-radius:10px;" +
        "box-shadow:0 24px 60px -12px rgba(0,0,0,0.28),0 4px 16px rgba(0,0,0,0.08);" +
        "display:flex;flex-direction:column;gap:12px;" +
        "animation:__monitorext-in 180ms cubic-bezier(0.22,1,0.36,1);";

      const header = document.createElement("div");
      header.style.cssText = "display:flex;flex-direction:column;gap:3px;";

      const titleEl = document.createElement("div");
      titleEl.textContent = "Name this monitor";
      titleEl.style.cssText = `font-size:14px;font-weight:600;letter-spacing:-0.01em;color:${FOREGROUND};`;
      header.appendChild(titleEl);

      const descriptionEl = document.createElement("div");
      descriptionEl.textContent = "Give this monitor a name.";
      descriptionEl.style.cssText = `font-size:12px;line-height:1.5;color:${MUTED_FOREGROUND};`;
      header.appendChild(descriptionEl);

      form.appendChild(header);

      // The value being monitored, shown before anything is saved: the
      // last chance to catch a hover/click mismatch (the tooltip already
      // scrolled away with the cursor). Compact and muted like the
      // description above it, ellipsized rather than wrapped.
      const valuePreview = document.createElement("div");
      valuePreview.textContent = namingValuePreview(resolved);
      valuePreview.style.cssText =
        `font-size:12px;line-height:1.5;color:${MUTED_FOREGROUND};` +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      form.appendChild(valuePreview);

      const input = document.createElement("input");
      input.type = "text";
      // Leave the field empty by default so naming is always an
      // explicit choice instead of silently reusing a guessed label.
      input.value = "";
      input.maxLength = 80;
      input.spellcheck = false;
      input.className = "__monitorext-input";
      input.style.cssText =
        `width:100%;box-sizing:border-box;background:${SURFACE_SOLID};color:${FOREGROUND};` +
        `border:1px solid ${BORDER};border-radius:8px;padding:8px 10px;` +
        `font:13px ${FONT};outline:none;`;
      form.appendChild(input);

      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

      // Height (28px), radius (8px), and type weight (12px/500) match
      // the panel's own "Add" button (`h-7`, its Button component's
      // `rounded-md`, and `text-xs`) exactly, so this on-page modal
      // reads as the same product as the extension's own UI.
      const BUTTON_STYLE =
        `height:28px;border-radius:8px;padding:0 14px;font:500 12px/1 ${FONT};` +
        "border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = "No, keep it";
      cancelButton.className = "__monitorext-btn __monitorext-btn-cancel";
      cancelButton.style.cssText = `${BUTTON_STYLE}background:${MUTED_FILL};color:${FOREGROUND};`;

      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.textContent = "Save";
      saveButton.className = "__monitorext-btn __monitorext-btn-save";
      saveButton.style.cssText = `${BUTTON_STYLE}background:${FOREGROUND};color:${isDark ? "#171717" : "#fff"};`;

      row.appendChild(cancelButton);
      row.appendChild(saveButton);
      form.appendChild(row);
      shadow.appendChild(form);
      positionForm(form, resolved.element);

      function cancelNaming(): void {
        if (cleanedUp) return;
        form.remove();
        cleanup();
        resolve({ saved: false, monitorName: null, monitorId: null });
      }

      async function commit(): Promise<void> {
        if (cleanedUp || saveButton.disabled) return;
        const name = input.value.trim();
        saveButton.disabled = true;
        saveButton.textContent = "Saving…";

        // `fingerprint` was captured back in onClick, the moment the
        // target was confirmed - not re-derived here. See the call
        // site for why: this step's only job is turning `name` (and
        // nothing else) into a saved monitor.
        const created = await createMonitor({
          name,
          // The exact canonical source, not necessarily this page: a
          // feed selection resolves to the picked item's own permalink
          // (see resolveSourceUrl), with tracking params stripped
          // either way. Kept in sync with resolveCheckUrl, which
          // every check already navigates to for the same reason.
          url: resolveSourceUrl(window.location.href, fingerprint.itemAnchor),
          fingerprint,
          extractMode: "text",
        });

        if (!created.ok) {
          // Saving failed (e.g. a storage write error) - let the user
          // fix the name or just try again rather than losing the pick.
          saveButton.disabled = false;
          saveButton.textContent = "Save";
          return;
        }

        form.remove();
        cleanup();
        resolve({ saved: true, monitorName: created.value.name, monitorId: created.value.id });

        // Not awaited: the monitor is already saved and visible; this
        // just fills in a real value sooner than the next scheduled tick.
        void checkMonitorNow(created.value.id).catch((cause) => {
          console.error("[pageAgent] Initial check failed:", cause);
        });
      }

      on(form, "keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelNaming();
        }
        // Every other key (including plain typing) is left alone so the
        // field behaves like a normal text input.
      });
      on(cancelButton, "click", cancelNaming);
      on(saveButton, "click", () => void commit());
      // `mousedown`, not `click`, so this can't race the input's own
      // focus-on-mousedown and misfire as "outside" on the very click
      // that opened the field.
      //
      // `composedPath()`, not `form.contains(event.target)`: the form
      // now lives inside a (open) shadow root, and any event that
      // crosses a shadow boundary gets its `.target` retargeted to the
      // shadow host for listeners outside that tree - so from this
      // `document`-level listener, `event.target` would always read as
      // `host`, never the actual button/input clicked, and every click
      // anywhere (including inside the form) would look like an
      // "outside" click. `composedPath()` returns the real path the
      // event traveled, shadow-internal nodes included (since the root
      // above is 'open'), so this still correctly tells inside from
      // outside.
      on(
        document,
        "mousedown",
        (event) => {
          if (!event.composedPath().includes(form)) cancelNaming();
        },
        true,
      );

      input.focus();
    }

    on(document, "mousemove", onMouseMove, true);
    on(document, "click", onClick, true);
    on(document, "keydown", onKeyDown, true);
  });
}

/**
 * Reject a click if a rerender or pointer move changed the value/context
 * since hover - with one deliberate exception: the very same live node
 * is always accepted, even if its text ticked in the meantime, because
 * the fingerprint is built from the click-time state and the naming
 * step shows that value for confirmation.
 *
 * Two different nodes pass only with fully identical content (text,
 * canonical value, anchors, label) AND the same on-screen slot: a
 * hover node already detached by a re-render has no box left to
 * compare, so content alone decides there (a re-created equivalent in
 * the same slot keeps working), while wrappers resolved as parent vs
 * inner span nest and still count. A duplicate value in another row -
 * identical text, different box - is rejected instead of silently
 * monitoring the wrong row. Exported for tests.
 */
export function sameSelection(a: PickerTarget, b: PickerTarget): boolean {
  if (a.element === b.element) return true;
  if (
    a.text !== b.text ||
    a.canonicalValue !== b.canonicalValue ||
    a.textAnchor.before !== b.textAnchor.before ||
    a.textAnchor.after !== b.textAnchor.after ||
    a.label !== b.label
  ) {
    return false;
  }
  if (!a.element.isConnected) return true;
  if (a.element.contains(b.element) || b.element.contains(a.element))
    return true;
  return sameScreenPosition(a.element, b.element);
}

/** Same top-left within a couple px of subpixel/rounding slack (not layout drift). */
function sameScreenPosition(a: Element, b: Element): boolean {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return Math.abs(ra.top - rb.top) <= 2 && Math.abs(ra.left - rb.left) <= 2;
}

/** Width of the naming field injected into the page - shared with `positionForm` below so the two never drift apart. */
const FORM_WIDTH = 300;

/**
 * The confirmation line for the naming step: the exact canonical value
 * about to be monitored. Pure so it stays identical between the form
 * and tests - export is for tests only.
 */
export function namingValuePreview(target: PickerTarget): string {
  return `Selected value: ${target.canonicalValue}`;
}

/** Anchors the naming field just below-left of `target`, flipped above when there's no room below, and clamped so it never runs off the viewport. */
function positionForm(form: HTMLDivElement, target: Element): void {
  const rect = target.getBoundingClientRect();
  const MARGIN = 8;

  const left = Math.min(
    Math.max(rect.left, MARGIN),
    window.innerWidth - FORM_WIDTH - MARGIN,
  );
  form.style.left = `${left}px`;

  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < 200) {
    form.style.top = "auto";
    form.style.bottom = `${window.innerHeight - rect.top + MARGIN}px`;
  } else {
    form.style.top = `${rect.bottom + MARGIN}px`;
    form.style.bottom = "auto";
  }
}
