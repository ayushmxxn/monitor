/**
 * User-facing monitor error copy contract.
 *
 * Raw check traces (scores, candidate counts, thresholds, fetch/live
 * strategy details, selectors, internal codes) stay in storage/history
 * for debugging but must never reach the main UI. Every monitor error
 * shows a short human message (1–3 sentences): what happened and what
 * to do next. Detection, recovery, labels, and actions are unchanged —
 * only the words are audited here.
 */
import './mockBrowser';
import { mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import {
  getFailureStateInfo,
  type DiagnosticCode,
} from '../lib/monitors/diagnostics';
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

/** Technical debris that must never appear in user-facing copy. */
const LEAK_PATTERNS: RegExp[] = [
  /\d+\s*\/\s*100/,
  /candidate/i,
  /threshold/i,
  /fetch:/i,
  /live:/i,
  /strategy/i,
  /selector/i,
  /fingerprint/i,
  /re-anchor/i,
  /reanchor/i,
  /relocat/i,
  /confidence/i,
  /diagnostic/i,
  /\bSSR\b/,
  /\bDOM\b/,
  /xpath/i,
  /undefined/i,
  /needs \d+/i,
  /scanned \d+/i,
  /elements considered/i,
];

function leaks(text: string): string | null {
  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(text)) return String(pattern);
  }
  return null;
}

function sentenceCount(text: string): number {
  return text.split(/[.!?…]+/).map((s) => s.trim()).filter(Boolean).length;
}

const ERROR_CODES: DiagnosticCode[] = [
  'PERMISSION_DENIED',
  'AUTH_REQUIRED',
  'NETWORK_ERROR',
  'PAGE_LOAD_TIMEOUT',
  'PAGE_NOT_READY',
  'ANTI_AUTOMATION_DETECTED',
  'ELEMENT_NOT_FOUND',
  'SELECTOR_RECOVERY_LOW_CONFIDENCE',
  'EXTRACTION_EMPTY',
  'NEEDS_REPICK',
  'ACCESS_CHANGED',
  'TAB_CLOSED',
  'UNKNOWN',
];

section('1. every monitor error reads human: short, actionable, leak-free');
{
  for (const code of ERROR_CODES) {
    const info = getFailureStateInfo(code);
    assert(info.label.length > 0, `${code} has a label`);
    const leak = leaks(info.label) ?? leaks(info.description);
    assert(leak === null, `${code} copy is leak-free (label ${JSON.stringify(info.label)})`);
    const sentences = sentenceCount(info.description);
    assert(
      sentences >= 1 && sentences <= 3,
      `${code} description is 1–3 sentences (got ${sentences}: ${JSON.stringify(info.description)})`,
    );
  }
}

section('2. unknown-code fallback never echoes the raw technical trace');
{
  const traces = [
    'live: best candidate scored 12/100 across 45 elements considered; needs 55',
    'fetch: SSR HTML did not contain target (selector html > body > div > span)',
    'Navigation timed out after 15s (live tab strategy)',
    'Frame with ID 0 was removed',
    'Confidence 20 below threshold 55; fingerprint relocation failed',
  ];
  for (const trace of traces) {
    const info = getFailureStateInfo('UNKNOWN', trace);
    assert(
      info.description !== trace && !info.description.includes(trace),
      `raw trace is not user copy (got ${JSON.stringify(info.description)})`,
    );
    const leak = leaks(info.description);
    assert(leak === null, `fallback copy is leak-free for ${JSON.stringify(trace.slice(0, 40))}…`);
    const sentences = sentenceCount(info.description);
    assert(sentences >= 1 && sentences <= 3, `fallback copy is 1–3 sentences (got ${sentences})`);
  }
  // Fallback label routing is unchanged (locked by existing tests too).
  assert(
    getFailureStateInfo('UNKNOWN', 'Navigation timed out after 15s').label === "Couldn't load page",
    'timeout trace still routes to "Couldn\'t load page"',
  );
  assert(
    getFailureStateInfo('UNKNOWN', 'scanned 12 candidate elements, none matched').label === 'Value not found',
    'not-found trace still routes to "Value not found"',
  );
  assert(
    getFailureStateInfo('UNKNOWN', 'closest matching candidate had low confidence').label === 'Page changed',
    'confidence trace still routes to "Page changed"',
  );
}

section('3. labels, reasons, and actions are unchanged');
{
  const expectations: Array<[DiagnosticCode, string, string, boolean]> = [
    ['ELEMENT_NOT_FOUND', 'Value not found', 'value_not_found', true],
    ['EXTRACTION_EMPTY', 'Value not found', 'value_not_found', true],
    ['SELECTOR_RECOVERY_LOW_CONFIDENCE', 'Page changed', 'page_changed', true],
    ['NEEDS_REPICK', 'Needs re-pick', 'page_changed', true],
    ['ACCESS_CHANGED', 'Access changed', 'access_changed', true],
    ['NETWORK_ERROR', "Couldn't load page", 'page_load_failed', true],
    ['PAGE_LOAD_TIMEOUT', "Couldn't load page", 'page_load_failed', true],
    ['PAGE_NOT_READY', "Couldn't load page", 'page_load_failed', true],
    ['TAB_CLOSED', "Couldn't load page", 'page_load_failed', true],
    ['ANTI_AUTOMATION_DETECTED', 'Blocked', 'blocked', true],
    ['AUTH_REQUIRED', 'Sign-in required', 'auth_required', true],
    ['PERMISSION_DENIED', 'Permission needed', 'permission_denied', false],
    ['UNKNOWN', 'Check failed', 'unknown', true],
  ];
  for (const [code, label, reason, canRetry] of expectations) {
    const info = getFailureStateInfo(code);
    assert(info.label === label, `${code} label stays ${JSON.stringify(label)}`);
    assert(info.reason === reason, `${code} reason stays ${JSON.stringify(reason)}`);
    assert(info.canRetry === canRetry, `${code} canRetry stays ${canRetry}`);
    assert(info.actionLabel === 'Check now' || code === 'PERMISSION_DENIED', `${code} action intact`);
  }
}

// --- Detail panel never renders the stored technical trace ----------

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

// In-flight checking state for the single-status test below (mirrors
// checkNow.test.tsx): pre-seeded so `useIsChecking` reads active.
const checkingSet = new Set<string>();
const checkingListeners = new Set<() => void>();
mock.module('../lib/monitors/client', () => ({
  isMonitorChecking: (id: string) => checkingSet.has(id),
  subscribeChecking: (fn: () => void) => {
    checkingListeners.add(fn);
    return () => {
      checkingListeners.delete(fn);
    };
  },
  checkMonitorNow: async () => ({ ok: true, value: undefined }),
  checkAllMonitorsNow: async () => ({ ok: true, value: undefined }),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

function seedMonitor(): any {
  return {
    id: 'e1',
    name: 'E Monitor',
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
    lastStatus: 'error',
    lastError:
      'live: best candidate scored 12/100 across 45 elements considered; needs 55 — fetch: SSR HTML did not contain target (selector html > body > div > span)',
    lastDiagnosticCode: 'SELECTOR_RECOVERY_LOW_CONFIDENCE',
    checkStrategy: null,
    consecutiveFailures: 3,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 3,
    lastFingerprintUpdateAt: null,
    stats: null,
  };
}

section('4. detail panel shows the human message, never the stored trace');
{
  setupDom();
  await monitorsItem.setValue([seedMonitor()]);
  try {
    const { container, root } = await render(<MonitorDetail monitorId="e1" onDeleted={() => {}} />);
    await act(async () => {
      await sleep(50);
    });
    const text = container.textContent ?? '';
    assert(text.includes('Page changed'), 'detail shows the human failure label');
    assert(text.includes('too uncertain'), 'detail shows the human description');
    for (const raw of ['scored', '12/100', 'candidate', 'fetch:', 'live:', 'needs 55', 'selector', 'SSR']) {
      assert(!text.includes(raw), `detail hides raw trace fragment ${JSON.stringify(raw)}`);
    }
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    assert(
      buttons.some((t) => t.includes('Retry check') || t.includes('Check now')),
      'retry action is still present',
    );
    assert(text.includes('$10.00'), 'last known value is still preserved alongside');
    // One status, stated once: the label lives only in the header badge
    // (the hero shows the preserved value, the explanation below carries
    // no repeated title), and the description sentence appears once.
    const labelCount = text.split('Page changed').length - 1;
    assert(labelCount === 1, `error label appears exactly once (got ${labelCount})`);
    const descCount = text.split('too uncertain').length - 1;
    assert(descCount === 1, `explanation sentence appears exactly once (got ${descCount})`);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  } finally {
    await monitorsItem.setValue([]);
  }
}

section('5. retry/loading shows one status plus one action — never duplicated');
{
  // A check in flight: the header badge ("Checking…") and the primary
  // button (spinner, disabled) are the whole story. No extra spinner
  // beside the value, no separate stage line underneath it.
  setupDom();
  checkingSet.add('e2');
  await monitorsItem.setValue([
    {
      ...seedMonitor(),
      id: 'e2',
      name: 'E2 Monitor',
      lastStatus: 'unchanged',
      lastError: null,
      lastDiagnosticCode: 'OK',
      consecutiveFailures: 0,
      lastValue: '$5.00',
    },
  ]);
  try {
    const { container, root } = await render(<MonitorDetail monitorId="e2" onDeleted={() => {}} />);
    await act(async () => {
      await sleep(50);
    });
    const spinners = container.querySelectorAll('svg.animate-spin');
    assert(
      spinners.length === 2,
      `checking shows exactly two spinners (header badge + primary button, got ${spinners.length})`,
    );
    const action = Array.from(container.querySelectorAll('button')).find((b) =>
      /Connecting…|Loading page…|Finding value…|Checking value…|Almost there…|Checking…/.test(
        b.textContent ?? '',
      ),
    );
    assert(!!action, 'primary button carries the checking state');
    assert(
      (action as HTMLButtonElement).disabled === true,
      'primary button is disabled while checking (no duplicate checks)',
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  } finally {
    checkingSet.delete('e2');
    await monitorsItem.setValue([]);
  }
}

console.log(`\n${failures === 0 ? 'All error-message tests passed.' : `${failures} error-message assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
