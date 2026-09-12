import type {
  PageAgentLocateResponse,
  PickResult,
} from "@/entrypoints/pageAgent.content";
import { diagnostic, type Diagnostic } from "./diagnostics";
import type { ElementFingerprint } from "./fingerprint";
import { sleep } from "./readiness";
import type { SemanticValue } from "./semanticValue";

const PAGE_AGENT_FILE = "/content-scripts/pageAgent.js";

/**
 * Ensures the page agent content script has been injected into `tabId`.
 * Injection is idempotent — `defineContentScript`'s `main()` re-runs
 * `window.__monitorPageAgent = api` harmlessly if called twice, and
 * `chrome.scripting.executeScript` itself is safe to call repeatedly.
 */
async function ensurePageAgentInjected(tabId: number): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId },
    files: [PAGE_AGENT_FILE],
  });
}

/**
 * `chrome.scripting.executeScript` throws these when it targets a frame
 * that's mid-replacement — the tab already reported `status: 'complete'`
 * for its *previous* document, but a redirect or client-triggered
 * navigation (YouTube does this routinely) swaps in a new one right as
 * injection runs. The frame the call was aimed at genuinely no longer
 * exists by the time Chrome processes the request; it isn't a
 * permission problem or a closed tab, and the very next frame is
 * usually scriptable within milliseconds. Distinct from
 * `mapInjectionError`'s patterns below, which are persistent
 * conditions retrying can't fix.
 */
const TRANSIENT_FRAME_ERROR =
  /frame with id \d+ was removed|no frame with id \d+ in tab|frame with id \d+ is showing error page/i;

export function isTransientFrameError(error: unknown): boolean {
  return TRANSIENT_FRAME_ERROR.test(describeError(error));
}

/** Short, bounded backoff for the frame-replacement race — long enough to let a bounce-navigation land, short enough that a genuinely stuck tab still fails within a couple seconds rather than eating the outer check budget. */
const FRAME_RETRY_DELAYS_MS = [150, 400];

/** Minimal tab state needed to judge settledness — kept as a small snapshot rather than the full `Tab` so two reads are trivially comparable. */
interface TabSnapshot {
  status: string | undefined;
  url: string | undefined;
}

/** Reads `tabId`'s current status/url. `null` (rather than throwing) if the tab is gone; the caller decides what that means. */
async function getTabSnapshot(tabId: number): Promise<TabSnapshot | null> {
  try {
    const tab = await browser.tabs.get(tabId);
    return { status: tab.status, url: tab.url };
  } catch {
    return null;
  }
}

/** Delay between the two reads used to confirm the tab has actually settled — long enough to catch a same-tick bounce navigation, short enough not to meaningfully eat into the outer check budget. */
const SETTLE_RECHECK_DELAY_MS = 150;
/** How many settle rounds to attempt while the tab is still visibly navigating, before handing off to injection regardless. Bounded so a page that never truly settles (a persistent redirect loop) still fails fast via injection's own error path rather than spinning here forever. */
const SETTLE_MAX_ATTEMPTS = 3;

/**
 * Verifies `tabId`'s document has actually settled before injection is
 * attempted, rather than trusting the `tabs.onUpdated` "complete" event
 * alone — that event fires for the document that existed *at that
 * instant*, which a fast client-side redirect (or a server redirect
 * chain) can immediately replace. This is the primary synchronization
 * point for that race: it takes two snapshots a beat apart and only
 * treats the tab as settled once both agree it's `complete` *and* on
 * the same URL. A single stale/bouncing read no longer passes — it
 * costs another round instead. `runWithFrameRetry` below remains a
 * backstop for whatever slips past every attempt here (a bounce that
 * starts a beat later than any of our reads), not the main mechanism.
 */
export async function verifyTabSettled(
  tabId: number,
): Promise<{ ok: true } | { ok: false; diagnostic: Diagnostic }> {
  for (let attempt = 0; attempt < SETTLE_MAX_ATTEMPTS; attempt++) {
    const before = await getTabSnapshot(tabId);
    if (!before) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "TAB_CLOSED",
          "closed before it could be verified stable",
        ),
      };
    }

    await sleep(SETTLE_RECHECK_DELAY_MS);

    const after = await getTabSnapshot(tabId);
    if (!after) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "TAB_CLOSED",
          "closed before it could be verified stable",
        ),
      };
    }

    if (after.status === "complete" && after.url === before.url) {
      return { ok: true };
    }
    // Still navigating, or bounced to a different URL between the two
    // reads — give it another round before handing off to injection.
  }
  return { ok: true };
}

/**
 * Runs `attempt` (an injection + script execution) with retry limited
 * strictly to the transient frame-replacement race above. Before each
 * retry, confirms the tab still exists at all — a closed tab is a
 * different, non-retryable failure (`TAB_CLOSED`) that this wrapper
 * fails fast on rather than burning through the retry budget for.
 * Never throws.
 */
async function runWithFrameRetry<T>(
  tabId: number,
  attempt: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; diagnostic: Diagnostic }> {
  let lastError: unknown = null;
  for (let i = 0; i <= FRAME_RETRY_DELAYS_MS.length; i++) {
    try {
      const value = await attempt();
      return { ok: true, value };
    } catch (error) {
      lastError = error;
      if (!isTransientFrameError(error)) {
        return { ok: false, diagnostic: mapInjectionError(error) };
      }
      const delay = FRAME_RETRY_DELAYS_MS[i];
      if (delay === undefined) break; // retries exhausted
      try {
        await browser.tabs.get(tabId);
      } catch {
        return {
          ok: false,
          diagnostic: diagnostic(
            "TAB_CLOSED",
            "closed during a navigation retry",
          ),
        };
      }
      await sleep(delay);
    }
  }
  return { ok: false, diagnostic: mapInjectionError(lastError) };
}

export interface LiveLocateOutcome {
  ok: boolean;
  value: string | null;
  diagnostic: Diagnostic;
  updatedFingerprint: ElementFingerprint | null;
  confidence: number;
  method: string;
  semanticValue: SemanticValue | null;
}

/** Runs the page agent's `locate()` against `tabId`, injecting it first if needed. */
export async function locateOnTab(
  tabId: number,
  fingerprint: ElementFingerprint,
  extractMode: "text" | "attribute",
  attributeName: string | null,
  maxTotalWaitMs: number,
): Promise<LiveLocateOutcome> {
  // Both the file injection and the follow-up `func` call are made
  // inside the *same* retry attempt — if a frame-replacement race hits
  // either one, the frame that gets scripted on the retry is a fresh
  // one with nothing injected into it yet, so re-injecting from
  // scratch (not just retrying the `locate()` call) is what actually
  // recovers rather than reproducing the same failure.
  const attemptResult = await runWithFrameRetry(tabId, async () => {
    await ensurePageAgentInjected(tabId);
    const [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: (
        fpJson: string,
        mode: "text" | "attribute",
        attrName: string | null,
        waitMs: number,
      ) => {
        const win = window as unknown as {
          __monitorPageAgent?: {
            locate: (...args: unknown[]) => Promise<PageAgentLocateResponse>;
          };
        };
        if (!win.__monitorPageAgent) {
          return Promise.resolve<PageAgentLocateResponse>({
            value: null,
            diagnosticCode: "UNKNOWN",
            diagnosticMessage:
              "Monitoring agent was not available on this page.",
            diagnosticDetail: null,
            updatedFingerprint: null,
            confidence: 0,
            method: "none",
            semanticValue: null,
          });
        }
        return win.__monitorPageAgent.locate(fpJson, mode, attrName, {
          maxTotalWaitMs: waitMs,
        });
      },
      args: [
        JSON.stringify(fingerprint),
        extractMode,
        attributeName,
        maxTotalWaitMs,
      ],
    });
    return injection;
  });

  if (!attemptResult.ok) {
    return {
      ok: false,
      value: null,
      diagnostic: attemptResult.diagnostic,
      updatedFingerprint: null,
      confidence: 0,
      method: "none",
      semanticValue: null,
    };
  }

  const result = attemptResult.value?.result;
  if (!result) {
    return {
      ok: false,
      value: null,
      diagnostic: diagnostic("UNKNOWN", "the page agent returned no result"),
      updatedFingerprint: null,
      confidence: 0,
      method: "none",
      semanticValue: null,
    };
  }

  return {
    ok: result.value !== null,
    value: result.value,
    diagnostic: diagnostic(
      result.diagnosticCode as Diagnostic["code"],
      result.diagnosticDetail ?? undefined,
    ),
    updatedFingerprint: result.updatedFingerprint,
    confidence: result.confidence,
    method: result.method,
    semanticValue: result.semanticValue,
  };
}

/** Runs the page agent's interactive `pick()` on `tabId`, injecting it first if needed. */
export async function pickOnTab(tabId: number): Promise<PickResult | null> {
  const attemptResult = await runWithFrameRetry(tabId, async () => {
    await ensurePageAgentInjected(tabId);
    const [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const win = window as unknown as {
          __monitorPageAgent?: { pick: () => Promise<PickResult> };
        };
        if (!win.__monitorPageAgent) {
          return Promise.resolve<PickResult>({
            saved: false,
            monitorName: null,
            monitorId: null,
          });
        }
        return win.__monitorPageAgent.pick();
      },
    });
    return injection;
  });

  if (!attemptResult.ok) {
    return { saved: false, monitorName: null };
  }
  return attemptResult.value?.result ?? { saved: false, monitorName: null };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Chrome surfaces injection/permission failures as thrown errors with fairly consistent message text. */
function mapInjectionError(error: unknown): Diagnostic {
  const message = describeError(error);
  if (/cannot access.*chrome:\/\/|cannot access a chrome/i.test(message)) {
    return diagnostic(
      "PERMISSION_DENIED",
      "this is a restricted browser page the extension cannot script",
    );
  }
  if (/no tab with id|no tab matching|not found/i.test(message)) {
    return diagnostic("TAB_CLOSED", message);
  }
  if (/permission/i.test(message)) {
    return diagnostic("PERMISSION_DENIED", message);
  }
  return diagnostic("UNKNOWN", message);
}
