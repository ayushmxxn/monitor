/**
 * Builds a URL for a page's favicon via Chrome's `_favicon` special
 * page (requires the `favicon` permission, declared in wxt.config.ts).
 * This is the supported MV3 replacement for the old `chrome://favicon`
 * URL scheme - it works for any page the browser has cached a favicon
 * for, not just ones the extension has host permission on, and never
 * makes a network request of its own.
 *
 * See https://developer.chrome.com/docs/extensions/reference/api/tabs#favicon-urls
 */
export function faviconUrl(pageUrl: string, size = 32): string {
  // `browser.runtime.getURL` is narrowed by wxt to the extension's own
  // HTML pages, so the special `_favicon/` path is built manually from
  // the extension's origin instead.
  const url = new URL(`chrome-extension://${browser.runtime.id}/_favicon/`);
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}
