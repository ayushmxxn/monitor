/**
 * M4: the card's freshness status must stay honest across temporary
 * check failures. The last successful value is preserved as-is; only
 * the timestamp line gains a subtle retrying indication while
 * consecutiveFailures > 0, derived purely from persisted state so
 * recovery restores the normal status automatically.
 */
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';

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
  g.browser = { runtime: { id: 'test-id' } };
  return dom;
}

// Prime the first document and select React's native input path before
// react-dom evaluates (shared registry across test files in one run).
setupDom();
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MonitorCard } = await import('../components/monitors/MonitorCard');

function seedMonitor(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'm4-1',
    name: 'M4 Monitor',
    url: 'https://example.com/item',
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 30,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: Date.now() - 120_000,
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
    ...overrides,
  };
}

section('M4: card freshness stays honest across temporary failures');

{
  setupDom();
  const { container, root } = await (async () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const r = createRoot(c);
    await act(async () => {
      r.render(<MonitorCard monitor={seedMonitor()} onDelete={async () => true} onOpen={() => {}} />);
    });
    return { container: c, root: r };
  })();
  const text = container.textContent ?? '';
  assert(text.includes('$10'), 'healthy card shows the value');
  assert(text.includes('Updated'), 'healthy card shows normal freshness');
  assert(!text.includes('retrying'), 'healthy card shows no retrying hint');
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

{
  setupDom();
  const failing = seedMonitor({
    consecutiveFailures: 2,
    lastError: 'The page could not be reached due to a connection or network error.',
    lastDiagnosticCode: 'NETWORK_ERROR',
  });
  const c = document.createElement('div');
  document.body.appendChild(c);
  const r = createRoot(c);
  await act(async () => {
    r.render(<MonitorCard monitor={failing} onDelete={async () => true} onOpen={() => {}} />);
  });
  const text = c.textContent ?? '';
  assert(text.includes('$10'), 'failing card preserves the last successful value exactly');
  assert(text.includes('Updated'), 'failing card keeps the timestamp');
  assert(!text.includes('retrying'), 'failing card does not clutter with retrying text');

  // Recovery: consecutiveFailures back to 0 restores normal freshness.
  await act(async () => {
    r.render(<MonitorCard monitor={seedMonitor()} onDelete={async () => true} onOpen={() => {}} />);
    await sleep(20);
  });
  const recovered = c.textContent ?? '';
  assert(recovered.includes('$10'), 'recovered card still shows the value');
  assert(!recovered.includes('retrying'), 'recovery restores normal freshness automatically');
  await act(async () => {
    r.unmount();
  });
  c.remove();
}

section('M5: home card renders the canonical value exactly as the detail view');

{
  // Production mismatch: a check storing lastValue "1,651" showed
  // "1.7k" on the home card while the detail view showed "1,651" for
  // the same check. Root cause was presentational, not state: the card
  // passed lastValue through lossy adaptive compaction
  // (formatAdaptiveValue: 1651 -> "1.7k") while the detail view renders
  // the raw canonical lastValue. Same stored value, same timestamp —
  // two different strings. The card now renders the raw lastValue, so
  // both surfaces always agree; formatting rules themselves
  // (lib/monitors/formatValue.ts) are untouched.
  setupDom();
  const m = seedMonitor({
    id: 'm5-1',
    name: 'M5 Monitor',
    lastValue: '1,651',
    lastSemanticValue: { type: 'number', normalized: 1651, unit: null, raw: '1,651' },
    lastStatus: 'unchanged',
    lastCheckedAt: Date.now(),
  });
  const c = document.createElement('div');
  document.body.appendChild(c);
  const r = createRoot(c);
  await act(async () => {
    r.render(<MonitorCard monitor={m} onDelete={async () => true} onOpen={() => {}} />);
  });

  const counter = () => c.querySelector('.t-counter');
  assert(counter() !== null, 'card renders the value counter');
  assert(
    counter()?.textContent === '1,651',
    `card shows the canonical "1,651", not the compacted "1.7k" (got "${counter()?.textContent}")`,
  );
  assert(
    (counter()?.textContent ?? '').includes('1.7k') === false,
    'card never shows lossy compact form of the current value',
  );

  // A completed check with a new value flows straight through: update
  // both value and timestamp (as recordSuccess does atomically), let
  // the spin settle, and the exact new value must be showing.
  await act(async () => {
    r.render(
      <MonitorCard
        monitor={{ ...m, lastValue: '1,652', lastCheckedAt: Date.now() }}
        onDelete={async () => true}
        onOpen={() => {}}
      />,
    );
  });
  await act(async () => {
    await sleep(2100);
  });
  assert(
    counter()?.textContent === '1,652',
    `card settles on the exact updated value after a check (got "${counter()?.textContent}")`,
  );

  // Navigation/reload (same state, fresh mount, no new check): the
  // canonical value renders immediately with no animation dependency.
  await act(async () => {
    r.unmount();
  });
  c.remove();
  const c2 = document.createElement('div');
  document.body.appendChild(c2);
  const r2 = createRoot(c2);
  await act(async () => {
    r2.render(
      <MonitorCard
        monitor={{ ...m, lastValue: '1,652' }}
        onDelete={async () => true}
        onOpen={() => {}}
      />,
    );
  });
  assert(
    c2.querySelector('.t-counter')?.textContent === '1,652',
    `fresh mount (reload) shows the canonical value immediately (got "${c2.querySelector('.t-counter')?.textContent}")`,
  );
  await act(async () => {
    r2.unmount();
  });
  c2.remove();
}

console.log('\nAll card freshness tests finished.');
