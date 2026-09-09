import { locateOnTab, verifyTabSettled } from '../pageAgentClient';
import { ensureVisibilityPatchRegistered } from '../visibilityPatch';
import { diagnostic } from '../diagnostics';
import { resolveCheckUrl } from '../itemUrl';
import { liveCheckWindowItem } from '../../storage/items';
import { navigateAndWaitForLoad } from './liveTabNavigation';
import type { CheckStrategy, StrategyOutcome } from './types';
import type { Monitor } from '../types';

/** Total budget the page agent has to reach readiness and locate the element, including its own retries. */
const LOCATE_BUDGET_MS = 12_000;

/**
 * How many live checks are currently in flight or queued behind one
 * another (see `runQueued`). The shared window is only allowed to
 * exist while this is above zero - it's created (or re-adopted) on the
 * way up and closed the instant it drops back to zero, so a single
 * check leaves nothing behind once its value is loaded, and a batch
 * ("refresh all") still shares one window for its whole duration
 * rather than opening/closing one per monitor.
 *
 * A plain module variable (not `session:` storage) is fine here: it
 * only needs to survive for the lifetime of a single check or batch,
 * which is exactly the lifetime a variable has anyway. If the
 * background worker is evicted mid-check the in-flight check itself is
 * abandoned regardless of how this count is tracked - `SAFETY_NET`
 * below is what catches that case and closes the window anyway.
 */
let pendingLiveChecks = 0;

/**
 * Name of the one-off `chrome.alarms` safety-net alarm. Not the normal
 * way the window gets closed (that's immediate - see `endLiveCheck`
 * below) - this is a backstop for the one case immediate closing can't
 * cover: the background service worker getting evicted mid-check,
 * which wipes `pendingLiveChecks` and would otherwise leave the window
 * open with nothing left to ever close it. An alarm (not `setTimeout`)
 * survives that eviction and wakes the worker back up to fire it.
 */
export const SAFETY_NET_ALARM_NAME = 'live-check-window-safety-net';
/** Comfortably longer than the ~27s a single check can take (15s load + 12s locate budgets), so it never fires while a check is still legitimately running. */
export const SAFETY_NET_DELAY_MINUTES = 1;

export function isLiveCheckInProgress(): boolean {
  return pendingLiveChecks > 0;
}

/** Handles the safety net alarm tick without interrupting actively running checks/batches. */
export async function handleSafetyNetAlarm(): Promise<void> {
  if (pendingLiveChecks > 0) {
    // An active check or batch is still running - re-arm the alarm so it remains
    // as a backstop for worker eviction without killing the in-progress window.
    browser.alarms.create(SAFETY_NET_ALARM_NAME, { delayInMinutes: SAFETY_NET_DELAY_MINUTES });
    return;
  }
  await closeBackgroundWindow();
}

if (typeof browser !== 'undefined') {
  browser.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === SAFETY_NET_ALARM_NAME) {
      void handleSafetyNetAlarm();
    }
  });

  browser.windows?.onRemoved?.addListener((removedWindowId) => {
    void (async () => {
      const existing = await liveCheckWindowItem.getValue();
      if (existing?.windowId === removedWindowId) {
        await liveCheckWindowItem.setValue(null);
      }
    })();
    browser.alarms?.clear?.(SAFETY_NET_ALARM_NAME).catch(() => {});
  });
}

/** Closes the shared background window, if one is still on record, and forgets it. Safe to call when there's nothing to close. */
export async function closeBackgroundWindow(): Promise<void> {
  browser.alarms.clear(SAFETY_NET_ALARM_NAME).catch(() => {});
  const existing = await liveCheckWindowItem.getValue();
  if (!existing) return;
  await liveCheckWindowItem.setValue(null);
  try {
    await browser.windows.remove(existing.windowId);
  } catch {
    // Already closed (e.g. by the user) - nothing to do.
  }
}

/** Marks one more check as using the shared window - call before it's queued. */
export function beginLiveCheck(): void {
  pendingLiveChecks += 1;
}

/** Marks a check as done with the shared window - call once it settles, success or not. Closes the window the moment nothing else needs it. */
export function endLiveCheck(): void {
  pendingLiveChecks = Math.max(0, pendingLiveChecks - 1);
  if (pendingLiveChecks === 0) {
    void closeBackgroundWindow();
  }
}

/**
 * Runs `task` after every previously-queued live check has finished, so
 * at most one background check window ever exists at once - even when
 * several monitors are checked at the same moment (scheduler tick,
 * "refresh all", or a fresh save landing on a due check together).
 * Without this, "refresh all" on N monitors needing the live fallback
 * would open N background windows simultaneously, multiplying any
 * chance of a visible flash and making the reload look busy/obvious.
 * Each task is isolated: one failing doesn't block the queue.
 */
let liveCheckQueue: Promise<unknown> = Promise.resolve();
function runQueued<T>(task: () => Promise<T>): Promise<T> {
  const result = liveCheckQueue.then(task, task);
  liveCheckQueue = result.catch(() => {});
  return result;
}

/**
 * Runs the page in a minimized, unfocused background window - not a
 * tab in whatever window the user is actually looking at - then waits
 * for real navigation + script execution (unlike `fetchStrategy`), then
 * hands off to the on-demand page agent for readiness-aware fingerprint
 * recovery and extraction. Slower than a fetch, but works for any
 * client-rendered site the fetch strategy can't see into, including
 * authenticated dashboards using the user's existing session cookies
 * (it's a normal tab under the hood, so it carries them).
 *
 * A dedicated window (rather than `tabs.create` in the current window)
 * is what keeps this invisible: `active: false` only stops a same-window
 * tab from stealing focus, it doesn't stop it from sitting in the
 * user's tab strip - visible, closeable, switchable-to - for the whole
 * length of the check (up to ~40s between load and locate budgets).
 *
 * `state: 'minimized'` rather than an off-screen position: Chrome
 * rejects `windows.create` bounds that aren't at least 50% within a
 * real display ("Invalid value for bounds"), so positioning the window
 * off-screen isn't actually an option - minimized is the only state
 * Chrome allows that keeps this out of the way. The default window size
 * (not a small custom one) is intentional too: a small viewport pushes
 * many sites, YouTube included, into their mobile layout, which is a
 * different DOM than a fingerprint captured from a normal-sized window
 * expects to find. The window is muted before every navigation, so a
 * page that autoplays audio or video is never audible while it's
 * loading in the background. Live checks additionally run one at a
 * time via `runQueued`, so at most one such window ever exists
 * simultaneously - the main source of a "refresh all" looking busy with
 * several monitors flashing onto the screen at once.
 *
 * The window is shared across any checks that overlap or land back to
 * back (see `getOrCreateBackgroundTab` below) instead of being opened
 * and torn down for every single one: `windows.create({ state:
 * 'minimized' })` has a long-standing Chrome bug where the window still
 * paints one visible frame at normal size before the minimize takes
 * effect, so every fresh window is another chance at a visible flash.
 * Re-using an already-minimized window (`tabs.update` to navigate it,
 * instead of another `windows.create`) never re-triggers that bug - a
 * "refresh all" or a run of back-to-back scheduled checks only risks
 * that flash once, not once per monitor.
 *
 * But even minimized, it's a real top-level window, so it shows up in
 * the OS taskbar for as long as it exists - not just while a check is
 * actually running. So it isn't kept around: `beginLiveCheck` /
 * `endLiveCheck` track how many checks are currently using it, and the
 * moment that count hits zero the window is closed immediately - no
 * lingering in the taskbar after the value has loaded, and nothing
 * opens pre-emptively at browser or extension startup either. The only
 * thing shared across back-to-back checks is the window itself while
 * they're actually running one after another; there's no warm-up and
 * no idle window sitting around between them.
 */
export const liveTabStrategy: CheckStrategy = {
  id: 'live',
  run(monitor): Promise<StrategyOutcome> {
    beginLiveCheck();
    return runQueued(() => runLiveCheck(monitor)).finally(endLiveCheck);
  },
};

/**
 * Returns the shared background window/tab, creating it if it doesn't
 * exist yet or the previously-recorded one is gone (closed by the
 * user, or the browser restarted since - `session:` storage already
 * drops the stale record in that last case, see lib/storage/items.ts).
 *
 * The ids live in `session:` storage rather than a plain module
 * variable because the background service worker can be evicted and
 * restarted between checks; a module variable would forget about the
 * still-open window on every restart and create a new one on top of
 * it instead of reusing it - leaking windows and bringing the flash
 * bug back on every restart, not just once per browser session.
 */
async function getOrCreateBackgroundTab(): Promise<{ windowId: number; tabId: number } | null> {
  const existing = await liveCheckWindowItem.getValue();
  if (existing) {
    try {
      const tab = await browser.tabs.get(existing.tabId);
      if (tab.windowId === existing.windowId) {
        // The window is about to do real work - push the safety net
        // out so it can't fire mid-check (see SAFETY_NET_ALARM_NAME).
        browser.alarms.create(SAFETY_NET_ALARM_NAME, { delayInMinutes: SAFETY_NET_DELAY_MINUTES });
        return existing;
      }
    } catch {
      // Tab (or its window) no longer exists - fall through and open a fresh one.
    }
  }

  const win = await browser.windows.create({
    url: 'about:blank',
    type: 'popup',
    state: 'minimized',
    focused: false,
  });
  const windowId = win?.id;
  const tabId = win?.tabs?.[0]?.id;
  if (windowId === undefined || tabId === undefined) return null;

  // Re-asserting the minimized state right after creation is a
  // reported workaround for the flash described above - it doesn't
  // eliminate the underlying Chrome bug, but shortens whatever frame
  // does get painted.
  browser.windows.update(windowId, { state: 'minimized' }).catch(() => {
    // Non-fatal: the window is already minimized in the common case.
  });

  const created = { windowId, tabId };
  await liveCheckWindowItem.setValue(created);
  browser.alarms.create(SAFETY_NET_ALARM_NAME, { delayInMinutes: SAFETY_NET_DELAY_MINUTES });
  return created;
}

async function runLiveCheck(monitor: Monitor): Promise<StrategyOutcome> {
  try {
    // Resolves to the watched feed item's own permalink when the
    // fingerprint has one - navigating a virtualized home feed can't
    // guarantee the item is even mounted, let alone settled, within the
    // check's time budget, while the item's own page always renders it
    // as primary content. Falls back to the monitor's own page
    // otherwise (see `resolveCheckUrl`) - unchanged behavior for every
    // non-feed monitor.
    const checkUrl = resolveCheckUrl(monitor);

    // Registered before the tab navigates so the patch is in place at
    // document_start for this very navigation, not just future ones.
    // Origin-scoped, so this is correct whether or not `checkUrl` and
    // `monitor.url` share a path - they always share an origin.
    await ensureVisibilityPatchRegistered(checkUrl);

    const background = await getOrCreateBackgroundTab();
    if (!background) {
      return {
        value: null,
        diagnostic: diagnostic('UNKNOWN', 'could not open a background tab'),
        updatedFingerprint: null,
        confidence: 0,
        method: 'none',
        semanticValue: null,
      };
    }
    const { tabId } = background;

    const loaded = await navigateAndWaitForLoad(tabId, checkUrl);
    if (!loaded.ok) {
      return {
        value: null,
        diagnostic: loaded.diagnostic,
        updatedFingerprint: null,
        confidence: 0,
        method: 'none',
        semanticValue: null,
      };
    }

    // `navigateAndWaitForLoad` resolving just means the tab reported
    // "complete" *at that instant* — a fast client-side redirect (or a
    // trailing hop in a server redirect chain) can replace the
    // document again immediately after, which is exactly what turns
    // the next `scripting.executeScript` call into a "Frame with ID 0
    // was removed" error instead of a clean injection. One bounded
    // settle check here catches the common case before injection is
    // even attempted; `locateOnTab`'s own retry is the backstop for
    // whatever slips past it (a bounce that starts a beat later).
    const settled = await verifyTabSettled(tabId);
    if (!settled.ok) {
      return {
        value: null,
        diagnostic: settled.diagnostic,
        updatedFingerprint: null,
        confidence: 0,
        method: 'none',
        semanticValue: null,
      };
    }

    const outcome = await locateOnTab(
      tabId,
      monitor.fingerprint,
      monitor.extractMode,
      monitor.attributeName,
      LOCATE_BUDGET_MS,
    );

    return {
      value: outcome.value,
      diagnostic: outcome.diagnostic,
      updatedFingerprint: outcome.updatedFingerprint,
      confidence: outcome.confidence,
      method: outcome.method,
      semanticValue: outcome.semanticValue,
    };
  } catch (error) {
    return {
      value: null,
      diagnostic: diagnostic('UNKNOWN', error instanceof Error ? error.message : 'live check failed'),
      updatedFingerprint: null,
      confidence: 0,
      method: 'none',
      semanticValue: null,
    };
  }
}
