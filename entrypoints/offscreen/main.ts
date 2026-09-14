import { onMessage } from '@/lib/messaging';
import type { ParseHtmlResult } from '@/lib/messaging';
import { locateAndExtractWithReanchor } from '@/lib/monitors/locate';

/**
 * The offscreen document is the only extension context with a real DOM
 * parser (`DOMParser`/`document`) — MV3 service workers have neither.
 * It parses fetched HTML and hands it straight to the same
 * `locateAndExtract` pipeline the live-tab content script uses, so
 * fingerprint recovery behaves identically whether the source is a
 * fetched HTML string or a live page. There is no `Window` here (no
 * viewport, no layout), so position-based scoring signals simply don't
 * apply for this strategy — every other signal still does.
 */
onMessage('parseHtml', ({ data }): ParseHtmlResult => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(data.html, 'text/html');
  const result = locateAndExtractWithReanchor(
    doc,
    data.fingerprint,
    data.extractMode,
    data.attributeName,
    undefined,
    data.reanchorLastValue ?? null,
    data.samePage !== undefined ? { samePage: data.samePage } : null,
  );
  return {
    value: result.value,
    diagnostic: result.diagnostic,
    updatedFingerprint: result.updatedFingerprint,
    confidence: result.confidence,
    method: result.method,
    semanticValue: result.semanticValue,
  };
});
