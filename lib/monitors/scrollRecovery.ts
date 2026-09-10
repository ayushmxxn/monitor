/**
 * Scroll-assisted recovery for feed/list items that genuinely exist on
 * the current page but simply haven't been rendered yet.
 *
 * A virtualized or infinite-scroll list (a home timeline, a comment
 * thread, an activity feed) only mounts what's near the viewport - a
 * post picked from partway down a feed can be completely absent from
 * the DOM on a fresh page load even though scrolling to it would
 * reveal it exactly where it always was. `locateElement`'s recovery
 * scan (see `fingerprint.ts`) only ever sees whatever's *currently*
 * mounted; it has no way on its own to tell "this item is gone" apart
 * from "this item hasn't loaded yet".
 *
 * This is deliberately the *last* resort, not a replacement for
 * `resolveCheckUrl`'s permalink redirect (see `itemUrl.ts`). The
 * overwhelming majority of genuine feed items (a tweet, a Reddit post,
 * a comment) carry their own permalink, and a check resolves straight
 * to that item's own page - which renders it as primary content
 * regardless of where it sat in the feed - long before this module
 * ever runs. This exists for the residual case: an item whose only
 * identity signal is a weaker one `resolveCheckUrl` deliberately
 * doesn't trust enough to redirect an entire check to (a table row's
 * own detail link, a bare timestamp), or one with no navigable
 * identity at all. The only way left to find it is to make it render -
 * the same way a person would manually scroll a timeline looking for
 * a post they remember seeing.
 *
 * Callers must only invoke this for a fingerprint that actually
 * carries an `itemAnchor` (see `ElementFingerprint` in
 * `fingerprint.ts`) - scrolling a page that isn't a virtualized list
 * can't productively change what a locate attempt finds, and would
 * just burn the check's time budget for every ordinary, non-feed
 * monitor. This module has no opinion on that gate itself; it's pure
 * mechanism, so it stays trivially unit-testable without a real DOM.
 */

export interface ScrollHostState {
  scrollY: number;
  scrollHeight: number;
}

export interface ScrollHost {
  read(): ScrollHostState;
  /** Scrolls further down by roughly one viewport. */
  scrollDown(): void;
}

export interface ScrollSearchOptions {
  /** Upper bound on scroll rounds, independent of the time deadline. */
  maxSteps?: number;
  /** Pause after each scroll before re-checking, giving lazy content a chance to mount. */
  stepDelayMs?: number;
  /** Absolute time (same clock as `now`) after which no further round starts. */
  deadline?: number;
  now?: () => number;
}

export interface ScrollSearchResult<T> {
  result: T | null;
  steps: number;
  /** `true` when the page's scrollable height stopped growing across consecutive rounds - nothing further will ever load, so continuing would only waste the remaining budget. */
  reachedBottom: boolean;
}

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_STEP_DELAY_MS = 450;
/** Two consecutive rounds with no growth in scroll height means the feed has genuinely stopped loading more content, not just paused between batches. */
const STABLE_ROUNDS_TO_STOP = 2;

/**
 * Repeatedly scrolls `host` downward and calls `tryLocate` after each
 * step, stopping as soon as it returns a non-null result, the page
 * stops growing (bottom reached - nothing left to lazily mount),
 * `maxSteps` is exhausted, or `deadline` passes.
 *
 * Framework-independent (no `window`/content-script globals), the same
 * way `resolveSettledValue` in `locate.ts` is - `host`, `tryLocate`,
 * and `wait` are the only things that differ between a real page and a
 * simulated one in tests.
 */
export async function searchByScrolling<T>(
  host: ScrollHost,
  tryLocate: () => T | null,
  wait: (ms: number) => Promise<void>,
  options: ScrollSearchOptions = {},
): Promise<ScrollSearchResult<T>> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? Infinity;

  const initial = host.read();
  let lastHeight = initial.scrollHeight;
  let lastY = initial.scrollY;
  let stableRounds = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (now() >= deadline) {
      return { result: null, steps: step, reachedBottom: false };
    }

    host.scrollDown();
    await wait(stepDelayMs);

    const found = tryLocate();
    if (found) {
      return { result: found, steps: step + 1, reachedBottom: false };
    }

    const state = host.read();
    // Height alone can't declare the bottom: virtualized/windowed lists
    // preallocate their full height and swap rows without growing it.
    // Only count a round as stable when the scroll position also stopped
    // advancing - i.e. the page genuinely has nowhere left to go.
    if (state.scrollHeight <= lastHeight && state.scrollY <= lastY + 2) {
      stableRounds += 1;
      if (stableRounds >= STABLE_ROUNDS_TO_STOP) {
        return { result: null, steps: step + 1, reachedBottom: true };
      }
    } else {
      stableRounds = 0;
    }
    lastHeight = state.scrollHeight;
    lastY = state.scrollY;
  }
  return { result: null, steps: maxSteps, reachedBottom: false };
}
