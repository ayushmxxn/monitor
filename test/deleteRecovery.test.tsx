/**
 * Finding 2: list-view delete reports success honestly. A failed delete
 * resets the card fade (no blank gap) and useMonitors.remove returns
 * whether deletion actually succeeded.
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

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MonitorCard } = await import('../components/monitors/MonitorCard');
const { useMonitors } = await import('../hooks/useMonitors');

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

// Timers under test can fire later than their nominal delay in this
// environment - poll for the expected condition instead of fixed sleeps.
async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await act(async () => {
      await sleep(100);
    });
    try {
      if (fn()) return true;
    } catch {
      // Predicates may throw on missing nodes; keep polling.
    }
  }
  try {
    return fn();
  } catch {
    return false;
  }
}

function seedMonitor(): any {
  return {
    id: 'del-1',
    name: 'Delete Me',
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

async function storedIds(): Promise<string[]> {
  const list = (await monitorsItem.getValue()) as any[];
  return list.map((m) => m.id);
}

section('Finding 2: failed list delete restores the card');

{
  setupDom();
  let calls = 0;
  const { container, root } = await render(
    <MonitorCard
      monitor={seedMonitor()}
      onDelete={async () => {
        calls += 1;
        await sleep(20);
        return false;
      }}
      onOpen={() => {}}
    />,
  );
  await click(container.querySelector('button[aria-label="Delete Delete Me"]'));
  const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete');
  await click(confirm ?? null);
  assert(await waitFor(() => calls === 1), 'confirm invokes the delete once');
  assert(
    await waitFor(() => !container.firstElementChild?.classList.contains('opacity-0')),
    'failed delete resets the fade so the card stays visible',
  );
  await unmount(container, root);
}

{
  setupDom();
  let calls = 0;
  const { container, root } = await render(
    <MonitorCard
      monitor={seedMonitor()}
      onDelete={async () => {
        calls += 1;
        return true;
      }}
      onOpen={() => {}}
    />,
  );
  await click(container.querySelector('button[aria-label="Delete Delete Me"]'));
  const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete');
  await click(confirm ?? null);
  assert(await waitFor(() => calls === 1), 'successful delete still invokes removal once');
  assert(
    container.firstElementChild?.classList.contains('opacity-0') === true,
    'successful delete keeps the fade-out exactly as before',
  );
  await unmount(container, root);
}

section('Finding 2: useMonitors.remove reports the outcome');

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  const local = (globalThis as any).chrome.storage.local;
  const origSet = local.set;
  local.set = async () => {
    throw new Error('quota exceeded');
  };
  try {
    let result: boolean | null = null;
    function Probe() {
      const { remove } = useMonitors();
      const [status, setStatus] = useState('pending');
      return (
        <button
          onClick={() => {
            void remove('del-1').then((ok) => {
              result = ok;
              setStatus(ok ? 'removed' : 'failed');
            });
          }}
        >
          {status}
        </button>
      );
    }
    const { container, root } = await render(<Probe />);
    await click(container.querySelector('button'));
    await act(async () => {
      await sleep(50);
    });
    assert(result === false, 'remove returns false when storage rejects');
    assert(container.textContent === 'failed', 'failing remove is observable as failed');
    assert((await storedIds()).includes('del-1'), 'failed remove keeps the monitor in storage');
    await unmount(container, root);
  } finally {
    local.set = origSet;
    await monitorsItem.setValue([]);
  }
}

{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  let result: boolean | null = null;
  function Probe() {
    const { remove } = useMonitors();
    return (
      <button
        onClick={() => {
          void remove('del-1').then((ok) => {
            result = ok;
          });
        }}
      >
        go
      </button>
    );
  }
  const { container, root } = await render(<Probe />);
  await click(container.querySelector('button'));
  await act(async () => {
    await sleep(50);
  });
  assert(result === true, 'remove returns true on success');
  assert(!(await storedIds()).includes('del-1'), 'successful remove deletes the monitor');
  await unmount(container, root);
  await monitorsItem.setValue([]);
}

console.log('\nAll delete recovery tests finished.');
