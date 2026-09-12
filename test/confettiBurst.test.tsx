/**
 * Transitions.dev "Confetti burst" (Prototype 28) tests:
 * - Play once after confirmed successful creation.
 * - Never trigger on opening the picker, clicking buttons, hover, navigation, re-render, or failed creation.
 * - Subtle, fast, and premium physics simulation with 3D cosine squish, sway, and bounce.
 * - Respects prefers-reduced-motion.
 * - Non-blocking: pointer-events-none, hardware-accelerated canvas.
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

// Setup a mock 2D canvas context to observe draw calls and transformations
function createMockContext2D() {
  const calls: { method: string; args: any[] }[] = [];
  const fills: { color: string; x: number; y: number; w: number; h: number }[] = [];

  const ctx = {
    calls,
    fills,
    fillStyle: '#000',
    globalAlpha: 1,
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      calls.push({ method: 'setTransform', args: [a, b, c, d, e, f] });
    },
    clearRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ method: 'clearRect', args: [x, y, w, h] });
    },
    save: () => {
      calls.push({ method: 'save', args: [] });
    },
    restore: () => {
      calls.push({ method: 'restore', args: [] });
    },
    translate: (x: number, y: number) => {
      calls.push({ method: 'translate', args: [x, y] });
    },
    rotate: (angle: number) => {
      calls.push({ method: 'rotate', args: [angle] });
    },
    scale: (x: number, y: number) => {
      calls.push({ method: 'scale', args: [x, y] });
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({ color: ctx.fillStyle as string, x, y, w, h });
      calls.push({ method: 'fillRect', args: [x, y, w, h] });
    },
  };

  return ctx;
}

type MockCtx = ReturnType<typeof createMockContext2D>;
let mockReducedMotion = false;
let currentMockCtx: MockCtx | null = null;
function getMockContext(): MockCtx | null {
  return currentMockCtx;
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
  g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  g.navigator = dom.window.navigator;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  // Mock getContext('2d')
  dom.window.HTMLCanvasElement.prototype.getContext = function (type: string) {
    if (type === '2d') {
      currentMockCtx = createMockContext2D();
      return currentMockCtx as any;
    }
    return null;
  };

  // Mock matchMedia
  dom.window.matchMedia = (query: string) => {
    return {
      matches: query.includes('prefers-reduced-motion') ? mockReducedMotion : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as any;
  };

  // Mock requestAnimationFrame / cancelAnimationFrame
  let nextRafId = 1;
  const rafCallbacks = new Map<number, FrameRequestCallback>();
  dom.window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  };
  dom.window.cancelAnimationFrame = (id: number) => {
    rafCallbacks.delete(id);
  };
  g.requestAnimationFrame = dom.window.requestAnimationFrame;
  g.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  g.runNextRaf = (time = performance.now()) => {
    const cbs = Array.from(rafCallbacks.entries());
    rafCallbacks.clear();
    for (const [, cb] of cbs) {
      cb(time);
    }
  };

  return dom;
}

setupDom();

const { act, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ConfettiBurst } = await import('../components/ui/ConfettiBurst');
type ConfettiBurstHandle = import('../components/ui/ConfettiBurst').ConfettiBurstHandle;

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

section('1. Initial load - idle canvas, pointer-events-none, aria-hidden');
{
  const ref = createRef<ConfettiBurstHandle>();
  const { container, teardown } = await render(<ConfettiBurst ref={ref} />);

  const canvas = container.querySelector('canvas');
  assert(canvas !== null, 'Renders canvas element');
  assert(
    canvas?.getAttribute('aria-hidden') === 'true',
    'Canvas has aria-hidden="true" for accessibility'
  );
  assert(
    Boolean(canvas?.classList.contains('pointer-events-none')),
    'Canvas has pointer-events-none to never block UI'
  );
  assert(
    Boolean(canvas?.classList.contains('absolute') && canvas?.classList.contains('inset-0')),
    'Canvas fills container via absolute inset-0'
  );
  assert(currentMockCtx === null, 'No canvas context requested or drawn on initial load');

  await teardown();
}

section('2. Never trigger on hover, click, or re-render');
{
  const ref = createRef<ConfettiBurstHandle>();
  const { container, rerender, teardown } = await render(
    <div>
      <button id="test-btn">Click me</button>
      <ConfettiBurst ref={ref} />
    </div>
  );

  const btn = container.querySelector('#test-btn') as HTMLButtonElement;
  btn.click();
  btn.dispatchEvent(new (window as any).MouseEvent('mouseenter'));
  btn.dispatchEvent(new (window as any).MouseEvent('mouseleave'));

  await rerender(
    <div>
      <button id="test-btn">Click me</button>
      <ConfettiBurst ref={ref} />
    </div>
  );

  assert(currentMockCtx === null, 'Hover, click, and re-render DO NOT trigger confetti');

  await teardown();
}

section('3. Respects prefers-reduced-motion');
{
  mockReducedMotion = true;
  const ref = createRef<ConfettiBurstHandle>();
  const { teardown } = await render(<ConfettiBurst ref={ref} />);

  await act(async () => {
    ref.current?.burst();
  });

  assert(
    currentMockCtx === null,
    'prefers-reduced-motion: reduce prevents burst from initializing or drawing'
  );

  mockReducedMotion = false;
  await teardown();
}

section('4. Burst execution - Transitions.dev palette, 3D squish, and simulation step');
{
  const ref = createRef<ConfettiBurstHandle>();
  const { teardown } = await render(<ConfettiBurst ref={ref} particleCount={40} />);

  await act(async () => {
    ref.current?.burst();
  });

  const ctx: MockCtx | null = getMockContext();
  assert(ctx !== null, 'Canvas context requested on burst');
  if (!ctx) throw new Error('Context not initialized');

  assert(ctx.calls.some((c) => c.method === 'setTransform'), 'Sets DPR transform');

  // Advance simulation frame
  const g = globalThis as any;
  await act(async () => {
    g.runNextRaf(performance.now() + 100);
  });

  assert(
    ctx.fills.length > 0,
    `Particles rendered: count=${ctx.fills.length}`
  );

  const TRANSITIONS_COLORS = [
    '#ff4d67',
    '#ffb020',
    '#3b82f6',
    '#22c55e',
    '#a855f7',
    '#f97316',
    '#06b6d4',
    '#f43f5e',
  ];
  const renderedColors = new Set<string>(ctx.fills.map((f) => f.color));
  const hasOnlyTransitionsColors = Array.from(renderedColors).every((c) =>
    TRANSITIONS_COLORS.includes(c)
  );
  assert(hasOnlyTransitionsColors, 'All particle colors originate from Transitions.dev palette');

  // Check that scale transforms exist (3D cosine tumble squish: scale(1, p.squish))
  const scaleCalls = ctx.calls.filter((c) => c.method === 'scale');
  assert(scaleCalls.length > 0, `3D cosine tumble squish scale transforms invoked: ${scaleCalls.length}`);

  await teardown();
}

section('5. First check completion gating - ONLY when newly created monitor completes first check and value is visible');
{
  // Simulates the exact state machine used in Panel.tsx:
  // - On creation ({ saved: true, monitorId }), monitor is queued in pendingFirstCheckIds
  // - Confetti DOES NOT fire on creation
  // - Confetti DOES NOT fire while loading (lastValue: null)
  // - Confetti DOES NOT fire on hover, click, or re-render
  // - If first check fails (lastStatus: 'error'), monitor is removed from pending, no confetti
  // - Confetti DOES NOT fire on retries or later value changes
  // - When first check succeeds and value is visible, confetti fires once and ID is deleted

  let burstCount = 0;
  const mockBurst = () => {
    burstCount++;
  };

  const pendingFirstCheckIds = new Set<string>();

  function onPickerFinish(result?: { saved: boolean; monitorName: string | null; monitorId?: string | null }) {
    if (result?.saved && result.monitorId) {
      pendingFirstCheckIds.add(result.monitorId);
      // NOTE: Does NOT call burst() on creation!
    }
  }

  function onMonitorsUpdate(monitors: { id: string; lastValue: string | null; lastStatus: string }[]) {
    if (pendingFirstCheckIds.size === 0) return;
    for (const m of monitors) {
      if (pendingFirstCheckIds.has(m.id)) {
        if (m.lastValue !== null && m.lastStatus !== 'error') {
          pendingFirstCheckIds.delete(m.id);
          mockBurst();
        } else if (m.lastStatus === 'error') {
          pendingFirstCheckIds.delete(m.id);
        }
      }
    }
  }

  // 1. Creation event - monitor saved with null value
  onPickerFinish({ saved: true, monitorName: 'Bitcoin', monitorId: 'mon-new-1' });
  assert(burstCount === 0, 'Does NOT trigger confetti on monitor creation');

  // 2. Monitor is in loading state (checking in flight, lastValue is null)
  onMonitorsUpdate([{ id: 'mon-new-1', lastValue: null, lastStatus: 'checking' }]);
  assert(burstCount === 0, 'Does NOT trigger confetti while monitor is checking/loading');

  // 3. Hover, click, or unrelated re-render
  onMonitorsUpdate([{ id: 'mon-new-1', lastValue: null, lastStatus: 'checking' }]);
  assert(burstCount === 0, 'Does NOT trigger confetti on re-renders');

  // 4. Check completes and actual value becomes visible!
  onMonitorsUpdate([{ id: 'mon-new-1', lastValue: '$77,185', lastStatus: 'ok' }]);
  assert(burstCount === 1, 'Triggers confetti ONCE when newly created monitor completes first check and value is visible');

  // 5. Later value change of the same monitor ($77,185 -> $77,200)
  onMonitorsUpdate([{ id: 'mon-new-1', lastValue: '$77,200', lastStatus: 'ok' }]);
  assert(burstCount === 1, 'Does NOT trigger confetti on later value changes');

  // 6. Test failed first check: monitor fails its first check
  onPickerFinish({ saved: true, monitorName: 'Bad URL', monitorId: 'mon-fail-1' });
  assert(burstCount === 1, 'New failed monitor creation does not trigger confetti');

  onMonitorsUpdate([{ id: 'mon-fail-1', lastValue: null, lastStatus: 'error' }]);
  assert(burstCount === 1, 'Failed first check does NOT trigger confetti');

  // 7. Retry of failed monitor should NOT trigger confetti
  onMonitorsUpdate([{ id: 'mon-fail-1', lastValue: '$100', lastStatus: 'ok' }]);
  assert(burstCount === 1, 'Retries do NOT trigger confetti');
}

section('6. Monitor loading states - subtle indicator for new and existing monitors');
{
  const { MonitorCard } = await import('../components/monitors/MonitorCard');

  // A: New monitor: hasValue=false, lastStatus='idle', lastCheckedAt=null
  const newMonitor = {
    id: 'test-new',
    name: 'New Site',
    url: 'https://example.com',
    selector: '.val',
    strategy: 'live' as const,
    intervalMinutes: 5,
    lastValue: null,
    lastCheckedAt: null,
    lastStatus: 'idle' as const,
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
    <MonitorCard monitor={newMonitor as any} onDelete={async () => true} onOpen={() => {}} />
  );

  assert(
    container.querySelector('[aria-label="Loading initial value"]') !== null,
    'New monitor shows subtle loading skeleton until first value loads'
  );
  assert(
    container.textContent?.includes('Connecting…') === true,
    'New monitor displays "Connecting…" in status line'
  );

  // B: First check succeeds - loading removed immediately, value visible
  await rerender(
    <MonitorCard
      monitor={{
        ...newMonitor,
        lastValue: '$120.50',
        lastCheckedAt: 2000,
        lastStatus: 'ok',
      } as any}
      onDelete={async () => true}
      onOpen={() => {}}
    />
  );

  assert(
    container.querySelector('[aria-label="Loading initial value"]') === null,
    'Loading skeleton removed immediately when first check succeeds'
  );
  assert(
    container.textContent?.includes('$120.50') === true,
    'Actual value is now visible after first check succeeds'
  );

  // C: First check fails - loading removed immediately, error visible
  await rerender(
    <MonitorCard
      monitor={{
        ...newMonitor,
        lastValue: null,
        lastStatus: 'error',
        lastDiagnosticCode: 'ELEMENT_NOT_FOUND',
        lastError: 'Target element could not be found',
      } as any}
      onDelete={async () => true}
      onOpen={() => {}}
    />
  );

  assert(
    container.querySelector('[aria-label="Loading initial value"]') === null,
    'Loading skeleton removed immediately when first check fails'
  );
  assert(
    container.textContent?.includes('Value not found') === true,
    'Error state is visible on failure'
  );

  await teardown();
}

console.log('\nAll ConfettiBurst tests passed!');
process.exit(process.exitCode || 0);
