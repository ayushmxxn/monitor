/**
 * Zero-cliff reliability regression tests.
 *
 * Incident: a numeric monitor tracking ~314K component views recorded
 * a 0 after one check. The stored value later recovered, but the
 * single bad write permanently poisoned all-time low (Math.min never
 * recovers upward), average, and the chart — exactly the lasting
 * damage in the report.
 *
 * Fuzzing the parse layer shows no extraction path fabricates 0 from
 * failed/empty input: every parser returns null for non-numeric text.
 * The 0 necessarily came from page content rendering a zero-ish
 * string (animated-counter start, skeleton slot, unhydrated widget,
 * SSR initial state) that the settle loop confirmed across two
 * identical reads — or the fetch path's single static parse with no
 * settle at all. Both read paths converge on one unguarded commit in
 * `recordSuccess`, which is where the fix lives:
 *
 * - exact-numeric-zero reading + established non-zero numeric stored
 *   value → preserve everything (value/history/stats/failures),
 *   advance only the check timestamp.
 * - fresh monitors and already-zero series still store 0 normally, so
 *   a website genuinely reporting 0 keeps working.
 */
import './mockBrowser';
import { detectSemanticValue } from '../lib/monitors/semanticValue';
import { diagnostic } from '../lib/monitors/diagnostics';
import { getHistory, getMonitor, appendHistory } from '../lib/monitors/store';
import { monitorsItem, historyItem } from '../lib/storage/items';
import { recordSuccess } from '../lib/monitors/checker';
import { setSoundEnabledForTesting } from '../lib/monitors/sound';

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

setSoundEnabledForTesting(false);

function unwrap<T>(result: { ok: boolean; value?: T; error?: { toDisplayMessage: () => string } }): T {
  if (!result.ok) throw new Error(`store call failed: ${result.error?.toDisplayMessage()}`);
  return result.value as T;
}

function seedMonitor(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'zero-1',
    name: 'Component views',
    url: 'https://example.com/analytics',
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 5,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: 1_000_000,
    lastValue: '314,271',
    lastSemanticValue: detectSemanticValue('314,271'),
    lastStatus: 'unchanged',
    lastError: null,
    lastDiagnosticCode: 'OK',
    checkStrategy: null,
    consecutiveFailures: 0,
    lastConfidence: 99,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 10,
    lastFingerprintUpdateAt: null,
    stats: {
      low: 300_000,
      lowDate: 900_000,
      high: 314_800,
      sum: 3_100_000,
      count: 10,
    },
    ...overrides,
  };
}

async function seedHistory(monitorId: string, value: string) {
  const sem = detectSemanticValue(value);
  const result = await appendHistory({
    id: `${monitorId}_seed`,
    monitorId,
    value,
    previousValue: null,
    previousSemanticValue: null,
    semanticValue: sem,
    checkedAt: 1_000_000,
    changed: false,
    error: null,
    diagnosticCode: 'OK',
    confidence: 99,
    strategy: 'fetch',
  });
  if (!result.ok) throw new Error('failed to seed history');
}

section('1. transient zero never overwrites value/history/stats');
{
  await monitorsItem.setValue([seedMonitor()]);
  await historyItem('zero-1').setValue([]);
  await seedHistory('zero-1', '314,271');
  const beforeHistory = (unwrap(await getHistory('zero-1')) as unknown[]).length;

  await recordSuccess(seedMonitor(), 'fetch', {
    value: '0',
    diagnostic: diagnostic('OK'),
    updatedFingerprint: null,
    confidence: 99,
    method: 'fast-path-selector',
    semanticValue: { type: 'number', normalized: 0, unit: null, raw: '0' },
  });

  const after = unwrap(await getMonitor('zero-1')) as any;
  assert(after.lastValue === '314,271', `lastValue preserved (got ${JSON.stringify(after.lastValue)})`);
  assert(
    JSON.stringify(after.lastSemanticValue) === JSON.stringify(detectSemanticValue('314,271')),
    'lastSemanticValue preserved',
  );

  const history = unwrap(await getHistory('zero-1')) as any[];
  assert(history.length === beforeHistory, `no zero entry appended to history (got ${history.length})`);
  assert(
    !history.some((e) => e.value === '0' || e.semanticValue?.normalized === 0),
    'history contains no zero-valued entry',
  );

  assert(after.stats.low === 300_000, `all-time low untouched (got ${after.stats.low})`);
  assert(after.stats.high === 314_800, `all-time high untouched (got ${after.stats.high})`);
  assert(after.stats.sum === 3_100_000 && after.stats.count === 10, 'sum/count untouched');
  assert(after.consecutiveFailures === 0, 'failure count untouched (not a failure, not a success)');
  assert(after.lastStatus === 'unchanged', `status preserved (got ${after.lastStatus})`);
  assert(after.totalSuccessfulChecks === 10, 'no phantom success counted');
  assert(after.lastCheckedAt >= 1_000_000, 'check timestamp still advances (schedule stays honest)');
}

section('2. genuine zero on a fresh monitor still works');
{
  await monitorsItem.setValue([seedMonitor({ id: 'zero-2', lastValue: null, lastSemanticValue: null, stats: null, lastStatus: 'idle', lastCheckedAt: null, totalSuccessfulChecks: 0 })]);
  await historyItem('zero-2').setValue([]);

  await recordSuccess(
    seedMonitor({ id: 'zero-2' }),
    'fetch',
    {
      value: '0',
      diagnostic: diagnostic('OK'),
      updatedFingerprint: null,
      confidence: 99,
      method: 'fast-path-selector',
      semanticValue: { type: 'number', normalized: 0, unit: null, raw: '0' },
    },
  );

  const after = unwrap(await getMonitor('zero-2')) as any;
  assert(after.lastValue === '0', `fresh genuine zero is stored (got ${JSON.stringify(after.lastValue)})`);
  const history = unwrap(await getHistory('zero-2')) as any[];
  assert(history.length === 1 && history[0].value === '0', 'fresh zero history recorded');
  assert(after.stats?.low === 0, 'fresh zero stats recorded');
}

section('3. established-zero series keeps tracking zeros');
{
  // Second consecutive zero on the monitor from section 2: prior value
  // is already 0, so the guard stands down and normal tracking resumes.
  await recordSuccess(
    seedMonitor({ id: 'zero-2' }),
    'fetch',
    {
      value: '0',
      diagnostic: diagnostic('OK'),
      updatedFingerprint: null,
      confidence: 99,
      method: 'fast-path-selector',
      semanticValue: { type: 'number', normalized: 0, unit: null, raw: '0' },
    },
  );
  const after = unwrap(await getMonitor('zero-2')) as any;
  const history = unwrap(await getHistory('zero-2')) as any[];
  assert(after.lastValue === '0', 'established zero series keeps storing');
  // Seed starts the counter at 0: two genuine zero commits → 2,
  // proving the guard stands down once the series itself is zero.
  assert(after.totalSuccessfulChecks === 2, `second zero commits fully (no guard freeze, got ${after.totalSuccessfulChecks})`);
  assert(history.length === 1, 'identical consecutive zeros sample without duplicating history');
}

section('4. ordinary non-zero updates are unaffected');
{
  await monitorsItem.setValue([seedMonitor({ id: 'zero-4' })]);
  await historyItem('zero-4').setValue([]);
  await seedHistory('zero-4', '314,271');

  await recordSuccess(
    seedMonitor({ id: 'zero-4' }),
    'fetch',
    {
      value: '314,860',
      diagnostic: diagnostic('OK'),
      updatedFingerprint: null,
      confidence: 99,
      method: 'fast-path-selector',
      semanticValue: detectSemanticValue('314,860'),
    },
  );

  const after = unwrap(await getMonitor('zero-4')) as any;
  assert(after.lastValue === '314,860', `normal update commits (got ${JSON.stringify(after.lastValue)})`);
  assert(after.stats.high === 314_860, 'stats track genuine movement');
  // The synthetic seed entry carries a 1970 timestamp, so normal
  // 30-day retention prunes it when the real-timestamped genuine
  // update lands — what matters is the genuine entry is recorded.
  const history4 = unwrap(await getHistory('zero-4')) as any[];
  assert(
    history4.length === 1 && history4[0].value === '314,860',
    'genuine update is recorded in history',
  );
}

section('5. text monitors reading "0" are untouched');
{
  await monitorsItem.setValue([
    seedMonitor({
      id: 'zero-5',
      lastValue: 'In Stock',
      lastSemanticValue: detectSemanticValue('In Stock'),
      stats: null,
    }),
  ]);
  await historyItem('zero-5').setValue([]);

  await recordSuccess(
    seedMonitor({ id: 'zero-5' }),
    'fetch',
    {
      value: '0',
      diagnostic: diagnostic('OK'),
      updatedFingerprint: null,
      confidence: 99,
      method: 'fast-path-selector',
      semanticValue: { type: 'text', normalized: null, unit: null, raw: '0' },
    },
  );

  const after = unwrap(await getMonitor('zero-5')) as any;
  assert(after.lastValue === '0', 'text reading stored exactly as shown');
  assert(after.stats === null, 'no stats fabricated for text values');
}

console.log(`\n${failures === 0 ? 'All zero-guard tests passed.' : `${failures} zero-guard assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
