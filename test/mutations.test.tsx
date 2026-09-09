/**
 * M3: failed monitor mutations must never leave the UI claiming success.
 *
 * Real component tests (jsdom + React `act`) against the real store and
 * the preloaded mock `chrome.storage`: write failures are injected by
 * wrapping `chrome.storage.local.set`, then each Detail mutation (delete,
 * pause/resume, rename, alert-condition save) is driven through the UI
 * in both failing and succeeding modes.
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
  // React's legacy input-value polyfill calls IE-only attach/detachEvent
  // on the focused element when synthetic input events are dispatched;
  // jsdom lacks them, so no-op shims keep the path quiet.
  const htmlProto = dom.window.HTMLElement.prototype as any;
  if (!htmlProto.attachEvent) htmlProto.attachEvent = () => {};
  if (!htmlProto.detachEvent) htmlProto.detachEvent = () => {};
  return dom;
}

// React decides once, at react-dom load time, whether the environment
// supports native `input` events (`'oninput' in document`). jsdom fails
// that probe, which strands React on its IE `propertychange` polyfill
// where synthetic input events never produce onChange. Seeding the
// property on the very first document (before react-dom is imported
// below) selects the native path, so the input tests exercise real
// onChange handling. Later JSDOM swaps reuse the cached decision.
setupDom();
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
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

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(20);
  });
}

function queryAlert(container: ParentNode): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

function menuItem(container: ParentNode, label: string): Element | null {
  const menu = container.querySelector('[role="menu"]');
  if (!menu) return null;
  return (
    Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) ?? null
  );
}

function seedMonitor(): any {
  return {
    id: 'm3-1',
    name: 'M3 Monitor',
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
    lastSemanticValue: { type: 'number', normalized: 10, unit: null, raw: '10' },
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

async function storedMonitor() {
  const list = (await monitorsItem.getValue()) as any[];
  return list.find((m) => m.id === 'm3-1') ?? null;
}

async function withFailingWrites(fn: () => Promise<void>) {
  const local = (globalThis as any).chrome.storage.local;
  const origSet = local.set;
  local.set = async () => {
    throw new Error('quota exceeded');
  };
  try {
    await fn();
  } finally {
    local.set = origSet;
  }
}

async function openMenu(container: ParentNode) {
  await click(container.querySelector('button[aria-label="More actions"]'));
  assert(!!container.querySelector('[role="menu"]'), 'overflow menu opens');
}

// --- Failed mutations ----------------------------------------------------

section('M3: failed mutations surface an error and change nothing');

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  let deleted = 0;
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => { deleted += 1; }} />);
  await withFailingWrites(async () => {
    await openMenu(container);
    await click(menuItem(container, 'Delete'));
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete',
    );
    await click(confirm ?? null);
    assert(deleted === 0, 'failed delete does not navigate away');
    const alert = queryAlert(container);
    assert(!!alert && alert.includes('quota exceeded'), `failed delete shows the error (got ${JSON.stringify(alert)})`);
    assert((await storedMonitor()) !== null, 'failed delete keeps the monitor in storage');
  });
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await monitorsItem.setValue([]);
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => {}} />);
  await withFailingWrites(async () => {
    await openMenu(container);
    await click(menuItem(container, 'Pause monitoring'));
    const alert = queryAlert(container);
    assert(!!alert && alert.includes('quota exceeded'), `failed pause shows the error (got ${JSON.stringify(alert)})`);
    assert((await storedMonitor())?.enabled === true, 'failed pause leaves enabled=true in storage');
  });
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await monitorsItem.setValue([]);
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => {}} />);
  await withFailingWrites(async () => {
    await openMenu(container);
    await click(menuItem(container, 'Rename'));
    const input = document.querySelector('input[placeholder="example.com"]') as HTMLInputElement | null;
    assert(!!input, 'rename dialog opens with the name input');
    await setInputValue(input!, 'Renamed Monitor');
    const save = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save');
    await click(save ?? null);
    const alert = queryAlert(container);
    assert(!!alert && alert.includes('quota exceeded'), `failed rename shows the error (got ${JSON.stringify(alert)})`);
    assert((await storedMonitor())?.name === 'M3 Monitor', 'failed rename keeps the stored name');
  });
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await monitorsItem.setValue([]);
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => {}} />);
  await withFailingWrites(async () => {
    await click(container.querySelector('button[aria-label="Alert condition"]'));
    await click(
      Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((b) =>
        b.textContent?.includes('Value decreases'),
      ) ?? null,
    );
    const alert = queryAlert(container);
    assert(!!alert && alert.includes('quota exceeded'), `failed condition save shows the error (got ${JSON.stringify(alert)})`);
    assert(
      (await storedMonitor())?.alertCondition == null,
      'failed condition save leaves storage unchanged',
    );
    assert(
      container.querySelector('button[aria-label="Alert condition"]')?.textContent?.includes('Any change') === true,
      'failed condition save reverts the optimistic picker UI',
    );
  });
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await monitorsItem.setValue([]);
}

// --- Successful mutations behave exactly as before ------------------------

section('M3: successful mutations behave exactly as before');

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  let deleted = 0;
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => { deleted += 1; }} />);
  await openMenu(container);
  await click(menuItem(container, 'Delete'));
  const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete');
  await click(confirm ?? null);
  assert(deleted === 1, 'successful delete navigates away');
  assert((await storedMonitor()) === null, 'successful delete removes the monitor');
  assert(queryAlert(container) === null, 'successful delete shows no error');
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => {}} />);
  await openMenu(container);
  await click(menuItem(container, 'Pause monitoring'));
  assert((await storedMonitor())?.enabled === false, 'successful pause flips enabled in storage');
  assert(queryAlert(container) === null, 'successful pause shows no error');
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await monitorsItem.setValue([]);
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => {}} />);
  await openMenu(container);
  await click(menuItem(container, 'Rename'));
  const input = document.querySelector('input[placeholder="example.com"]') as HTMLInputElement | null;
  await setInputValue(input!, 'Renamed Monitor');
  const save = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save');
  await click(save ?? null);
  assert((await storedMonitor())?.name === 'Renamed Monitor', 'successful rename persists');
  assert(queryAlert(container) === null, 'successful rename shows no error');
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await monitorsItem.setValue([]);
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const { container, root } = await render(<MonitorDetail monitorId="m3-1" onDeleted={() => {}} />);
  await click(container.querySelector('button[aria-label="Alert condition"]'));
  await click(
    Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((b) =>
      b.textContent?.includes('Value decreases'),
    ) ?? null,
  );
  assert((await storedMonitor())?.alertCondition?.type === 'decrease', 'successful condition save persists');
  assert(queryAlert(container) === null, 'successful condition save shows no error');
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await monitorsItem.setValue([]);
}

console.log('\nAll mutation failure/rollback tests finished.');
