import { diagnostic } from '../diagnostics';

/**
 * How long to wait for the background tab to finish its initial
 * navigation. Generous enough for a slow connection, tight enough that
 * a truly stuck page fails fast instead of holding up the check.
 */
export const TAB_LOAD_TIMEOUT_MS = 15_000;

type OnUpdatedListener = Parameters<typeof browser.tabs.onUpdated.addListener>[0];
type OnRemovedListener = Parameters<typeof browser.tabs.onRemoved.addListener>[0];

/**
 * Navigates `tabId` to `url` and waits for that navigation to finish
 * loading. Registers the `tabs.onUpdated`/`tabs.onRemoved` listeners
 * *before* issuing the navigation, not after — starting the navigation
 * first (as this used to) leaves a window where the tab can reach
 * `status: 'complete'` before anything is listening for it, most
 * plausibly for a background window still on `about:blank` (its
 * initial, synchronous-feeling state) or a navigation the browser
 * resolves fast enough to beat listener registration on a slow event
 * loop tick. Either way the check would then hang until
 * `TAB_LOAD_TIMEOUT_MS` for an event that already happened.
 *
 * Muted on every navigation (not just once) - no audible blip even for
 * a tab that starts playing audio/video immediately, and nothing a
 * previous check's page did to its own audio carries over to whatever
 * gets checked next in this shared window.
 *
 * Deliberately kept in its own module, importing only `diagnostics.ts`
 * (which has no browser-platform dependencies of its own) rather than
 * living inside `liveTabStrategy.ts` alongside its storage/visibility-patch
 * imports - so this specific navigation-sequencing logic can be
 * exercised directly in tests without also having to stand up mocks
 * for everything else that module touches.
 */
export function navigateAndWaitForLoad(
  tabId: number,
  url: string,
): Promise<{ ok: true } | { ok: false; diagnostic: ReturnType<typeof diagnostic> }> {
  return new Promise((resolve) => {
    let settled = false;

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        diagnostic: diagnostic('PAGE_LOAD_TIMEOUT', `no load event within ${TAB_LOAD_TIMEOUT_MS / 1000}s`),
      });
    }, TAB_LOAD_TIMEOUT_MS);

    const onUpdated: OnUpdatedListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish({ ok: true });
      }
    };

    const onRemoved: OnRemovedListener = (removedTabId) => {
      if (removedTabId === tabId) {
        finish({ ok: false, diagnostic: diagnostic('TAB_CLOSED', 'closed before it finished loading') });
      }
    };

    function finish(result: { ok: true } | { ok: false; diagnostic: ReturnType<typeof diagnostic> }): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function cleanup(): void {
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }

    // Listeners are in place before the navigation is ever issued.
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);

    browser.tabs
      .update(tabId, { muted: true, url })
      .then((tab) => {
        // `tabs.update` can itself resolve with a tab that's already
        // `complete` - most commonly a no-op navigation to the URL the
        // tab is already showing, which the browser doesn't treat as a
        // fresh load and so never fires a further `onUpdated`
        // "complete" event for. Without this, that case would hang
        // until the timeout despite the page already being ready.
        if (tab?.status === 'complete') {
          finish({ ok: true });
        }
      })
      .catch(() => {
        // Non-fatal: `onRemoved` above already covers the tab having
        // closed out from under the navigation, and anything else is
        // still covered by the timeout - worst case the tab is briefly
        // unmuted, extraction still proceeds.
      });
  });
}
