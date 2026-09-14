let fontLoadPromise: Promise<void> | null = null;

/**
 * Loads and registers the bundled official Inter WOFF2 variable font into
 * `document.fonts` using the `FontFace(ArrayBuffer)` API.
 *
 * Why ArrayBuffer instead of @font-face CSS url():
 * The content script runs in an ISOLATED world, so its fetch() calls to
 * `browser.runtime.getURL(...)` run with extension privileges and are NOT
 * subject to the host page's Content Security Policy.
 *
 * Passing the resulting ArrayBuffer directly into `new FontFace(...)` decodes
 * the font purely in-memory without initiating any page-level network requests,
 * guaranteeing 100% immunity against strict host-site CSP directives
 * (e.g. `font-src 'self'` or `font-src https:` on ChatGPT, GitHub, banking sites)
 * while keeping `panel.js` free from ~500 KB base64 data-URI bloat.
 */
export function ensureInterLoaded(): Promise<void> {
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    // Return early if an Inter font is already present and loaded
    for (const font of document.fonts) {
      if (font.family === 'Inter' && font.status === 'loaded') {
        return;
      }
    }

    try {
      const fontUrl = browser.runtime.getURL('/fonts/InterVariable.woff2');
      const response = await fetch(fontUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch bundled font (${response.status} ${response.statusText})`);
      }
      const fontBuffer = await response.arrayBuffer();
      const font = new FontFace('Inter', fontBuffer, {
        style: 'normal',
        weight: '100 900',
        display: 'swap',
      });
      await font.load();
      document.fonts.add(font);
    } catch (err) {
      console.warn('Failed to load bundled Inter font:', err);
    }
  })();

  return fontLoadPromise;
}
