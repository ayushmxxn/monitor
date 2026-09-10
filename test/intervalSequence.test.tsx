/**
 * Finding 6: a failed settings write must prevent the second interval
 * write. Rendering the real PanelSettings: changing the check interval
 * saves settings first and only rewrites every monitor on success.
 */
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { monitorsItem, settingsItem } from '../lib/storage/items';

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
const { PanelSettings } = await import('../components/panel/PanelSettings');

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

function seedMonitor(): any {
  return {
    id: 'int-1',
    name: 'Interval Monitor',
    url: 'https://example.com/item',
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 30,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: null,
    lastValue: null,
    lastSemanticValue: null,
    lastStatus: 'idle',
    lastError: null,
    lastDiagnosticCode: null,
    checkStrategy: null,
    consecutiveFailures: 0,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 0,
    lastFingerprintUpdateAt: null,
    stats: null,
  };
}

async function changeInterval(container: ParentNode, minutes: number) {
  const select = container.querySelector('select#panel-default-interval') as HTMLSelectElement | null;
  assert(!!select, 'interval select exists');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, String(minutes));
    select!.dispatchEvent(new window.Event('change', { bubbles: true }));
    await sleep(50);
  });
  await act(async () => {
    await sleep(50);
  });
}

async function storedInterval(): Promise<number | null> {
  const list = (await monitorsItem.getValue()) as any[];
  return list.find((m) => m.id === 'int-1')?.intervalMinutes ?? null;
}

async function storedDefault(): Promise<number | null> {
  const settings = (await settingsItem.getValue()) as any;
  return settings?.defaultIntervalMinutes ?? null;
}

section('Finding 6: failed settings write blocks the interval rewrite');

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const local = (globalThis as any).chrome.storage.local;
  const origSet = local.set;
  local.set = async () => {
    throw new Error('quota exceeded');
  };
  try {
    const { container, root } = await render(<PanelSettings />);
    await changeInterval(container, 60);
    assert((await storedDefault()) === 30, 'failed settings write reverts the displayed default');
    assert((await storedInterval()) === 30, 'failed settings write prevents the monitor rewrite');
    await unmount(container, root);
  } finally {
    local.set = origSet;
    await monitorsItem.setValue([]);
  }
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  try {
    const { container, root } = await render(<PanelSettings />);
    await changeInterval(container, 60);
    assert((await storedDefault()) === 60, 'successful change persists the new default');
    assert((await storedInterval()) === 60, 'successful change rewrites monitor intervals');
    await unmount(container, root);
  } finally {
    await monitorsItem.setValue([]);
  }
}

console.log('\nAll interval sequencing tests finished.');
