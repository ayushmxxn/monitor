/**
 * M5: manual Check now failures must be visible; paused monitors must
 * not offer a Check now action that no-ops with success.
 *
 * Real component tests (jsdom + React `act`): the `checkMonitorNow`
 * client is module-mocked with a programmed Result (the client
 * contract itself is covered elsewhere), while the real Card/Detail
 * components, Result handling, and UI states are exercised.
 */
import { mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { AppError } from '../lib/errors';
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

// --- DOM setup ----------------------------------------------------------
// NOTE: setupDom() + the `oninput` seed must run before react-dom is
// first imported anywhere in this process (see mutations.test.tsx):
// React caches its native-`input`-event probe at module load, and the
// module registry is shared across test files run by one `bun test`.

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
// react-dom evaluates (dynamic imports below).
setupDom();
(document as any).oninput = () => {};

// --- Programmed check results for the mocked client -------------------

let nextResult: { ok: true; value: undefined } | { ok: false; error: AppError } = {
  ok: true,
  value: undefined,
};
const checkNowCalls: string[] = [];
const checkingSet = new Set<string>();
const checkingListeners = new Set<() => void>();

mock.module('../lib/monitors/client', () => ({
  isMonitorChecking: (id: string) => checkingSet.has(id),
  subscribeChecking: (fn: () => void) => {
    checkingListeners.add(fn);
    return () => {
      checkingListeners.delete(fn);
    };
  },
  checkMonitorNow: async (id: string) => {
    checkNowCalls.push(id);
    checkingSet.add(id);
    checkingListeners.forEach((l) => l());
    await sleep(10);
    checkingSet.delete(id);
    checkingListeners.forEach((l) => l());
    return nextResult;
  },
  checkAllMonitorsNow: async () => ({ ok: true, value: undefined }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MonitorCard } = await import('../components/monitors/MonitorCard');
const { MonitorDetail } = await import('../components/monitors/MonitorDetail');

// --- Rendering helpers --------------------------------------------------

async function render(el: ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return { container, root };
}

async function click(el: Element | null) {
  assert(!!el, 'click target exists');
  await act(async () => {
    el!.dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
  });
  // Flush any state updates queued by the async check completion.
  await act(async () => {
    await sleep(50);
  });
}

function queryAlert(container: ParentNode): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

function seedMonitor(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'm5-1',
    name: 'M5 Monitor',
    url: 'https://example.com/item',
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
    lastStatus: 'error',
    lastError: 'The page could not be reached due to a connection or network error.',
    lastDiagnosticCode: 'NETWORK_ERROR',
    checkStrategy: null,
    consecutiveFailures: 1,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 3,
    lastFingerprintUpdateAt: null,
    stats: null,
    ...overrides,
  };
}

// --- Card: failed retry shows a compact error --------------------------

section('M5: card retry failure is visible, success stays clean');

{
  setupDom();
  nextResult = {
    ok: false,
    error: new AppError({ code: 'UNKNOWN', message: 'The background worker did not respond in time.' }),
  };
  checkNowCalls.length = 0;
  const monitor = seedMonitor() as any;
  const { container, root } = await render(
    <MonitorCard monitor={monitor} onDelete={() => {}} onOpen={() => {}} />,
  );
  const retry = container.querySelector('button[aria-label="Check M5 Monitor now"]');
  assert(!!retry, 'error card offers a retry button');
  await click(retry);
  assert(checkNowCalls.length === 1 && checkNowCalls[0] === 'm5-1', 'retry invokes exactly one check');
  const alert = queryAlert(container);
  assert(
    !!alert && alert.includes('did not respond in time'),
    `failed retry shows the error (got ${JSON.stringify(alert)})`,
  );
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

{
  setupDom();
  nextResult = { ok: true, value: undefined };
  checkNowCalls.length = 0;
  const monitor = seedMonitor() as any;
  const { container, root } = await render(
    <MonitorCard monitor={monitor} onDelete={() => {}} onOpen={() => {}} />,
  );
  await click(container.querySelector('button[aria-label="Check M5 Monitor now"]'));
  assert(checkNowCalls.length === 1, 'successful retry still runs the check (retry unchanged)');
  assert(queryAlert(container) === null, 'successful retry shows no error');
  assert(
    !!container.querySelector('button[aria-label="Check M5 Monitor now"]'),
    'retry button remains available after success',
  );
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

// --- Card: paused monitor offers no retry --------------------------------

section('M5: paused monitor offers no Check now action');

{
  setupDom();
  const monitor = seedMonitor({ enabled: false }) as any;
  const { container, root } = await render(
    <MonitorCard monitor={monitor} onDelete={() => {}} onOpen={() => {}} />,
  );
  assert(
    container.querySelector('button[aria-label="Check M5 Monitor now"]') === null,
    'paused error card shows no retry button (no misleading no-op)',
  );
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

// --- Detail: failed check shows InlineNotice; paused menu has none ------

section('M5: detail check failure is visible; paused detail has no Check now');

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  try {
    nextResult = {
      ok: false,
      error: new AppError({ code: 'UNKNOWN', message: 'The check failed.' }),
    };
    checkNowCalls.length = 0;
    const { container, root } = await render(<MonitorDetail monitorId="m5-1" onDeleted={() => {}} />);
    const retry =
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Retry check')) ??
      null;
    assert(!!retry, 'error detail offers a Retry check button');
    await click(retry);
    assert(checkNowCalls.length === 1, 'detail check runs once');
    const alert = queryAlert(container);
    assert(
      !!alert && alert.includes('The check failed.'),
      `failed detail check shows an InlineNotice error (got ${JSON.stringify(alert)})`,
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  } finally {
    await monitorsItem.setValue([]);
  }
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor({ enabled: false })]);
  try {
    const { container, root } = await render(<MonitorDetail monitorId="m5-1" onDeleted={() => {}} />);
    assert(
      container.textContent?.includes('Resume monitoring') === true,
      'paused detail offers Resume monitoring as the path',
    );
    const menuTrigger = container.querySelector('button[aria-label="More actions"]');
    assert(!!menuTrigger, 'overflow menu trigger exists');
    await click(menuTrigger);
    const menu = container.querySelector('[role="menu"]');
    assert(!!menu, 'overflow menu opens');
    assert(
      !menu!.textContent?.includes('Check now'),
      'paused overflow menu contains no Check now item',
    );
    assert(menu!.textContent?.includes('Resume monitoring') === true, 'menu keeps the Resume path');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  } finally {
    await monitorsItem.setValue([]);
  }
}

console.log('\nAll Check now UI tests finished.');
