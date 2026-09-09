/**
 * M7: revoked site permission must have a working recovery path.
 *
 * Real component tests (jsdom + React `act`): the permission banner in
 * MonitorDetail and the new SiteAccessSection in Options are rendered
 * against stubbed messaging (`checkOriginPermissions` / `openOptionsPage`)
 * and a programmable `browser.permissions.request`, with monitors seeded
 * through the real storage stack.
 */
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { monitorsItem } from '../lib/storage/items';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// Prime the first document and select React's native input path before
// react-dom evaluates (shared registry across test files in one run).
setupDom();
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MonitorDetail } = await import('../components/monitors/MonitorDetail');
const { SiteAccessSection } = await import('../components/settings/SiteAccessSection');

// --- Messaging + permission stubs (restored at the end) ------------------

const deniedOrigins = new Set<string>();
let requestCalls: Array<{ origins: string[] }> = [];
// true = grant, false = user dismisses, 'throw' = API error,
// 'apply' = grant that takes effect for later status checks.
let nextGrant: boolean | 'throw' | 'apply' = true;

{
  const g = globalThis as any;
  g.__m7OrigSendMessage = g.chrome.runtime.sendMessage;
  g.__m7HadPermissions = 'permissions' in g.chrome;
  g.chrome.runtime.sendMessage = (msg: any, cb: (res: any) => void) => {
    queueMicrotask(() => {
      // The messaging layer expects `{ res, err }` envelopes.
      if (msg?.type === 'checkOriginPermissions') {
        cb({ res: Object.fromEntries((msg.data as string[]).map((u) => [u, !deniedOrigins.has(new URL(u).origin)])) });
      } else if (msg?.type === 'openOptionsPage') {
        cb({ res: { ok: true } });
      } else {
        cb({ res: null });
      }
    });
  };
  g.chrome.permissions = {
    contains: async () => false,
    request: async (req: { origins: string[] }) => {
      requestCalls.push(req);
      if (nextGrant === 'throw') throw new Error('permission backend unavailable');
      if (nextGrant === 'apply') {
        for (const pattern of req.origins) deniedOrigins.delete(pattern.replace(/\/\*$/, ''));
        return true;
      }
      return nextGrant;
    },
    remove: async () => false,
  };
}

async function render(el: ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  await act(async () => {
    await sleep(50);
  });
  return { container, root };
}

async function unmount(container: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

async function click(el: Element | null) {
  assert(!!el, 'click target exists');
  await act(async () => {
    el!.dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
  });
  await act(async () => {
    await sleep(50);
  });
}

function queryAlert(container: ParentNode): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

function seedMonitor(id: string, url: string): any {
  return {
    id,
    name: `M7 ${id}`,
    url,
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 30,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: Date.now(),
    lastValue: '$10.00',
    lastSemanticValue: null,
    lastStatus: 'unchanged',
    lastError: null,
    lastDiagnosticCode: 'OK',
    checkStrategy: null,
    consecutiveFailures: 0,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 3,
    lastFingerprintUpdateAt: null,
    stats: null,
  };
}

// --- Revoked permission surfaces a working recovery action ---------------

section('M7: revoked permission offers recovery; re-grant refreshes state');

{
  setupDom();
  deniedOrigins.clear();
  deniedOrigins.add('https://example.com');
  await monitorsItem.setValue([seedMonitor('m7-1', 'https://example.com/item')]);
  try {
    const { container, root } = await render(<MonitorDetail monitorId="m7-1" onDeleted={() => {}} />);
    const banner = container.textContent ?? '';
    assert(banner.includes('was revoked'), 'revoked permission shows the recovery banner');
    const grant =
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Grant access') ??
      null;
    assert(!!grant, 'banner offers a Grant access recovery action');
    await click(grant);
    assert(queryAlert(container) === null, 'banner action does not itself error');
    await unmount(container, root);
  } finally {
    await monitorsItem.setValue([]);
  }
}

// --- Site access section: list, grant, deny -------------------------------

section('M7: site access section grants per-origin access');

{
  setupDom();
  deniedOrigins.clear();
  deniedOrigins.add('https://a.example');
  requestCalls = [];
  nextGrant = 'apply';
  await monitorsItem.setValue([
    seedMonitor('m7-a', 'https://a.example/page'),
    seedMonitor('m7-b', 'https://b.example/page'),
  ]);
  try {
    const { container, root } = await render(<SiteAccessSection />);
    assert((container.textContent ?? '').includes('a.example'), 'revoked origin is listed');
    assert(!(container.textContent ?? '').includes('b.example'), 'granted origin is not listed');
    const grant = container.querySelector('button[aria-label="Grant access to a.example"]');
    assert(!!grant, 'revoked origin has a Grant access button');
    await click(grant);
    assert(requestCalls.length === 1, 'grant requests exactly once');
    assert(
      JSON.stringify(requestCalls[0]!.origins) === JSON.stringify(['https://a.example/*']),
      `grant requests only the revoked origin (got ${JSON.stringify(requestCalls[0])})`,
    );
    assert(queryAlert(container) === null, 'successful grant shows no error');
    assert(
      !(container.textContent ?? '').includes('a.example'),
      'granted origin leaves the list after refresh',
    );
    assert(
      (container.textContent ?? '').includes('can access'),
      'section confirms access once nothing is revoked',
    );
    await unmount(container, root);
  } finally {
    await monitorsItem.setValue([]);
  }
}

{
  setupDom();
  deniedOrigins.clear();
  deniedOrigins.add('https://a.example');
  requestCalls = [];
  nextGrant = false;
  await monitorsItem.setValue([seedMonitor('m7-a', 'https://a.example/page')]);
  try {
    const { container, root } = await render(<SiteAccessSection />);
    const grant = container.querySelector('button[aria-label="Grant access to a.example"]');
    await click(grant);
    const alert = queryAlert(container);
    assert(!!alert && alert.toLowerCase().includes('not granted'), `denied grant shows a useful error (got ${JSON.stringify(alert)})`);
    assert((container.textContent ?? '').includes('a.example'), 'denied origin stays listed for retry');
    await unmount(container, root);
  } finally {
    await monitorsItem.setValue([]);
  }
}

{
  setupDom();
  deniedOrigins.clear();
  requestCalls = [];
  nextGrant = true;
  await monitorsItem.setValue([seedMonitor('m7-b', 'https://b.example/page')]);
  try {
    const { container, root } = await render(<SiteAccessSection />);
    assert(
      (container.textContent ?? '').includes('can access'),
      'all-granted state confirms access with no action needed',
    );
    assert(
      container.querySelector('button[aria-label^="Grant access to"]') === null,
      'all-granted state shows no grant buttons',
    );
    assert(requestCalls.length === 0, 'granted flow requests nothing');
    await unmount(container, root);
  } finally {
    await monitorsItem.setValue([]);
  }
}

// --- Restore shared stubs -------------------------------------------------

{
  const g = globalThis as any;
  if (g.__m7OrigSendMessage === undefined) delete g.chrome.runtime.sendMessage;
  else g.chrome.runtime.sendMessage = g.__m7OrigSendMessage;
  delete g.__m7OrigSendMessage;
  if (!g.__m7HadPermissions) delete g.chrome.permissions;
  delete g.__m7HadPermissions;
  deniedOrigins.clear();
}

console.log('\nAll site-access recovery tests finished.');
