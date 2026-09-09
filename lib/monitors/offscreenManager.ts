/// <reference types="chrome" />

let inFlightCreation: Promise<void> | null = null;

/**
 * Ensures the offscreen document (entrypoints/offscreen) exists so
 * `parseHtml` messages have somewhere to land. Chrome allows only one
 * offscreen document per extension at a time, so this is idempotent and
 * safe against concurrent caller races.
 */
export async function ensureOffscreenDocument(): Promise<void> {
  if (inFlightCreation) {
    return inFlightCreation;
  }

  inFlightCreation = (async () => {
    try {
      const hasDocument = await chrome.offscreen.hasDocument();
      if (hasDocument) return;

      try {
        await chrome.offscreen.createDocument({
          url: browser.runtime.getURL('/offscreen.html'),
          reasons: [chrome.offscreen.Reason.DOM_PARSER],
          justification:
            'Parse fetched page HTML to extract a monitored value. Service workers have no DOMParser.',
        });
      } catch (error: unknown) {
        // Safely handle the race where another caller or process created
        // the offscreen document between hasDocument() and createDocument().
        const existsNow = await chrome.offscreen.hasDocument().catch(() => false);
        if (existsNow) return;
        throw error;
      }
    } finally {
      inFlightCreation = null;
    }
  })();

  return inFlightCreation;
}
