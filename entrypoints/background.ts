import { onMessage, sendMessage } from '@/lib/messaging';
import type { AppInfo } from '@/lib/messaging';
import { getSettings } from '@/lib/storage';
import { isInjectablePage } from '@/lib/browserPages';
import { hasOriginPermission, requestOriginPermission } from '@/lib/permissions';
import {
  ensureScheduler,
  isSchedulerAlarm,
  runDueMonitors,
  checkAllMonitorsNow,
} from '@/lib/monitors/scheduler';
import { checkMonitor, checkMonitorById } from '@/lib/monitors/checker';
import { getMonitor } from '@/lib/monitors/store';
import { runPickerFlow } from '@/lib/monitors/pickerFlow';

const PANEL_SCRIPT_FILE = '/content-scripts/panel.js';

export default defineBackground(() => {
  registerMessageHandlers();
  registerScheduler();
  registerActionClick();
  registerNotificationClick();
  void initializeSettingsOnInstall();
  // No warm-up of the live-check background window here on purpose:
  // it should only exist while a live check actually needs it (see
  // liveTabStrategy.ts), not from the moment the browser or extension
  // starts - so reloading the extension never opens a window on its own.
  if (import.meta.env.COMMAND === 'serve') {
    void reinitDevTabs();
  }
});

/**
 * All message handlers live here so there's a single place to see every
 * message the background worker responds to. As real features
 * (monitor scheduling, alarms, scraping) are added, split their
 * handlers into dedicated modules under `entrypoints/background/` and
 * import + register them here.
 */
function registerMessageHandlers(): void {
  onMessage('ping', () => 'pong');

  onMessage('getAppInfo', async (): Promise<AppInfo> => {
    const manifest = browser.runtime.getManifest();
    return {
      version: manifest.version,
      name: manifest.name ?? 'Monitor',
      installType: await getInstallType(),
    };
  });

  onMessage('checkMonitorNow', async ({ data: monitorId }) => {
    try {
      await checkMonitorById(monitorId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'The check failed.' };
    }
  });

  onMessage('checkAllMonitorsNow', async () => {
    await checkAllMonitorsNow();
    return { ok: true, error: null };
  });

  onMessage('startElementPicker', async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isInjectablePage(tab.url)) {
      return { started: false, error: 'Monitor only supports http(s) pages.' };
    }
    // Deliberately not awaited: this handler must return before the user
    // has clicked anything, so the panel that sent this message is free
    // to be dismissed without breaking the pick. See pickerFlow.ts for
    // why the wait has to happen here instead.
    void runPickerFlow(tab.id);
    return { started: true, error: null };
  });

  onMessage('openOptionsPage', async () => {
    await browser.runtime.openOptionsPage();
    return { ok: true };
  });

  onMessage('checkOriginPermissions', async ({ data: urls }) => {
    const entries = await Promise.all(
      urls.map(async (url) => {
        const result = await hasOriginPermission(url);
        return [url, result.ok ? result.value : false] as const;
      }),
    );
    return Object.fromEntries(entries);
  });
}

/**
 * A single repeating `chrome.alarms` tick drives every monitor, rather
 * than one alarm per monitor - simpler to reason about, avoids Chrome's
 * per-alarm minimums multiplying with the monitor count, and each tick
 * only actually checks whichever monitors are due.
 */
function registerScheduler(): void {
  void ensureScheduler();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (!isSchedulerAlarm(alarm.name)) return;
    void runDueMonitors();
  });
}

function registerNotificationClick(): void {
  browser.notifications?.onClicked?.addListener(async (notificationId) => {
    const prefix = 'monitor-changed-';
    if (!notificationId.startsWith(prefix)) return;
    const rest = notificationId.slice(prefix.length);
    const lastDash = rest.lastIndexOf('-');
    const monitorId = lastDash !== -1 ? rest.slice(0, lastDash) : rest;
    if (!monitorId) return;

    try {
      const result = await getMonitor(monitorId);
      if (!result.ok || !result.value?.url) return;

      const targetUrl = result.value.url;
      try {
        const tabs = await browser.tabs.query({ url: targetUrl });
        if (tabs.length > 0 && tabs[0]?.id) {
          if (tabs[0].windowId) {
            await browser.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
          }
          await browser.tabs.update(tabs[0].id, { active: true });
          return;
        }
      } catch {
        // Fall back to opening a new tab
      }
      await browser.tabs.create({ url: targetUrl });
    } catch (error) {
      console.error('[background] Failed to handle notification click:', error);
    }
  });
}

/**
 * There's no popup or side panel - clicking the toolbar icon injects
 * (or, if it's already there, toggles) the panel directly on the page
 * itself. See entrypoints/panel.content.tsx for the injected UI and
 * why this uses `scripting.executeScript` rather than a declarative
 * content script: it keeps the panel opt-in per tab via `activeTab`
 * instead of requiring a broad host permission up front.
 *
 * This click is also the one and only place this extension can ask for
 * a site's persistent host permission: `chrome.permissions.request()`
 * only resolves inside a genuine user gesture, and a click handled
 * inside a content script (the panel, the picker) doesn't count - only
 * the toolbar icon click itself does. Requesting it here, before the
 * picker ever runs, means "hover a value, click, done" never hits a
 * permission wall mid-flow: by the time the user can click "Add", this
 * tab's site already has (or was just denied) access. If the current
 * origin is already granted, `requestOriginPermission` resolves
 * immediately with no visible prompt, so this is a no-op on every
 * repeat visit to a site already being monitored.
 */
function registerActionClick(): void {
  browser.action.onClicked.addListener((tab) => {
    if (!tab.id) return;

    if (!isInjectablePage(tab.url)) {
      notifyUnsupportedPage();
      return;
    }

    const tabId = tab.id;
    const tabUrl = tab.url;

    void requestOriginPermission(tabUrl).then((result) => {
      // A declined native permission prompt is an intentional choice,
      // not an error state that needs an in-page explanation.
      if (!result.ok || !result.value) {
        if (!result.ok) console.error('[background] Failed to request site access:', result.error);
        return;
      }
      void toggleOrInjectPanel(tabId);
    });
  });
}

/**
 * Only ever injects panel.content.tsx once per tab. `scripting.
 * executeScript` re-runs the whole content script file from scratch on
 * every call, and WXT automatically tears down an already-running
 * instance of that same script the moment a new one starts (see the
 * comment atop panel.content.tsx) - so injecting again on a tab that
 * already has a panel doesn't "toggle" it, it silently kills it.
 *
 * Messaging first sidesteps that entirely: if a panel is already
 * listening on this tab, it just gets toggled in place. Only when
 * nothing responds - a fresh tab, or one that navigated and lost its
 * content scripts - does this fall back to actually injecting the
 * script file.
 */
async function toggleOrInjectPanel(tabId: number): Promise<void> {
  try {
    const response = await sendMessage('togglePanel', undefined, tabId);
    if (response?.handled) return;
  } catch {
    // No listener on this tab yet - fall through to inject below.
  }

  browser.scripting
    .executeScript({ target: { tabId }, files: [PANEL_SCRIPT_FILE] })
    .catch((error: unknown) => console.error('[background] Failed to open panel:', error));
}

/**
 * Chrome's internal pages (chrome://, the Web Store, etc.) reject
 * script injection outright - there's no way to show the panel there,
 * so the best the extension can do is say so instead of silently doing
 * nothing or logging an opaque rejection only visible in devtools.
 */
function notifyUnsupportedPage(): void {
  browser.notifications
    .create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: 'Monitor',
      message: "Monitor can't run on this page. Try it on a regular website instead.",
    })
    .catch((error: unknown) => console.error('[background] Failed to show notification:', error));
}

async function getInstallType(): Promise<AppInfo['installType']> {
  try {
    const info = await browser.management.getSelf();
    return info.installType;
  } catch {
    // `management` permission isn't requested by default; fall back
    // gracefully rather than requiring it just for diagnostics.
    return 'unknown';
  }
}

/** Ensures settings exist in storage (with defaults) the first time the extension runs. */
async function initializeSettingsOnInstall(): Promise<void> {
  const result = await getSettings();
  if (!result.ok) {
    console.error('[background] Failed to read settings on init:', result.error);
  }
}

async function reinitDevTabs(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !isInjectablePage(tab.url)) continue;
      try {
        const hasPerm = await hasOriginPermission(tab.url);
        if (!hasPerm.ok || !hasPerm.value) continue;

        const results = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.documentElement.dataset.monitorPanelOpen === 'true',
        });
        if (results[0]?.result) {
          await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: [PANEL_SCRIPT_FILE],
          });
        }
      } catch {
        // Tab may not have host permissions or is inaccessible; ignore.
      }
    }
  } catch {
    // Ignore dev reinit errors.
  }
}

