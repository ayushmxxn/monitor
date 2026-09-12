/**
 * Value chart card: the history line is integrated into the monitor's
 * value card (large value, change underneath, clean trend line,
 * latest-point ring, bottom range pills), and scrubbing the chart
 * shows the exact hovered reading live in the header - snapping to
 * real recorded points, never interpolating - falling back to the
 * latest reading on leave.
 *
 * Covers presentation/interaction only - data collection, sampling,
 * range logic, and formatting are exercised by the existing
 * pipeline/chart suites. Repo console-assert style (see
 * checkNow.test.tsx): exits non-zero on any failed assertion.
 */
import './mockBrowser';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { monitorsItem, historyItem } from '../lib/storage/items';
import type { MonitorCheck } from '../lib/monitors/types';
import { formatDateTime } from '../lib/format';

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
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { HistoryChart, nearestPointIndex } = await import('../components/monitors/HistoryChart');
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

async function teardown(container: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

/** Newest-first numeric history like `useMonitorHistory` provides. */
function seedHistory(monitorId: string, values: number[], stepMs = 60 * 60 * 1000): MonitorCheck[] {
  const now = Date.now();
  return values.map((v, i) => ({
    id: `h-${i}`,
    monitorId,
    value: `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    semanticValue: { type: 'currency', normalized: v, unit: 'USD', raw: `$${v}` },
    checkedAt: now - i * stepMs,
    changed: i > 0,
    error: null,
    diagnosticCode: null,
    confidence: null,
    strategy: null,
  }));
}

function seedMonitor(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'vc-1',
    name: 'VC Monitor',
    url: 'https://example.com/item',
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 30,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: Date.now(),
    lastValue: '$58,834.75',
    lastSemanticValue: { type: 'currency', normalized: 58834.75, unit: 'USD', raw: '$58,834.75' },
    lastStatus: 'unchanged',
    lastError: null,
    lastDiagnosticCode: null,
    checkStrategy: null,
    consecutiveFailures: 0,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 8,
    lastFingerprintUpdateAt: null,
    stats: null,
    ...overrides,
  };
}

section('snap: scrubbing always lands on a real recorded point');
{
  const pts = [{ x: 10 }, { x: 50 }, { x: 90 }];
  assert(nearestPointIndex(pts, 50) === 1, 'exact hit returns that point');
  assert(nearestPointIndex(pts, 49) === 1, 'near hit snaps to the nearest point');
  assert(nearestPointIndex(pts, 12) === 0, 'left edge snaps to the first point');
  assert(nearestPointIndex(pts, 200) === 2, 'past the end snaps to the last point');
  assert(nearestPointIndex(pts, 30) === 0, 'a tie keeps the earlier point (deterministic)');
  assert(nearestPointIndex([{ x: 42 }], 999) === 0, 'single point always wins');
}

section('chart: rising trend renders a clean green line with a latest-point ring');
{
  setupDom();
  // Oldest -> newest rising, so newest-first input is the reverse.
  const history = seedHistory('vc-1', [58834.75, 58400, 57900, 57200, 56900, 56100]);
  const { container, root } = await render(<HistoryChart history={history} />);
  const svg = container.querySelector('svg');
  assert(!!svg, 'chart svg renders');
  const line = svg?.querySelector('path');
  assert(!!line, 'trend line path renders');
  const d = line?.getAttribute('d') ?? '';
  assert(d.includes('C'), `line uses smooth curve segments (got "${d.slice(0, 40)}…")`);
  assert(
    (line?.getAttribute('class') ?? '').includes('stroke-emerald-600'),
    'rising trend line is emerald',
  );
  assert(
    !!container.querySelector('[data-testid="history-chart-latest"]'),
    'latest point carries an outlined ring at rest',
  );
  assert(
    svg?.querySelector('defs linearGradient') === null &&
      svg?.querySelector('path[class*="animate-chart-area"]') === null,
    'no area fill decoration under the line',
  );
  assert(svg?.querySelectorAll('line').length === 0, 'no grid lines and no hover guide at rest');
  await teardown(container, root);
}

section('chart: falling trend renders a red line');
{
  setupDom();
  const history = seedHistory('vc-1', [54900, 56100, 57200, 57900, 58400, 58834.75]);
  const { container, root } = await render(<HistoryChart history={history} />);
  const line = container.querySelector('svg path');
  assert(
    (line?.getAttribute('class') ?? '').includes('stroke-red-700'),
    'falling trend line is red',
  );
  await teardown(container, root);
}

section('chart: range selector is a bottom pill group defaulting to 24H');
{
  setupDom();
  const history = seedHistory('vc-1', [58834.75, 58400, 57900, 57200]);
  const { container, root } = await render(<HistoryChart history={history} />);
  const group = container.querySelector('[role="group"][aria-label="Time range"]');
  assert(!!group, 'range pill group renders with an accessible label');
  const labels = Array.from(group?.querySelectorAll('button') ?? []).map((b) => b.textContent);
  assert(
    labels.join(',') === '24H,7D,30D',
    `pill group offers 24H / 7D / 30D (got ${labels.join(',')})`,
  );
  const selected = group?.querySelector('button[aria-pressed="true"]');
  assert(selected?.textContent === '24H', 'narrowest populated range (24H) is selected by default');
  assert(
    (selected?.className ?? '').includes('bg-background'),
    'selected range reads as a subtle pill',
  );
  assert(
    (selected?.className ?? '').includes('tabular-nums'),
    'range labels use tabular numbers',
  );
  // Pills sit below the chart, not above it.
  const svg = container.querySelector('svg');
  assert(
    !!svg &&
      !!group &&
      (svg.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    'pill group follows the chart in document order',
  );
  await teardown(container, root);
}

section('detail: value card integrates large value, decimals, change, and chart');
{
  setupDom();
  const monitor = seedMonitor();
  await monitorsItem.setValue([monitor]);
  // Rising series ending at the monitor's current value.
  await historyItem('vc-1').setValue(
    seedHistory('vc-1', [58834.75, 58400, 57900, 57200, 56900, 56100]),
  );
  try {
    const { container, root } = await render(<MonitorDetail monitorId="vc-1" onDeleted={() => {}} />);
    const svg = container.querySelector('svg');
    assert(!!svg, 'value card contains the integrated trend chart');
    const pills = container.querySelector('[role="group"][aria-label="Time range"]');
    assert(!!pills, 'value card contains the range pills');
    // Integer part dark, decimal fraction muted - reference styling.
    const mutedDecimals = Array.from(container.querySelectorAll('span')).filter(
      (s) => s.textContent === '.75',
    );
    assert(mutedDecimals.length > 0, 'decimal fraction renders as its own span');
    assert(
      mutedDecimals.some((s) => s.className.includes('text-muted-foreground')),
      'decimal fraction is muted while the integer stays foreground',
    );
    // No duplicate chart further down the page: exactly one trend chart.
    assert(
      container.querySelectorAll('svg').length >= 1 &&
        container.querySelectorAll('[role="group"][aria-label="Time range"]').length === 1,
      'exactly one chart + pill group in the detail view',
    );
    await teardown(container, root);
  } finally {
    await monitorsItem.setValue([]);
    await historyItem('vc-1').setValue([]);
  }
}

/** jsdom has no layout - give the chart svg a real box so hover math runs. */
function mockSvgBox(svg: Element, width = 300, height = 180) {
  (svg as any).getBoundingClientRect = () =>
    ({ x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON: () => {} }) as DOMRect;
}

async function hover(svg: Element, clientX: number) {
  await act(async () => {
    svg.dispatchEvent(
      new (window as any).MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: 90,
      }),
    );
  });
}

async function leave(svg: Element) {
  await act(async () => {
    svg.dispatchEvent(
      new (window as any).MouseEvent('mouseout', {
        bubbles: true,
        cancelable: true,
        relatedTarget: document.body,
      }),
    );
  });
}

section('scrub: hover reports the exact recorded reading, leave reports null');
{
  setupDom();
  const history = seedHistory('vc-1', [58834.75, 58400, 57900, 57200, 56900, 56100]);
  let reported: { raw: string; checkedAt: number } | null | 'unset' = 'unset';
  const { container, root } = await render(
    <HistoryChart history={history} onScrub={(r) => { reported = r; }} />,
  );
  assert(reported === null, 'no reading reported at rest');
  const svg = container.querySelector('svg')!;
  mockSvgBox(svg);
  // Far left snaps to the oldest real point - the exact stored strings.
  await hover(svg, 12);
  const oldest = history[history.length - 1];
  assert(
    reported !== null &&
      reported !== 'unset' &&
      (reported as { raw: string }).raw === oldest.value &&
      (reported as { checkedAt: number }).checkedAt === oldest.checkedAt,
    `hover reports the exact oldest reading (${JSON.stringify(reported)})`,
  );
  assert(
    !!container.querySelector('[data-testid="history-chart-guide"]'),
    'vertical guide appears while scrubbing',
  );
  assert(
    container.querySelector('[data-testid="history-chart-latest"]') === null,
    'rest ring yields so only one marker circle exists while scrubbing',
  );
  // Far right snaps to the newest real point.
  await hover(svg, 290);
  const newest = history[0];
  assert(
    reported !== null &&
      reported !== 'unset' &&
      (reported as { raw: string }).raw === newest.value,
    'hover at the right edge reports the exact newest reading',
  );
  assert(
    container.querySelector('[data-testid="history-chart-latest"]') === null,
    'rest ring yields to the scrub marker on the latest point',
  );
  // Hovering between points moves the guide line and marker smoothly to the exact cursor X, not snapping to point coordinates.
  await hover(svg, 100);
  const guideLine = container.querySelector('[data-testid="history-chart-guide"] line');
  const guideMarker = container.querySelector('[data-testid="history-chart-guide"] circle');
  assert(
    Math.abs(Number(guideLine?.getAttribute('x1')) - 100) < 0.01 &&
      Math.abs(Number(guideMarker?.getAttribute('cx')) - 100) < 0.01,
    'guide line and marker glide smoothly with cursor X across the trend line',
  );
  assert(
    Number(guideMarker?.getAttribute('cy')) > 0,
    'marker calculates continuous Y on trend line',
  );

  await leave(svg);
  assert(reported === null, 'leaving the chart reports null');
  assert(
    container.querySelector('[data-testid="history-chart-guide"]') === null,
    'guide disappears on leave',
  );
  assert(
    !!container.querySelector('[data-testid="history-chart-latest"]'),
    'rest ring returns on leave',
  );
  await teardown(container, root);
}

section('detail: header shows the scrubbed reading live, then the latest again');
{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  await historyItem('vc-1').setValue(
    seedHistory('vc-1', [58834.75, 58400, 57900, 57200, 56900, 56100]),
  );
  try {
    const { container, root } = await render(<MonitorDetail monitorId="vc-1" onDeleted={() => {}} />);
    const value = () => container.querySelector('[data-testid="monitor-value"]')?.textContent ?? '';
    const time = () => container.querySelector('[data-testid="monitor-reading-time"]')?.textContent ?? '';
    const movement = () => container.querySelector('[data-testid="monitor-movement"]')?.textContent ?? '';
    assert(value().includes('$58,834'), `latest value shown at rest (got "${value()}")`);
    assert(time().includes('past 24 hours'), `header time reflects selected 24H range (got "${time()}")`);
    assert(movement().includes('+$2,734.75') && movement().includes('4.9%'), `header change reflects latest range movement (got "${movement()}")`);
    assert(!time().includes('since last check'), 'never shows since last check when range is selected');
    // The chart svg specifically - status/badge icons are svgs too.
    const svg = container.querySelector('svg[role="img"]')!;
    assert(!!svg, 'trend chart svg found');
    mockSvgBox(svg);
    await hover(svg, 12);
    // Oldest recorded reading - exact strings, nothing interpolated.
    assert(
      value().includes('$56,100') && value().includes('.00'),
      `header value follows the scrubbed reading (got "${value()}")`,
    );
    assert(
      movement().includes('$0.00') && movement().includes('0.0%'),
      `header movement and percentage follow the scrubbed reading (got "${movement()}")`,
    );
    const oldest = (await historyItem('vc-1').getValue())[5];
    assert(
      time().includes(formatDateTime(oldest.checkedAt)),
      `header timestamp follows the scrubbed reading (got "${time()}")`,
    );
    const guideMarker = container.querySelector('[data-testid="history-chart-guide"] circle');
    assert(
      (guideMarker?.getAttribute('class') ?? '').includes('stroke-emerald-600'),
      'active marker retains trend stroke color while scrubbing',
    );
    const guideLine = container.querySelector('[data-testid="history-chart-guide"] line');
    assert(
      (guideLine?.getAttribute('class') ?? '').includes('stroke-emerald-600'),
      'vertical guide line retains trend stroke color while scrubbing',
    );
    await leave(svg);
    assert(value().includes('$58,834'), `header returns to the latest reading (got "${value()}")`);
    assert(
      movement().includes('+$2,734.75') && movement().includes('4.9%'),
      `header movement returns to the latest reading (got "${movement()}")`,
    );
    assert(time().includes('past 24 hours'), 'header time returns to range description on leave');
    // Switching range drops any in-flight scrub and restores the latest.
    await hover(svg, 12);
    assert(value().includes('$56,100'), 'scrubbed reading shown before range switch');
    const day7 = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '7D')!;
    await act(async () => {
      day7.dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    assert(value().includes('$58,834'), 'range switch restores the latest reading');
    assert(time().includes('past 7 days'), `header time reflects selected 7D range (got "${time()}")`);
    assert(!time().includes('since last check'), 'never shows since last check when 7D is selected');
    await teardown(container, root);
  } finally {
    await monitorsItem.setValue([]);
    await historyItem('vc-1').setValue([]);
  }
}

section('detail: value area never truncates and displays complete value across formats and statuses');
{
  setupDom();
  const testCases = [
    {
      label: 'long currency with Near low and Changed status',
      value: '$77,455.00',
      status: 'changed',
      stats: { min: 75000, max: 80000, avg: 77000, count: 5, lastChangedAt: Date.now() },
    },
    {
      label: 'very large currency with all-time-low deal status',
      value: '$1,234,567.89',
      status: 'unchanged',
      stats: { min: 1234567.89, max: 2000000, avg: 1500000, count: 8, lastChangedAt: Date.now() },
    },
    {
      label: 'percentage value',
      value: '99.99%',
      status: 'unchanged',
      stats: null,
    },
    {
      label: 'large formatted number with paused status',
      value: '1,000,000,000',
      status: 'idle',
      enabled: false,
      stats: null,
    },
    {
      label: 'short value',
      value: '$42',
      status: 'unchanged',
      stats: null,
    },
  ];

  for (const tc of testCases) {
    const mon = seedMonitor({
      id: 'resp-1',
      lastValue: tc.value,
      lastStatus: tc.status,
      enabled: tc.enabled ?? true,
      stats: tc.stats,
    });
    await monitorsItem.setValue([mon]);
    try {
      const { container, root } = await render(<MonitorDetail monitorId="resp-1" onDeleted={() => {}} />);
      const el = container.querySelector('[data-testid="monitor-value"]');
      assert(!!el, `${tc.label}: value element exists`);
      assert(
        el?.textContent === tc.value,
        `${tc.label}: complete value displayed without alteration (got "${el?.textContent}")`,
      );
      assert(
        !(el?.className ?? '').includes('truncate'),
        `${tc.label}: value is never truncated or ellipsized`,
      );
      assert(
        (el?.className ?? '').includes('whitespace-nowrap'),
        `${tc.label}: value stays on a single line`,
      );
      await teardown(container, root);
    } finally {
      await monitorsItem.setValue([]);
    }
  }
}

console.log('\nAll value chart card tests finished.');
