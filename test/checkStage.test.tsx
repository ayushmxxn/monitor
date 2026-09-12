import './mockBrowser';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { CHECK_STAGES, getCheckStageText } from '@/hooks/useCheckStage';
import { MonitorCard } from '@/components/monitors/MonitorCard';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n--- ${name} ---`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupDom(): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com',
    pretendToBeVisual: true,
  });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).navigator = dom.window.navigator;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).Element = dom.window.Element;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

async function renderComponent(element: React.ReactElement): Promise<{
  container: HTMLDivElement;
  rerender: (el: React.ReactElement) => Promise<void>;
  teardown: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    rerender: async (el: React.ReactElement) => {
      await act(async () => {
        root.render(el);
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

section('1. Check stage progression model and text');
{
  assert(CHECK_STAGES.length === 5, 'defines 5 progressive check stages');
  assert(CHECK_STAGES[0].text === 'Connecting…', 'stage 1 is Connecting…');
  assert(CHECK_STAGES[1].text === 'Loading page…', 'stage 2 is Loading page…');
  assert(CHECK_STAGES[2].text === 'Finding value…', 'stage 3 is Finding value…');
  assert(CHECK_STAGES[3].text === 'Checking value…', 'stage 4 is Checking value…');
  assert(CHECK_STAGES[4].text === 'Almost there…', 'stage 5 is Almost there…');

  assert(getCheckStageText(0) === 'Connecting…', '0ms matches Connecting…');
  assert(getCheckStageText(799) === 'Connecting…', '799ms matches Connecting…');
  assert(getCheckStageText(800) === 'Loading page…', '800ms matches Loading page…');
  assert(getCheckStageText(2199) === 'Loading page…', '2199ms matches Loading page…');
  assert(getCheckStageText(2200) === 'Finding value…', '2200ms matches Finding value…');
  assert(getCheckStageText(4199) === 'Finding value…', '4199ms matches Finding value…');
  assert(getCheckStageText(4200) === 'Checking value…', '4200ms matches Checking value…');
  assert(getCheckStageText(6499) === 'Checking value…', '6499ms matches Checking value…');
  assert(getCheckStageText(6500) === 'Almost there…', '6500ms matches Almost there…');
  assert(getCheckStageText(15000) === 'Almost there…', '15000ms stays on Almost there…');
}

section('2. MonitorStatusBadge renders check stage text');
{
  setupDom();
  const { container, rerender, teardown } = await renderComponent(
    <MonitorStatusBadge status="checking" stageText="Connecting…" />
  );

  assert(
    container.textContent?.includes('Connecting…') === true,
    'MonitorStatusBadge displays Connecting…'
  );
  assert(
    container.querySelector('.animate-spin') !== null,
    'MonitorStatusBadge displays spinner'
  );

  await rerender(<MonitorStatusBadge status="checking" stageText="Finding value…" />);
  assert(
    container.textContent?.includes('Finding value…') === true,
    'MonitorStatusBadge updates to Finding value…'
  );

  await rerender(<MonitorStatusBadge status="unchanged" stageText={null} />);
  assert(
    container.textContent?.includes('Unchanged') === true,
    'MonitorStatusBadge immediately shows Unchanged when check succeeds'
  );
  assert(
    container.querySelector('.animate-spin') === null,
    'Spinner immediately removed when check succeeds'
  );

  await teardown();
}

section('3. MonitorCard loading state for new monitor and progression');
{
  setupDom();
  const newMonitor = {
    id: 'm-new-stage',
    name: 'New Monitor',
    url: 'https://example.com',
    target: { selector: '#val' },
    strategy: null,
    intervalMinutes: 15,
    lastValue: null,
    lastSemanticValue: null,
    lastCheckedAt: null,
    lastStatus: 'idle',
    lastError: null,
    lastDiagnosticCode: null,
    consecutiveFailures: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    enabled: true,
    alertCondition: null,
  };

  const { container, rerender, teardown } = await renderComponent(
    <MonitorCard monitor={newMonitor as any} onDelete={async () => true} onOpen={() => {}} />
  );

  assert(
    container.querySelector('[aria-label="Loading initial value"]') !== null,
    'New monitor shows subtle loading skeleton'
  );
  assert(
    container.textContent?.includes('Connecting…') === true,
    'New monitor starts with Connecting… stage text'
  );

  // Wait past first stage threshold (800ms)
  await act(async () => {
    await sleep(850);
  });

  assert(
    container.querySelector('[data-testid="value-scanner"]') !== null,
    'New monitor shows ValueScanner scanning animation at top'
  );
  assert(
    container.querySelector('.animate-spin') !== null,
    'Bottom status line retains circular spinner'
  );

  assert(
    container.textContent?.includes('Loading page…') === true,
    'New monitor progresses to Loading page… stage'
  );

  // First check succeeds -> immediately removed
  await rerender(
    <MonitorCard
      monitor={{
        ...newMonitor,
        lastValue: '42',
        lastCheckedAt: Date.now(),
        lastStatus: 'ok',
      } as any}
      onDelete={async () => true}
      onOpen={() => {}}
    />
  );

  assert(
    container.querySelector('[aria-label="Loading initial value"]') === null,
    'Loading skeleton removed immediately on success'
  );
  assert(
    container.textContent?.includes('42') === true,
    'Value 42 is visible immediately on success'
  );
  assert(
    container.textContent?.includes('Connecting…') === false &&
      container.textContent?.includes('Loading page…') === false,
    'Check stage text removed immediately on success'
  );

  await teardown();
}

section('4. MonitorCard keeps last known value visible for existing monitor');
{
  setupDom();
  const existingMonitor = {
    id: 'm-existing',
    name: 'Existing Monitor',
    url: 'https://example.com',
    target: { selector: '#val' },
    strategy: null,
    intervalMinutes: 15,
    lastValue: '$99.00',
    lastSemanticValue: null,
    lastCheckedAt: Date.now() - 30_000,
    lastStatus: 'checking',
    lastError: null,
    lastDiagnosticCode: null,
    consecutiveFailures: 0,
    createdAt: Date.now() - 3600_000,
    updatedAt: Date.now() - 30_000,
    enabled: true,
    alertCondition: null,
  };

  const { container, rerender, teardown } = await renderComponent(
    <MonitorCard monitor={existingMonitor as any} onDelete={async () => true} onOpen={() => {}} />
  );

  assert(
    container.textContent?.includes('$99') === true,
    'Last known value $99 remains visible while checking'
  );
  assert(
    container.textContent?.includes('Connecting…') === true,
    'Existing monitor shows Connecting… stage in status line'
  );
  assert(
    container.querySelector('[data-testid="value-scanner"]') !== null,
    'Existing monitor shows ValueScanner beside value while checking'
  );

  // Check completes with error
  await rerender(
    <MonitorCard
      monitor={{
        ...existingMonitor,
        lastStatus: 'error',
        lastDiagnosticCode: 'NETWORK_ERROR',
        lastError: 'Failed to connect',
      } as any}
      onDelete={async () => true}
      onOpen={() => {}}
    />
  );

  assert(
    container.textContent?.includes('$99') === true,
    'Last known value $99 remains visible even on check error'
  );
  assert(
    container.textContent?.includes('Connecting…') === false,
    'Stage text removed immediately on error'
  );
  assert(
    container.querySelector('[data-testid="value-scanner"]') === null,
    'ValueScanner removed immediately when check completes with error'
  );

  await teardown();
}

console.log('\nAll check stage tests passed successfully!');
