/**
 * The live-tab strategy deliberately opens its check tab with
 * `active: false` so a scheduled check never steals the user's focus.
 * Chrome's cost is that a non-active tab is treated as "hidden" by the
 * Page Visibility API and gets its `requestAnimationFrame` callbacks
 * throttled — often down to roughly once a second, sometimes not fired
 * at all — since nothing is being painted for the user to see.
 *
 * That's invisible for a plain server-rendered value, but plenty of
 * dashboards animate their numbers in (CountUp-style effects), gate
 * chart/data rendering behind a `document.hidden` check, or otherwise
 * do real work inside a `requestAnimationFrame` loop. In a background
 * tab that work can stall indefinitely on its pre-animation placeholder
 * — a counter showing "0" while it waits for frames that never come is
 * exactly the failure mode this patches around.
 *
 * This runs in the page's own MAIN world (not the isolated content
 * script world) at `document_start`, before the page's own scripts get
 * a chance to capture a reference to the native `requestAnimationFrame`
 * or read `document.hidden`, so libraries that behave differently based
 * on either one see a normally-visible page throughout the check.
 *
 * This intentionally does NOT touch `fetch`/`XMLHttpRequest`. An earlier
 * version patched `window.fetch` to maintain a live in-flight request
 * count for `readiness.ts`'s network-idle check. Even made a fully
 * transparent passthrough (same thisArg/args/promise identity as
 * native, synchronous throws preserved — see git history), reassigning
 * `window.fetch` at all was still observable by the page: on Reddit it
 * surfaced as a "preload credentials mode does not match" console
 * warning with our wrapper in the stack trace, because the browser's
 * preload-cache matching cares whether the call reached its own native
 * `fetch`, not just whether our wrapper behaved identically. There's no
 * way to intercept a network API from page-script level without the
 * page being able to observe *that* interception is happening, however
 * behaviorally transparent the wrapper is. `readiness.ts` already
 * degrades gracefully without this signal (a completion-based
 * resource-timing heuristic instead of a hard in-flight count), so the
 * fix here is architectural: stop reaching into the page's networking
 * at all rather than trying to make that reach invisible. Monitor
 * watches the DOM; it doesn't intercept requests.
 *
 * Registered dynamically per-origin via `chrome.scripting.registerContentScripts`
 * (see `lib/monitors/visibilityPatch.ts`) rather than declared with
 * `matches` here, so it only ever runs on an origin the user has
 * already granted host permission for — never broadly.
 */
export default defineContentScript({
  registration: 'runtime',
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    try {
      let nextHandle = 1;
      const pending = new Map<number, ReturnType<typeof setTimeout>>();

      window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
        const handle = nextHandle++;
        const timeout = setTimeout(() => {
          pending.delete(handle);
          callback(performance.now());
        }, 16);
        pending.set(handle, timeout);
        return handle;
      }) as typeof window.requestAnimationFrame;

      window.cancelAnimationFrame = ((handle: number): void => {
        const timeout = pending.get(handle);
        if (timeout !== undefined) {
          clearTimeout(timeout);
          pending.delete(handle);
        }
      }) as typeof window.cancelAnimationFrame;

      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible' as DocumentVisibilityState,
        configurable: true,
      });
      document.hasFocus = () => true;
    } catch {
      // Best-effort only. A page that's locked down its own globals
      // (rare — some strict CSP/lockdown setups freeze these) just
      // doesn't get the patch; extraction still runs, it may just be
      // more likely to need its stability-confirmation retry.
    }
  },
});
