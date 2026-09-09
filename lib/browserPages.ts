/**
 * Whether `url` is a page the extension can actually inject a content
 * script into. Chrome (and Chromium browsers generally) block script
 * injection on internal pages - `chrome://`, `chrome-extension://`,
 * `about:`, the Web Store - regardless of what the manifest requests,
 * so this has to be checked before calling `scripting.executeScript`
 * rather than relying on that call's rejection alone: the tab can also
 * simply have no URL yet (e.g. a tab still loading).
 */
export function isInjectablePage(url: string | undefined): url is string {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false;
  if (parsed.hostname === 'chromewebstore.google.com') return false;

  return true;
}
