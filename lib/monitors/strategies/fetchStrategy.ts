import { sendMessage } from '@/lib/messaging';
import { ensureOffscreenDocument } from '../offscreenManager';
import { diagnostic } from '../diagnostics';
import { resolveCheckUrl } from '../itemUrl';
import type { CheckStrategy, StrategyOutcome } from './types';

/** How long to wait for a response before giving up and falling back to the live-tab strategy. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches the page's raw HTML and locates/extracts the value from it via
 * the offscreen document's `DOMParser`. Fast and invisible to the user,
 * but only sees server-rendered markup — it can't see anything a page's
 * own JavaScript renders after load, nor wait for it to settle.
 * `liveTabStrategy` covers that case; `checker.ts` cascades to it
 * automatically when this one can't find the value.
 */
export const fetchStrategy: CheckStrategy = {
  id: 'fetch',
  async run(monitor): Promise<StrategyOutcome> {
    // Resolves to the watched feed item's own permalink when the
    // fingerprint has one (see `resolveCheckUrl`), otherwise the
    // monitor's own page - unchanged behavior for every non-feed monitor.
    const checkUrl = resolveCheckUrl(monitor);
    let html: string;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(checkUrl, { credentials: 'include', signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 401 || response.status === 403) {
        return {
          value: null,
          diagnostic: diagnostic('AUTH_REQUIRED', `server responded ${response.status}`),
          updatedFingerprint: null,
          confidence: 0,
          method: 'none',
          semanticValue: null,
        };
      }
      if (!response.ok) {
        return {
          value: null,
          diagnostic: diagnostic('NETWORK_ERROR', `request failed with status ${response.status}`),
          updatedFingerprint: null,
          confidence: 0,
          method: 'none',
          semanticValue: null,
        };
      }
      html = await response.text();
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      return {
        value: null,
        diagnostic: isAbort
          ? diagnostic('PAGE_LOAD_TIMEOUT', `no response within ${FETCH_TIMEOUT_MS / 1000}s`)
          : diagnostic('NETWORK_ERROR', error instanceof Error ? error.message : 'fetch failed'),
        updatedFingerprint: null,
        confidence: 0,
        method: 'none',
        semanticValue: null,
      };
    }

    try {
      await ensureOffscreenDocument();
      const result = await sendMessage('parseHtml', {
        html,
        fingerprint: monitor.fingerprint,
        extractMode: monitor.extractMode,
        attributeName: monitor.attributeName,
      });
      return result;
    } catch (error) {
      return {
        value: null,
        diagnostic: diagnostic('UNKNOWN', error instanceof Error ? error.message : 'HTML parsing failed'),
        updatedFingerprint: null,
        confidence: 0,
        method: 'none',
        semanticValue: null,
      };
    }
  },
};
