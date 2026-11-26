import './mockBrowser';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://www.youtube.com/watch?v=test',
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.CustomEvent = dom.window.CustomEvent;

const realWoff2 = readFileSync('./public/fonts/InterVariable.woff2');

const {
  decodeBase64ToArrayBuffer,
  encodeArrayBufferToBase64,
  ensureInterLoaded,
  getBundledInterFontPayload,
  resetFontLoaderForTesting,
} = await import('../lib/ui/font');
const { EXTENSION_INVALIDATED_EVENT } = await import('../hooks/useExtensionInvalidated');

class MockFontFace {
  family: string;
  source: ArrayBuffer;
  status: 'unloaded' | 'loaded' = 'unloaded';
  constructor(family: string, source: ArrayBuffer) {
    this.family = family;
    this.source = source;
  }
  async load() {
    this.status = 'loaded';
    return this;
  }
}
g.FontFace = MockFontFace;

function createMockFontSet() {
  const fonts: MockFontFace[] = [];
  return {
    add(font: MockFontFace) {
      fonts.push(font);
    },
    [Symbol.iterator]() {
      return fonts.values();
    },
    get items() {
      return fonts;
    },
  };
}

section('1. Base64 round-trip and Chrome JSON serialization fidelity');
{
  const encoded = encodeArrayBufferToBase64(
    realWoff2.buffer.slice(realWoff2.byteOffset, realWoff2.byteOffset + realWoff2.byteLength),
  );
  const jsonRoundTripped = JSON.parse(JSON.stringify({ base64: encoded, mimeType: 'font/woff2' }));
  const decoded = new Uint8Array(decodeBase64ToArrayBuffer(jsonRoundTripped.base64));
  assert(decoded.byteLength === realWoff2.byteLength, 'decoded byte length matches InterVariable.woff2');
  let exactMatch = decoded.byteLength === realWoff2.byteLength;
  for (let i = 0; i < realWoff2.byteLength && exactMatch; i++) {
    if (decoded[i] !== realWoff2[i]) exactMatch = false;
  }
  assert(exactMatch, 'JSON-serialized base64 payload round-trips byte-for-byte');
}

section('2. Background loader: caching, deduplication, and retry after failure');
{
  resetFontLoaderForTesting();
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  let shouldFailOnce = true;

  (globalThis as any).fetch = async (url: unknown) => {
    fetchCount += 1;
    assert(
      String(url) === 'chrome-extension://mock/fonts/InterVariable.woff2',
      `background fetches extension URL (got ${String(url)})`,
    );
    if (shouldFailOnce) {
      shouldFailOnce = false;
      return { ok: false, status: 500, statusText: 'Internal Error' };
    }
    return {
      ok: true,
      arrayBuffer: async () =>
        realWoff2.buffer.slice(realWoff2.byteOffset, realWoff2.byteOffset + realWoff2.byteLength),
    };
  };

  try {
    let failed = false;
    try {
      await getBundledInterFontPayload();
    } catch {
      failed = true;
    }
    assert(failed, 'background fetch failure throws instead of caching broken payload');
    assert(fetchCount === 1, 'initial failure ran 1 fetch');

    const concurrent = await Promise.all([
      getBundledInterFontPayload(),
      getBundledInterFontPayload(),
      getBundledInterFontPayload(),
    ]);
    assert(fetchCount === 2, 'concurrent background calls deduplicate to 1 fetch after retry');
    assert(
      concurrent[0].base64 === concurrent[1].base64 && concurrent[1].base64 === concurrent[2].base64,
      'deduplicated concurrent calls return identical payload',
    );

    await getBundledInterFontPayload();
    assert(fetchCount === 2, 'cached background payload skips subsequent fetch calls');
  } finally {
    globalThis.fetch = realFetch;
  }
}

section('3. Content script loads via background messaging without direct chrome-extension fetch');
{
  resetFontLoaderForTesting();
  const fontSet = createMockFontSet();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fontSet });

  const realFetch = globalThis.fetch;
  let contentFetchCalled = false;
  let messageAttempts = 0;

  (globalThis as any).fetch = async (url: unknown) => {
    if (String(url).startsWith('chrome-extension://')) {
      contentFetchCalled = true;
      throw new Error('Unsafe attempt to load URL from frame');
    }
    return realFetch(url as RequestInfo);
  };

  g.chrome.runtime.sendMessage = (msg: any, cb: (res: any) => void) => {
    messageAttempts += 1;
    queueMicrotask(() => {
      if (msg?.type !== 'getBundledFont') {
        cb({ err: { message: `Unexpected message: ${msg?.type}` } });
        return;
      }
      if (messageAttempts === 1) {
        cb({ err: { message: 'Temporary worker wakeup error' } });
        return;
      }
      const base64 = encodeArrayBufferToBase64(
        realWoff2.buffer.slice(realWoff2.byteOffset, realWoff2.byteOffset + realWoff2.byteLength),
      );
      cb({ res: JSON.parse(JSON.stringify({ base64, mimeType: 'font/woff2' })) });
    });
  };

  try {
    await Promise.all([ensureInterLoaded(), ensureInterLoaded(), ensureInterLoaded()]);
    assert(!contentFetchCalled, 'content script never calls fetch() on chrome-extension:// URL');
    assert(messageAttempts === 2, `retries transient error and deduplicates concurrent callers (attempts=${messageAttempts})`);
    assert(fontSet.items.length === 1, 'registers exactly one FontFace instance');
    assert(fontSet.items[0]?.family === 'Inter' && fontSet.items[0]?.status === 'loaded', 'Inter FontFace loaded');
    assert(
      fontSet.items[0]?.source.byteLength === realWoff2.byteLength,
      'registered FontFace ArrayBuffer matches real InterVariable.woff2 size',
    );

    await ensureInterLoaded();
    assert(messageAttempts === 2, 'subsequent ensureInterLoaded skips messaging once Inter is loaded');
  } finally {
    globalThis.fetch = realFetch;
    delete g.chrome.runtime.sendMessage;
  }
}

section('4. Failed load resets cache so retry works; invalidated context stops immediately');
{
  resetFontLoaderForTesting();
  const fontSet = createMockFontSet();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fontSet });

  let attempts = 0;
  let invalidatedEvents = 0;
  window.addEventListener(EXTENSION_INVALIDATED_EVENT, () => {
    invalidatedEvents += 1;
  });

  g.chrome.runtime.sendMessage = (_msg: any, cb: (res: any) => void) => {
    attempts += 1;
    queueMicrotask(() => cb({ err: { message: 'Transient failure' } }));
  };

  try {
    await ensureInterLoaded();
    assert(attempts === 3, `exhausts configured retry attempts on transient failure (got ${attempts})`);
    assert(fontSet.items.length === 0, 'does not register font when background fails');

    // Subsequent call after failure must retry (not stay stuck on failed promise)
    attempts = 0;
    g.chrome.runtime.sendMessage = (_msg: any, cb: (res: any) => void) => {
      attempts += 1;
      g.chrome.runtime.lastError = { message: 'Extension context invalidated.' };
      try {
        cb(undefined);
      } finally {
        delete g.chrome.runtime.lastError;
      }
    };
    await ensureInterLoaded();
    assert(attempts === 1, 'stale/invalidated context aborts immediately without retrying');
    assert(invalidatedEvents >= 1, 'dispatches EXTENSION_INVALIDATED_EVENT on stale context');
  } finally {
    delete g.chrome.runtime.lastError;
    delete g.chrome.runtime.sendMessage;
  }
}

console.log('\nAll extension font-loading regression tests passed.');
