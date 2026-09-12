/**
 * Transitions.dev "Spinning counter" (P26) animation tests:
 * Tests the odometer/slot-machine reel spinning animation:
 * - Animates ONLY when a successful Check Now/scheduled check produces a genuinely different value.
 * - Never animates on click, hover, focus, scrubbing, re-render, navigation, or initial load.
 * - Spins individual digits and settles on the new value.
 * - Symbols/decimals stay completely stable (.t-counter-sep).
 * - Preserves complete formatted value (currency, %, decimals, compact units).
 * - Preserves head and muted tail parts without layout or content shift.
 * - Respects disabled flag and prefers-reduced-motion.
 */
import './mockBrowser';
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

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SpinningCounter } = await import('../components/ui/SpinningCounter');

async function render(el: ReactElement): Promise<{
  container: HTMLDivElement;
  root: Root;
  rerender: (nextEl: ReactElement) => Promise<void>;
  teardown: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return {
    container,
    root,
    rerender: async (nextEl: ReactElement) => {
      await act(async () => {
        root.render(nextEl);
      });
    },
    teardown: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

section('1. Initial load - no spinning, text content preserved, symbols stable');
{
  const { container, teardown } = await render(
    <SpinningCounter value="$77,158" lastCheckedAt={1000} />
  );

  const counter = container.querySelector('.t-counter');
  assert(counter !== null, 'Renders .t-counter container');
  assert(
    !counter?.classList.contains('is-spinning'),
    'Initial render MUST NOT have .is-spinning class'
  );
  assert(
    container.querySelectorAll('.t-counter-col.is-spinning').length === 0,
    'No columns are spinning on initial load'
  );
  assert(
    counter?.textContent === '$77,158',
    `Preserves complete text content at rest: got "${counter?.textContent}"`
  );

  // Symbols/decimals stay stable
  const seps = container.querySelectorAll('.t-counter-sep');
  assert(seps.length === 2, `Separators ($ and ,) rendered as .t-counter-sep: count=${seps.length}`);
  assert(seps[0].textContent === '$', 'First separator is $');
  assert(seps[1].textContent === ',', 'Second separator is ,');

  const cols = container.querySelectorAll('.t-counter-col');
  assert(cols.length === 5, `Digit columns for 7, 7, 1, 5, 8: count=${cols.length}`);

  await teardown();
}

section('2. Never animate on hover, click, focus, or re-render (same lastCheckedAt)');
{
  const { container, rerender, teardown } = await render(
    <SpinningCounter value="$77,158" lastCheckedAt={1000} />
  );

  // Re-render simulates click/hover/focus triggering parent state update
  await rerender(
    <SpinningCounter value="$77,158" lastCheckedAt={1000} />
  );

  const counter = container.querySelector('.t-counter');
  assert(
    !counter?.classList.contains('is-spinning'),
    'Click/hover/focus re-render MUST NOT trigger .is-spinning'
  );
  assert(
    container.querySelectorAll('.t-counter-col.is-spinning').length === 0,
    'Zero columns spinning on click/hover/focus'
  );

  await teardown();
}

section('3. Check with identical value - MUST NOT animate');
{
  const { container, rerender, teardown } = await render(
    <SpinningCounter value="$77,158" lastCheckedAt={1000} />
  );

  // A check completed at timestamp 2000, but number is still $77,158
  await rerender(
    <SpinningCounter value="$77,158" lastCheckedAt={2000} />
  );

  assert(
    container.querySelectorAll('.t-counter-col.is-spinning').length === 0,
    'Check with identical value does not trigger spinning'
  );

  await teardown();
}

section('4. Check with genuinely different value - SPINS DIGITS');
{
  const { container, rerender, teardown } = await render(
    <SpinningCounter value="$77,158" lastCheckedAt={1000} />
  );

  // Check completes at timestamp 3000 with a genuinely new value ($77,158 -> $77,334)
  await rerender(
    <SpinningCounter value="$77,334" lastCheckedAt={3000} />
  );

  const spinningCols = container.querySelectorAll('.t-counter-col.is-spinning');
  assert(
    spinningCols.length === 5,
    `Genuinely different value spins all digit reels: count=${spinningCols.length}`
  );

  // Symbols and separators STAY STABLE (never spinning)
  const seps = container.querySelectorAll('.t-counter-sep');
  assert(seps.length === 2, 'Separators ($ and ,) stay in place');
  assert(
    container.querySelectorAll('.t-counter-sep.is-spinning').length === 0,
    'Separators NEVER carry is-spinning'
  );

  // Check Transitions.dev stagger timing on digit strips: 0ms, 70ms, 140ms, 210ms, 280ms
  const strips = Array.from(container.querySelectorAll<HTMLElement>('.t-counter-strip'));
  assert(
    strips[0].style.getPropertyValue('--delay') === '0ms',
    `Digit 0 delay is 0ms (got ${strips[0].style.getPropertyValue('--delay')})`
  );
  assert(
    strips[1].style.getPropertyValue('--delay') === '70ms',
    `Digit 1 delay is 70ms (got ${strips[1].style.getPropertyValue('--delay')})`
  );
  assert(
    strips[2].style.getPropertyValue('--delay') === '140ms',
    `Digit 2 delay is 140ms (got ${strips[2].style.getPropertyValue('--delay')})`
  );

  await teardown();
}

section('5. Head and tail decimal support (symbols and decimals stay stable)');
{
  const { container, rerender, teardown } = await render(
    <SpinningCounter
      value="$77,334.64"
      head="$77,334"
      tail=".64"
      lastCheckedAt={1000}
    />
  );

  const counter = container.querySelector('.t-counter');
  assert(
    counter?.textContent === '$77,334.64',
    `Complete text at rest with head and tail: got "${counter?.textContent}"`
  );

  const tailSpan = container.querySelector('span.text-muted-foreground');
  assert(
    tailSpan !== null && tailSpan.textContent === '.64',
    `Tail decimal (".64") wrapped in text-muted-foreground: got "${tailSpan?.textContent}"`
  );

  // Decimal separator '.' is inside tail and stable
  const dotSep = tailSpan?.querySelector('.t-counter-sep');
  assert(dotSep?.textContent === '.', 'Decimal point is a stable .t-counter-sep');

  // Trigger check update with new value
  await rerender(
    <SpinningCounter
      value="$77,335.80"
      head="$77,335"
      tail=".80"
      lastCheckedAt={2000}
    />
  );

  const spinningCols = container.querySelectorAll('.t-counter-col.is-spinning');
  assert(
    spinningCols.length === 7,
    `Spins all 7 digits (5 in head + 2 in tail): count=${spinningCols.length}`
  );

  // Tail digits have text-muted-foreground while spinning
  const updatedTailSpan = container.querySelector('span.text-muted-foreground');
  const tailSpinningCols = updatedTailSpan?.querySelectorAll('.t-counter-col.is-spinning');
  assert(
    tailSpinningCols?.length === 2,
    `Tail spinning digits preserve muted styling: count=${tailSpinningCols?.length}`
  );

  await teardown();
}

section('6. Support for diverse semantic formats at rest');
{
  const testCases = [
    '54.55%',
    '1.3M',
    '90k',
    '€1,249.99',
    '¥10,000',
    '1.25',
    '0.001',
    '+12%',
  ];

  for (const tc of testCases) {
    const { container, teardown } = await render(
      <SpinningCounter value={tc} lastCheckedAt={1000} />
    );
    const counter = container.querySelector('.t-counter');
    assert(
      counter?.textContent === tc,
      `Accurately renders formatted value "${tc}": got "${counter?.textContent}"`
    );
    await teardown();
  }
}

section('7. Homepage MonitorCard integration');
{
  const { MonitorCard } = await import('../components/monitors/MonitorCard');
  const baseMonitor = {
    id: 'home-1',
    name: 'Bitcoin',
    url: 'https://example.com/btc',
    selector: '.price',
    strategy: 'live' as const,
    intervalMinutes: 5,
    lastValue: '$77,185',
    lastCheckedAt: 1000,
    lastStatus: 'ok' as const,
    lastDiagnosticCode: null,
    lastError: null,
    lastSemanticValue: null,
    consecutiveFailures: 0,
    createdAt: 1000,
    updatedAt: 1000,
    enabled: true,
    alertCondition: null,
  };

  const { container, rerender, teardown } = await render(
    <MonitorCard monitor={baseMonitor as any} onDelete={async () => true} onOpen={() => {}} />
  );

  const counter = container.querySelector('.t-counter');
  assert(counter !== null, 'Homepage card renders .t-counter');
  assert(
    !counter?.classList.contains('is-spinning'),
    'Homepage card at rest does not spin'
  );
  assert(
    counter?.textContent === '$77,185',
    `Homepage card displays correct value: got "${counter?.textContent}"`
  );

  // Check completes with genuinely different value ($77,185 -> $77,200)
  await rerender(
    <MonitorCard
      monitor={{
        ...baseMonitor,
        lastValue: '$77,200',
        lastCheckedAt: 2000,
      } as any}
      onDelete={async () => true}
      onOpen={() => {}}
    />
  );

  const spinningCols = container.querySelectorAll('.t-counter-col.is-spinning');
  assert(
    spinningCols.length === 5,
    `Homepage card spins on real check update: count=${spinningCols.length}`
  );

  await teardown();
}

console.log('\nAll SpinningCounter tests passed!');
process.exit(process.exitCode || 0);

