/**
 * Global "Refresh all monitors" loading-state contract.
 *
 * Clicking the top refresh icon must immediately flag every enabled
 * monitor as checking (cards read Checking with a small inline
 * spinner, values kept visible, stale/error states hidden) and flip
 * each card back the moment its own result lands — all without
 * touching the background check/recovery/error pipeline, which is
 * exercised elsewhere and stays exactly as-is.
 */
import './mockBrowser';
import { mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { monitorsItem } from '../lib/storage/items';

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ok - ${message}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Deferred messaging: the background batch stays pending until the
// test releases it, so mid-refresh UI states are observable. ---------
const pendingSends: Array<(value: unknown) => void> = [];
mock.module('../lib/messaging', () => ({
  sendMessage: () => new Promise((resolve) => pendingSends.push(resolve as (value: unknown) => void)),
  withTimeout: (promise: Promise<unknown>) => promise,
}));

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
  const htmlProto = dom.window.HTMLElement.prototype as any;
  if (!htmlProto.attachEvent) htmlProto.attachEvent = () => {};
  if (!htmlProto.detachEvent) htmlProto.detachEvent = () => {};
  return dom;
}

setupDom();
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { checkAllMonitorsNow, checkMonitorNow, isMonitorChecking } = await import(
  '../lib/monitors/client'
);
const { MonitorCard } = await import('../components/monitors/MonitorCard');
const { MonitorDetail } = await import('../components/monitors/MonitorDetail');

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

function seedMonitor(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'r1',
    name: 'R Monitor',
    url: 'https://example.com/item',
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 30,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: Date.now() - 60_000,
    lastValue: '$10.00',
    lastSemanticValue: null,
    lastStatus: 'error',
    lastError:
      'live: best candidate scored 12/100 across 45 elements considered; needs 55 — fetch: SSR HTML did not contain target',
    lastDiagnosticCode: 'SELECTOR_RECOVERY_LOW_CONFIDENCE',
    checkStrategy: null,
    consecutiveFailures: 3,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 3,
    lastFingerprintUpdateAt: null,
    stats: null,
    ...overrides,
  };
}

section('1. batch flags ids immediately, clears on settle, dedupes');
{
  pendingSends.length = 0;
  const p = checkAllMonitorsNow(['a', 'b']);
  assert(isMonitorChecking('a') === true, 'first batch monitor flags checking immediately');
  assert(isMonitorChecking('b') === true, 'second batch monitor flags checking immediately');
  assert(isMonitorChecking('c') === false, 'unlisted monitor never flags');

  const p2 = checkAllMonitorsNow(['a', 'b', 'c']);
  assert(p2 === p, 'second global refresh while running joins the same batch');

  pendingSends.splice(0).forEach((resolve) => resolve({ ok: true, error: null }));
  const result = await p;
  assert(result.ok === true, 'batch resolves ok');
  assert(await p2.then((r) => r.ok) === true, 'joined caller resolves ok too');
  assert(isMonitorChecking('a') === false, 'flags clear when the batch settles');
  assert(isMonitorChecking('b') === false, 'all flags clear when the batch settles');
}

section('2. fresh results flip one card back early (per-monitor finish)');
{
  pendingSends.length = 0;
  const p = checkAllMonitorsNow(['a']);
  assert(isMonitorChecking('a', 1) === true, 'stale timestamp keeps Checking');
  assert(isMonitorChecking('a', null) === true, 'missing timestamp keeps Checking');
  assert(
    isMonitorChecking('a', Date.now() + 5_000) === false,
    'a result stamped after batch start returns to normal early',
  );
  pendingSends.splice(0).forEach((resolve) => resolve({ ok: true, error: null }));
  await p;
}

section('3. single checks are unaffected by batch tracking');
{
  pendingSends.length = 0;
  const p = checkMonitorNow('x');
  assert(isMonitorChecking('x') === true, 'single check flags immediately');
  pendingSends.splice(0).forEach((resolve) => resolve({ ok: true, error: null }));
  const result = await p;
  assert(result.ok === true, 'single check resolves ok');
  assert(isMonitorChecking('x') === false, 'single flag clears on settle');
}

section('4. error card reads Checking during refresh, value kept, no stale error');
{
  setupDom();
  pendingSends.length = 0;
  const batch = checkAllMonitorsNow(['r1']);

  const { container, root } = await render(
    <MonitorCard monitor={seedMonitor()} onDelete={async () => true} onOpen={() => {}} />,
  );
  const text = container.textContent ?? '';
  assert(container.querySelector('[data-testid="value-scanner"]') !== null, 'checking card shows the inline spinner');
  assert(text.includes('$10.00'), 'existing value stays visible while checking');
  assert(!text.includes('Page changed'), 'stale error label hidden while checking');
  assert(!text.includes('(stale)'), 'stale marker hidden while checking');
  assert(!text.includes('scored'), 'no technical trace leaks while checking');
  const reload = container.querySelector('button[aria-label="Check R Monitor now"]') as HTMLButtonElement | null;
  assert(!!reload && reload.disabled === true, 'per-card check is disabled while checking (no duplicates)');

  // This monitor's own result lands mid-batch: normal state returns
  // with the resulting status/value while the batch is still running.
  await act(async () => {
    root.render(
      <MonitorCard
        monitor={seedMonitor({ lastCheckedAt: Date.now() })}
        onDelete={async () => true}
        onOpen={() => {}}
      />,
    );
    await sleep(20);
  });
  const settled = container.textContent ?? '';
  assert(settled.includes('Page changed'), 'resulting error status shows once its result lands');
  assert(container.querySelector('[data-testid="value-scanner"]') === null, 'spinner gone once its result lands');
  await unmount(container, root);
  container.remove();

  pendingSends.splice(0).forEach((resolve) => resolve({ ok: true, error: null }));
  await batch;
}

section('5. unflagged monitors never show Checking; detail matches the card');
{
  setupDom();
  pendingSends.length = 0;
  const batch = checkAllMonitorsNow(['other']);

  const { container, root } = await render(
    <MonitorCard monitor={seedMonitor()} onDelete={async () => true} onOpen={() => {}} />,
  );
  const text = container.textContent ?? '';
  assert(text.includes('Page changed'), 'unflagged error card keeps its normal state');
  assert(container.querySelector('[data-testid="value-scanner"]') === null, 'unflagged card shows no spinner');
  await unmount(container, root);
  container.remove();

  // Settle the first batch: a second call while one is running would
  // just join it (same promise, ids untouched), so start fresh.
  pendingSends.splice(0).forEach((resolve) => resolve({ ok: true, error: null }));
  await batch;

  // Detail view follows the same rule through the same hook.
  await monitorsItem.setValue([seedMonitor({ id: 'r9', name: 'R9 Monitor' })]);
  const flagged = checkAllMonitorsNow(['r9']);
  try {
    const d = document.createElement('div');
    document.body.appendChild(d);
    const detailRoot = createRoot(d);
    await act(async () => {
      detailRoot.render(<MonitorDetail monitorId="r9" onDeleted={() => {}} />);
      await sleep(50);
    });
    const detailText = d.textContent ?? '';
    assert(!detailText.includes('too uncertain'), 'detail hides the stale explanation while checking');
    assert(d.querySelectorAll('svg.animate-spin').length >= 1, 'detail shows checking activity');
    await act(async () => {
      detailRoot.unmount();
    });
    d.remove();
  } finally {
    await monitorsItem.setValue([]);
  }

  pendingSends.splice(0).forEach((resolve) => resolve({ ok: true, error: null }));
  await flagged;
}

console.log(`\n${failures === 0 ? 'All refresh-all tests passed.' : `${failures} refresh-all assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
