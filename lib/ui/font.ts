import { isExtensionContextInvalidated } from '@/lib/errors';
import { sendMessage, withTimeout, type BundledFontPayload } from '@/lib/messaging';

const FONT_RESOURCE_PATH = '/fonts/InterVariable.woff2';
const FONT_MESSAGE_TIMEOUT_MS = 5_000;
const MAX_FONT_LOAD_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 250] as const;
const BASE64_CHUNK_SIZE = 0x2000;

let cachedFontPayload: BundledFontPayload | null = null;
let inFlightBackgroundLoad: Promise<BundledFontPayload> | null = null;

let cachedFontBuffer: ArrayBuffer | null = null;
let inFlightClientLoad: Promise<void> | null = null;

export function encodeArrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE)));
  }
  return btoa(chunks.join(''));
}

export function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Background-side font loader. Fetches the bundled WOFF2 from the
 * extension's own origin (never a web frame), serializes it as base64
 * for Chrome JSON messaging, deduplicates concurrent calls, and caches
 * the payload for the lifetime of the service worker.
 */
export async function getBundledInterFontPayload(): Promise<BundledFontPayload> {
  if (cachedFontPayload) {
    return cachedFontPayload;
  }
  if (inFlightBackgroundLoad) {
    return inFlightBackgroundLoad;
  }

  inFlightBackgroundLoad = (async () => {
    const fontUrl = browser.runtime.getURL(FONT_RESOURCE_PATH);
    const response = await fetch(fontUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch bundled font (${response.status} ${response.statusText})`);
    }
    const fontBuffer = await response.arrayBuffer();
    if (fontBuffer.byteLength === 0) {
      throw new Error('Bundled font response was empty.');
    }
    const payload: BundledFontPayload = {
      base64: encodeArrayBufferToBase64(fontBuffer),
      mimeType: 'font/woff2',
    };
    cachedFontPayload = payload;
    return payload;
  })().finally(() => {
    inFlightBackgroundLoad = null;
  });

  return inFlightBackgroundLoad;
}

function hasValidExtensionRuntime(): boolean {
  try {
    return Boolean(
      (typeof browser !== 'undefined' && browser?.runtime?.id) ||
        (typeof chrome !== 'undefined' && chrome?.runtime?.id),
    );
  } catch {
    return false;
  }
}

function isInterAlreadyLoaded(): boolean {
  if (typeof document === 'undefined' || !document.fonts) {
    return false;
  }
  for (const font of document.fonts) {
    if (font.family === 'Inter' && font.status === 'loaded') {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFontBufferViaBackground(): Promise<ArrayBuffer> {
  if (cachedFontBuffer) {
    return cachedFontBuffer;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_FONT_LOAD_ATTEMPTS; attempt++) {
    if (!hasValidExtensionRuntime()) {
      throw new Error('Extension context invalidated.');
    }

    try {
      const payload = await withTimeout(
        sendMessage('getBundledFont', undefined),
        FONT_MESSAGE_TIMEOUT_MS,
      );
      if (!payload || typeof payload.base64 !== 'string' || payload.base64.length === 0) {
        throw new Error('Background worker returned an invalid font payload.');
      }
      const buffer = decodeBase64ToArrayBuffer(payload.base64);
      if (buffer.byteLength === 0) {
        throw new Error('Decoded bundled font buffer was empty.');
      }
      cachedFontBuffer = buffer;
      return buffer;
    } catch (error) {
      lastError = error;
      if (isExtensionContextInvalidated(error) || attempt === MAX_FONT_LOAD_ATTEMPTS - 1) {
        break;
      }
      await sleep(RETRY_DELAYS_MS[attempt] ?? 250);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  const msg =
    lastError && typeof lastError === 'object' && typeof (lastError as { message?: unknown }).message === 'string'
      ? (lastError as { message: string }).message
      : 'Failed to load bundled Inter font.';
  throw new Error(msg);
}

/**
 * Loads and registers the bundled Inter WOFF2 variable font into
 * `document.fonts` using `FontFace(ArrayBuffer)`.
 *
 * Content scripts run inside the host page's renderer frame, where
 * direct `fetch('chrome-extension://...')` requests can fail with
 * "Unsafe attempt to load URL chrome-extension://..." on strict pages
 * or stale extension contexts. Fetching through the background service
 * worker keeps the asset fetch inside the extension's own origin while
 * registering the decoded `ArrayBuffer` in-memory with zero external
 * network requests or host CSP exposure.
 */
export function ensureInterLoaded(): Promise<void> {
  if (isInterAlreadyLoaded()) {
    return Promise.resolve();
  }
  if (inFlightClientLoad) {
    return inFlightClientLoad;
  }

  const run = (async () => {
    try {
      const fontBuffer = await fetchFontBufferViaBackground();
      if (isInterAlreadyLoaded()) {
        return;
      }
      const font = new FontFace('Inter', fontBuffer.slice(0), {
        style: 'normal',
        weight: '100 900',
        display: 'swap',
      });
      await font.load();
      document.fonts.add(font);
    } catch (err) {
      console.warn('Failed to load bundled Inter font:', err);
    } finally {
      inFlightClientLoad = null;
    }
  })();

  inFlightClientLoad = run;
  return run;
}

export function resetFontLoaderForTesting(): void {
  cachedFontPayload = null;
  inFlightBackgroundLoad = null;
  cachedFontBuffer = null;
  inFlightClientLoad = null;
}
