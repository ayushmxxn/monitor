/**
 * Page readiness detection.
 *
 * Replaces the old flat "wait N seconds after load" heuristic with
 * several independent signals combined into one wait:
 *
 *  1. `document.readyState === 'complete'` — the baseline.
 *  2. DOM mutation quiet period — a `MutationObserver` watches for a
 *     window with no structural mutations, which is a much better proxy
 *     for "an SPA finished its post-load render" than a fixed delay.
 *  3. Network-idle heuristic — `PerformanceObserver`/resource timing
 *     entries detect a quiet window with no *newly completed*
 *     fetch/XHR/script/image loads. This is completion-based and
 *     therefore has a known blind spot: a page whose only outstanding
 *     work is one slow `fetch()` looks quiet for the entire time that
 *     fetch is pending, since nothing has *finished* loading recently.
 *     An earlier version closed that gap with a live in-flight request
 *     count fed by a `fetch`/`XMLHttpRequest` patch injected into the
 *     page. That patch was removed (see
 *     `entrypoints/visibilityPatch.content.ts`): even made fully
 *     behaviorally transparent, reassigning `window.fetch` was still
 *     observable by the page and broke Reddit's preload/credentials
 *     matching. Monitor watches the DOM rather than intercepting the
 *     page's networking, so this signal is purely completion-based now
 *     and the blind spot above is an accepted trade-off, mitigated by
 *     the DOM-mutation-quiet signal below (most late-arriving fetch
 *     responses update the DOM when they land, which resets that
 *     timer) and by the target-level confirmation re-read in
 *     `locate.ts`.
 *  4. Loading-indicator awareness — common skeleton/spinner/progressbar
 *     patterns are watched for and waited out if present.
 *
 * These signals are combined leniently (any *sustained* quiet window
 * counts), not with strict AND, because some sites never fully go
 * quiet (live tickers, chat widgets, ads) — the goal is "stable enough
 * to extract from", not "completely idle".
 */

export interface ReadinessResult {
  ready: boolean;
  waitedMs: number;
  signals: {
    documentComplete: boolean;
    domQuietMs: number;
    networkQuietMs: number;
    loadingIndicatorsCleared: boolean;
  };
}

export interface ReadinessOptions {
  /** Hard ceiling on total time spent waiting. */
  maxWaitMs?: number;
  /** How long the DOM must go without mutations to be considered "settled". */
  domQuietWindowMs?: number;
  /** How long resource loading must go without new entries to be considered "settled". */
  networkQuietWindowMs?: number;
  /** Minimum time to wait regardless of signals, to give async mounts a chance to start. */
  minWaitMs?: number;
}

const LOADING_INDICATOR_SELECTOR = [
  '[aria-busy="true"]',
  '[class*="skeleton" i]',
  '[class*="spinner" i]',
  '[class*="shimmer" i]',
  '[class*="placeholder" i]',
  // Tailwind's `animate-pulse` (and hand-rolled equivalents named just
  // "pulse") is one of the most common skeleton patterns on modern
  // dashboards - Vercel, Notion, Shopify's Polaris, and plenty of
  // bespoke React/SPA dashboards alike use it for loading placeholders
  // instead of a dedicated "skeleton"-named class.
  '[class*="pulse" i]',
  '[class*="loading" i]',
  '[role="progressbar"]',
  '[data-loading="true"]',
].join(', ');

function hasLoadingIndicators(root: Document | Element): boolean {
  try {
    const nodes = root.querySelectorAll(LOADING_INDICATOR_SELECTOR);
    for (const node of Array.from(nodes)) {
      const rect = (node as HTMLElement).getBoundingClientRect?.();
      if (!rect) return true;
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Waits until the page looks settled or `maxWaitMs` elapses, whichever
 * comes first. Designed to be cheap to call repeatedly (e.g. once per
 * retry attempt) — a page that's already stable resolves almost
 * immediately since all quiet windows start already-satisfied.
 */
export function waitForPageReady(
  win: Window,
  options: ReadinessOptions = {},
): Promise<ReadinessResult> {
  const maxWaitMs = options.maxWaitMs ?? 12_000;
  const domQuietWindowMs = options.domQuietWindowMs ?? 500;
  const networkQuietWindowMs = options.networkQuietWindowMs ?? 700;
  const minWaitMs = options.minWaitMs ?? 150;

  const doc = win.document;
  const start = performance.now();

  return new Promise((resolve) => {
    let lastMutationAt = performance.now();
    let lastResourceAt = performance.now();
    let settled = false;

    const mutationObserver = new MutationObserver(() => {
      lastMutationAt = performance.now();
    });
    try {
      mutationObserver.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      // documentElement not available yet in exotic cases — fall through, timers still work.
    }

    let perfObserver: PerformanceObserver | null = null;
    try {
      perfObserver = new PerformanceObserver(() => {
        lastResourceAt = performance.now();
      });
      perfObserver.observe({ entryTypes: ['resource'] });
    } catch {
      // PerformanceObserver for 'resource' unsupported — network-quiet signal degrades gracefully.
    }

    const interval = win.setInterval(check, 100);

    function cleanup(): void {
      win.clearInterval(interval);
      mutationObserver.disconnect();
      perfObserver?.disconnect();
    }

    function check(): void {
      if (settled) return;
      const now = performance.now();
      const elapsed = now - start;
      const domQuietMs = now - lastMutationAt;
      const networkQuietMs = now - lastResourceAt;
      const documentComplete = doc.readyState === 'complete';
      const indicatorsPresent = hasLoadingIndicators(doc);

      const domSettled = domQuietMs >= domQuietWindowMs;
      const networkSettled = networkQuietMs >= networkQuietWindowMs;
      const timeUp = elapsed >= maxWaitMs;

      const sustainedDomQuiet = domQuietMs >= Math.max(domQuietWindowMs, 500) && elapsed >= Math.max(minWaitMs, 600);
      const ready =
        elapsed >= minWaitMs &&
        documentComplete &&
        domSettled &&
        (networkSettled || sustainedDomQuiet) &&
        !indicatorsPresent;

      if (ready || timeUp) {
        settled = true;
        cleanup();
        resolve({
          ready,
          waitedMs: Math.round(elapsed),
          signals: {
            documentComplete,
            domQuietMs: Math.round(domQuietMs),
            networkQuietMs: Math.round(networkQuietMs),
            loadingIndicatorsCleared: !indicatorsPresent,
          },
        });
      }
    }

    check();
  });
}

/**
 * Region-scoped counterpart to `waitForPageReady`. Waits for a
 * *specific* container element's own subtree to go quiet, instead of
 * the whole document - so a page that never goes fully idle (a live
 * ticker, a chat widget, a recommendation rail lazily loading
 * thumbnails - none of it inside `region`) doesn't hold recovery
 * hostage on a signal that may never fire, once the target's own area
 * has been found and can be watched directly. See
 * `fingerprint.ts`'s `findLikelyContainer` for how `region` is chosen.
 *
 * Deliberately lighter-weight than the page-wide check: no network-idle
 * signal (that's a whole-document concept - `PerformanceObserver` has
 * no per-subtree resource attribution), and shorter default windows,
 * since a small, specific region has far less incidental noise to wait
 * out than the page as a whole. `documentComplete` is still reported
 * (cheap, page-wide, and a genuinely useful baseline signal) but never
 * gates readiness here - a region can legitimately settle before
 * unrelated parts of a still-loading page finish.
 */
export function waitForRegionReady(
  win: Window,
  region: Element,
  options: ReadinessOptions = {},
): Promise<ReadinessResult> {
  const maxWaitMs = options.maxWaitMs ?? 500;
  const domQuietWindowMs = options.domQuietWindowMs ?? 200;
  const minWaitMs = options.minWaitMs ?? 50;

  const doc = win.document;
  const start = performance.now();

  return new Promise((resolve) => {
    let lastMutationAt = performance.now();
    let settled = false;
    let observing = false;

    const mutationObserver = new MutationObserver(() => {
      lastMutationAt = performance.now();
    });
    try {
      mutationObserver.observe(region, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      observing = true;
    } catch {
      // Region already detached, or otherwise unobservable - fall
      // through to timer-only pacing; `check` below treats an
      // unobserved region as vacuously dom-quiet rather than stalling
      // forever waiting for mutation events that will never arrive.
    }

    const interval = win.setInterval(check, 50);

    function cleanup(): void {
      win.clearInterval(interval);
      mutationObserver.disconnect();
    }

    function check(): void {
      if (settled) return;
      const now = performance.now();
      const elapsed = now - start;
      const domQuietMs = now - lastMutationAt;
      const stillConnected = region.isConnected;
      const domSettled = !observing || domQuietMs >= domQuietWindowMs;
      const indicatorsPresent = stillConnected && hasLoadingIndicators(region);
      const timeUp = elapsed >= maxWaitMs;

      const ready = elapsed >= minWaitMs && stillConnected && domSettled && !indicatorsPresent;

      if (ready || timeUp) {
        settled = true;
        cleanup();
        resolve({
          ready,
          waitedMs: Math.round(elapsed),
          signals: {
            documentComplete: doc.readyState === 'complete',
            domQuietMs: Math.round(domQuietMs),
            networkQuietMs: Math.round(domQuietMs),
            loadingIndicatorsCleared: !indicatorsPresent,
          },
        });
      }
    }

    check();
  });
}

/**
 * Runs `attempt` with exponential backoff until it reports success (via
 * the returned `done` flag) or the retry budget is exhausted. Each
 * delay is capped and jittered slightly to avoid synchronized retry
 * storms across many monitors on the same alarm tick.
 *
 * `delaysMs` normally is a fixed schedule, but it can also be a
 * function of the previous attempt's result — used by
 * `resolveSettledValue` to switch to a slower, challenge-appropriate
 * schedule specifically while a bot-verification/CAPTCHA interstitial
 * is showing (see `CHALLENGE_RETRY_DELAYS_MS` in `locate.ts`), without
 * changing the pacing of every other retry reason.
 */
export async function withExponentialBackoff<T>(
  attempt: (attemptNumber: number, previous: T | undefined) => Promise<{ done: boolean; value: T }>,
  options?: {
    delaysMs?: number[] | ((attemptNumber: number, previous: T | undefined) => number);
    maxAttempts?: number | ((attemptNumber: number, previous: T | undefined) => boolean);
  },
): Promise<T> {
  const delaysMs = options?.delaysMs ?? [0, 400, 900, 1800, 3500];
  const delayFor = (i: number, previous: T | undefined): number =>
    typeof delaysMs === 'function' ? delaysMs(i, previous) : delaysMs[Math.min(i, delaysMs.length - 1)] ?? 0;

  const maxAttemptsOption = options?.maxAttempts;
  const staticMaxAttempts = typeof maxAttemptsOption === 'number'
    ? maxAttemptsOption
    : typeof delaysMs !== 'function'
      ? delaysMs.length
      : undefined;
  const shouldContinue = (i: number, previous: T | undefined): boolean => {
    if (typeof maxAttemptsOption === 'function') return maxAttemptsOption(i, previous);
    if (staticMaxAttempts !== undefined) return i < staticMaxAttempts;
    // A function-based schedule with no explicit cap still needs a hard
    // ceiling so a misbehaving predicate can never spin forever - see
    // callers for the actual bounded reasoning (time-budget checks
    // inside `attempt` are the real limiter; this is just a backstop).
    return i < 20;
  };

  let last: T | undefined;
  for (let i = 0; shouldContinue(i, last); i++) {
    const delay = delayFor(i, last);
    if (delay > 0) {
      const jitter = Math.floor(Math.random() * Math.min(150, delay * 0.25));
      await sleep(delay + jitter);
    }
    const result = await attempt(i, last);
    last = result.value;
    if (result.done) return result.value;
  }
  return last!;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
