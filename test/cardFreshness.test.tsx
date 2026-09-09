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
      r.render(<MonitorCard monitor={seedMonitor()} onDelete={() => {}} onOpen={() => {}} />);
    });
    return { container: c, root: r };
  })();
  const text = container.textContent ?? '';
  assert(text.includes('$10.00'), 'healthy card shows the value');
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
    r.render(<MonitorCard monitor={failing} onDelete={() => {}} onOpen={() => {}} />);
  });
  const text = c.textContent ?? '';
  assert(text.includes('$10.00'), 'failing card preserves the last successful value exactly');
  assert(text.includes('Updated'), 'failing card keeps the timestamp');
  assert(text.includes('retrying'), 'failing card indicates the value is stale/retrying');

  // Recovery: consecutiveFailures back to 0 restores normal freshness.
  await act(async () => {
    r.render(<MonitorCard monitor={seedMonitor()} onDelete={() => {}} onOpen={() => {}} />);
    await sleep(20);
  });
  const recovered = c.textContent ?? '';
  assert(recovered.includes('$10.00'), 'recovered card still shows the value');
  assert(!recovered.includes('retrying'), 'recovery restores normal freshness automatically');
  await act(async () => {
    r.unmount();
  });
  c.remove();
}

console.log('\nAll card freshness tests finished.');
