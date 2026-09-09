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

/**
 * Second-choice favicon source, tried only if `faviconUrl` above fails
 * to load (see `components/layout/Favicon.tsx`). Chrome's local
 * favicon cache only has an entry once the browser itself has loaded
 * that exact page in a tab; a public lookup by domain covers monitors
 * saved from pages the cache doesn't have (or a favicon that changed
 * since it was last cached). Not attempted first because it's a real
 * network request, whereas the local cache is instant and works
 * offline - and being a plain cross-origin `<img>` request, a page
 * with a strict `img-src` CSP can still block it, which is exactly
 * the case this falls further back to a generic icon for.
 */
export function fallbackFaviconUrl(pageUrl: string, size = 32): string | null {
  let hostname: string;
  try {
    hostname = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  const url = new URL('https://www.google.com/s2/favicons');
  url.searchParams.set('domain', hostname);
  url.searchParams.set('sz', String(size));
  return url.toString();
}
