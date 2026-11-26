import './mockBrowser';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import {
  resetFaviconCacheForTesting,
  resolveSiteFavicon,
} from '../lib/favicon';
import {
  extractSameOriginFaviconCandidates,
  faviconUrl,
  resetBackgroundFaviconCacheForTesting,
  resolveSiteFaviconInBackground,
} from '../lib/faviconBackground';
import { faviconsItem } from '../lib/storage/items';

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

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
    pretendToBeVisual: true,
  });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  g.navigator = dom.window.navigator;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

setupDom();
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Favicon } = await import('../components/layout/Favicon');

async function render(el: ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return { container, root };
}

async function unmount(container: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const PLACEHOLDER_BYTES = new Uint8Array([1, 2, 3, 4]);

section('1. Local favicon cache URL');
{
  const src = faviconUrl('https://example.com/pricing', 32);
  assert(
    src.startsWith('chrome-extension://mock-extension-id/_favicon/'),
    'uses Chrome local _favicon cache URL',
  );
  assert(!src.includes('google.com'), 'never builds a Google favicon URL');
}

section('2. Same-origin HTML icon extraction');
{
  const html = `
    <link rel="icon" href="https://thirdparty.example/favicon.png">
    <link rel="apple-touch-icon" href="/apple-icon.png">
    <link rel="icon" href="/assets/site-32.png" sizes="32x32">
  `;
  const candidates = extractSameOriginFaviconCandidates(html, 'https://example.com/app/page');
  assert(!candidates.some((u) => u.includes('thirdparty.example')), 'ignores third-party CDN icon links');
  assert(candidates[0] === 'https://example.com/assets/site-32.png', 'prioritizes same-origin rel=icon');
  assert(candidates.includes('https://example.com/favicon.ico'), 'includes /favicon.ico fallback');
}

section('3. Background resolution: Chrome cache, direct same-origin retrieval, caching, and permission gate');
{
  resetFaviconCacheForTesting();
  resetBackgroundFaviconCacheForTesting();
  await faviconsItem.setValue({});
  const g = globalThis as any;
  const realFetch = globalThis.fetch;
  const hadPermissions = 'permissions' in g.chrome;
  const origPermissions = g.chrome.permissions;
  let granted = true;
  g.chrome.permissions = {
    contains: async () => granted,
  };

  let directFetches = 0;
  (globalThis as any).fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes('/_favicon/')) {
      if (url.includes('cached.example')) {
        return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => PNG_1X1.buffer.slice(0) };
      }
      return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => PLACEHOLDER_BYTES.buffer.slice(0) };
    }
    directFetches += 1;
    if (url === 'https://fresh.example/favicon.ico') {
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => PNG_1X1.buffer.slice(0),
      };
    }
    if (url === 'https://linkonly.example/page') {
      return {
        ok: true,
        url: 'https://linkonly.example/page',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><head><link rel="icon" href="/img/icon.png"></head></html>',
      };
    }
    if (url === 'https://linkonly.example/img/icon.png') {
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => PNG_1X1.buffer.slice(0),
      };
    }
    if (url === 'https://redirect.example/favicon.ico') {
      return {
        ok: true,
        url: 'https://other-origin.example/favicon.ico',
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => PNG_1X1.buffer.slice(0),
      };
    }
    if (url === 'https://soft404.example/favicon.ico') {
      return {
        ok: true,
        url: 'https://soft404.example/favicon.ico',
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        arrayBuffer: async () => new TextEncoder().encode('<html>404</html>').buffer,
      };
    }
    if (url === 'https://race-a.example/favicon.ico' || url === 'https://race-b.example/favicon.ico') {
      await sleep(10);
      return {
        ok: true,
        url,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => PNG_1X1.buffer.slice(0),
      };
    }
    return { ok: false, status: 404, headers: new Headers() };
  };

  try {
    const fromChrome = await resolveSiteFaviconInBackground('https://cached.example/pricing', 32);
    assert(
      fromChrome.kind === 'data' && fromChrome.src?.startsWith('data:image/png;base64,') === true,
      'uses Chrome _favicon cache as data URL when non-placeholder icon exists',
    );
    assert(directFetches === 0, 'does not fetch site directly when Chrome cache hits');

    const concurrent = await Promise.all([
      resolveSiteFaviconInBackground('https://fresh.example/a', 32),
      resolveSiteFaviconInBackground('https://fresh.example/b', 32),
    ]);
    assert(concurrent[0].kind === 'data' && concurrent[0].src?.startsWith('data:image/png;base64,') === true, 'retrieves website favicon directly when Chrome cache misses');
    assert(directFetches === 1, `deduplicates concurrent direct fetches per origin (got ${directFetches})`);

    const cachedAfter = await resolveSiteFaviconInBackground('https://fresh.example/c', 32);
    assert(cachedAfter.kind === 'data' && cachedAfter.src === concurrent[0].src, 'serves cached favicon locally');
    assert(directFetches === 1, 'local cache avoids repeat direct network requests');

    const fromLink = await resolveSiteFaviconInBackground('https://linkonly.example/page', 32);
    assert(fromLink.kind === 'data' && fromLink.src?.startsWith('data:image/png;base64,') === true, 'falls back to same-origin HTML <link rel="icon"> when /favicon.ico 404s');

    const beforeDeniedFetches = directFetches;
    granted = false;
    const denied = await resolveSiteFaviconInBackground('https://revoked.example/item', 32);
    assert(denied.kind === 'none', 'does not fetch when origin permission is not granted');
    assert(directFetches === beforeDeniedFetches, 'denied origin triggers zero network fetches');

    granted = true;
    const redirected = await resolveSiteFaviconInBackground('https://redirect.example/page', 32);
    assert(redirected.kind === 'none', 'rejects cross-origin redirect responses for favicons');

    const soft404 = await resolveSiteFaviconInBackground('https://soft404.example/page', 32);
    assert(soft404.kind === 'none', 'rejects text/html responses served from /favicon.ico');

    await Promise.all([
      resolveSiteFaviconInBackground('https://race-a.example/1', 32),
      resolveSiteFaviconInBackground('https://race-b.example/1', 32),
    ]);
    const storedAfterConcurrent = await faviconsItem.getValue();
    assert(
      Boolean(storedAfterConcurrent?.['https://race-a.example']?.dataUrl) &&
        Boolean(storedAfterConcurrent?.['https://race-b.example']?.dataUrl),
      'serializes concurrent multi-origin cache writes without losing entries',
    );
  } finally {
    globalThis.fetch = realFetch;
    if (hadPermissions) g.chrome.permissions = origPermissions;
    else delete g.chrome.permissions;
    await faviconsItem.setValue({});
  }
}

section('4. Favicon component uses background resolution, shares origin cache, and falls back to globe');
{
  resetFaviconCacheForTesting();
  const g = globalThis as any;
  let calls = 0;
  g.chrome.runtime.sendMessage = (msg: any, cb: (res: any) => void) => {
    calls += 1;
    queueMicrotask(() => {
      if (msg?.type === 'resolveFavicon' && String(msg?.data?.url).includes('fetched.example')) {
        cb({ res: { kind: 'data', src: 'data:image/png;base64,AAAA' } });
      } else if (msg?.type === 'resolveFavicon' && String(msg?.data?.url).includes('unsafe-chrome.example')) {
        cb({ res: { kind: 'data', src: 'chrome-extension://mock-id/_favicon/?pageUrl=https://unsafe-chrome.example&size=24' } });
      } else if (msg?.type === 'resolveFavicon' && String(msg?.data?.url).includes('none.example')) {
        cb({ res: { kind: 'none', src: null } });
      } else {
        cb({ res: { kind: 'data', src: 'data:image/png;base64,BBBB' } });
      }
    });
  };

  try {
    const { container, root } = await render(<Favicon url="https://fetched.example/pricing" size={16} />);
    await act(async () => {
      await sleep(30);
    });
    const img = container.querySelector('img');
    assert(img?.getAttribute('src') === 'data:image/png;base64,AAAA', 'renders resolved site favicon');

    // Different size on same origin reuses origin cache synchronously with zero extra IPC
    const dropdown = await render(<Favicon url="https://fetched.example/other" size={13} />);
    assert(
      dropdown.container.querySelector('img')?.getAttribute('src') === 'data:image/png;base64,AAAA',
      'dropdown reuses origin favicon cache synchronously across sizes',
    );
    assert(calls === 1, `origin cache avoids duplicate messaging across card and dropdown (calls=${calls})`);
    await unmount(dropdown.container, dropdown.root);

    await act(async () => {
      img!.dispatchEvent(new window.Event('error'));
    });
    assert(container.querySelector('img') === null && !!container.querySelector('svg'), 'falls back to globe on image error');

    await act(async () => {
      root.render(<Favicon url="https://none.example/stats" size={16} />);
      await sleep(30);
    });
    assert(container.querySelector('img') === null && !!container.querySelector('svg'), 'renders globe when no favicon is available');

    const unsafeResult = await resolveSiteFavicon('https://unsafe-chrome.example/watch?v=1', 24);
    assert(unsafeResult === null, 'client resolver rejects chrome-extension:// URLs');
    await act(async () => {
      root.render(<Favicon url="https://unsafe-chrome.example/watch?v=1" size={12} />);
      await sleep(30);
    });
    assert(
      container.querySelector('img') === null && !!container.querySelector('svg'),
      'Favicon component never sets img src to a chrome-extension:// URL',
    );

    await unmount(container, root);
  } finally {
    delete g.chrome.runtime.sendMessage;
  }
}

{
  const { container, root } = await render(<Favicon url="not-a-url" size={16} />);
  assert(container.querySelector('img') === null, 'invalid URL does not render an img');
  assert(!!container.querySelector('svg'), 'invalid URL renders the generic globe icon');
  await unmount(container, root);
}

console.log('\nAll favicon privacy and fallback tests passed.');
