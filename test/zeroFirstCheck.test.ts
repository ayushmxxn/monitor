/**
 * Fresh-monitor first-check zero confirmation regression tests.
 *
 * A first-ever reading of exact numeric zero is re-read once through
 * the same strategy before anything commits: second read non-zero →
 * commit that; second read zero → commit 0 normally; second read
 * fails → commit nothing (ordinary failure, retried next check).
 * Established monitors (any committed value, including a committed 0)
 * and text monitors never enter this flow. Assertions target committed
 * state (value/history/stats/counters) plus the strategy run count,
 * which proves whether the second-read path ran.
 */
import './mockBrowser';
import { mock } from 'bun:test';
import { detectSemanticValue, type SemanticValue } from '../lib/monitors/semanticValue';
import { diagnostic, type DiagnosticCode } from '../lib/monitors/diagnostics';
import { STRATEGIES } from '../lib/monitors/strategies';
import type { StrategyOutcome } from '../lib/monitors/strategies/types';
import { getHistory, getMonitor, appendHistory } from '../lib/monitors/store';
import { monitorsItem, historyItem } from '../lib/storage/items';
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

// runCheck consults origin permission first; grant everything here so
// the strategy cascade (not the permission gate) is under test.
mock.module('../lib/permissions', () => ({
  hasOriginPermission: async () => ({ ok: true, value: true }),
  requestOriginPermission: async () => ({ ok: true, value: true }),
}));

const { runCheck, needsZeroConfirmation } = await import('../lib/monitors/checker');

function unwrap<T>(result: { ok: boolean; value?: T; error?: { toDisplayMessage: () => string } }): T {
  if (!result.ok) throw new Error(`store call failed: ${result.error?.toDisplayMessage()}`);
  return result.value as T;
}

function seedMonitor(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'zf-1',
    name: 'Fresh views',
    url: 'https://example.com/analytics',
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 5,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: null,
    lastValue: null,
    lastSemanticValue: null,
    lastStatus: 'idle',
    lastError: null,
    lastDiagnosticCode: null,
    checkStrategy: 'fetch' as const,
    consecutiveFailures: 0,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 0,
    lastFingerprintUpdateAt: null,
    stats: null,
    ...overrides,
  };
}

function successOutcome(value: string, semantic: SemanticValue): StrategyOutcome {
  return {
    value,
    diagnostic: diagnostic('OK'),
    updatedFingerprint: null,
    confidence: 99,
    method: 'fast-path-selector',
    semanticValue: semantic,
  };
}

function failureOutcome(code: DiagnosticCode, detail?: string): StrategyOutcome {
  return {
    value: null,
    diagnostic: diagnostic(code, detail),
    updatedFingerprint: null,
    confidence: 0,
    method: 'none',
    semanticValue: null,
  };
}

const zeroOutcome = (): StrategyOutcome =>
  successOutcome('0', { type: 'number', normalized: 0, unit: null, raw: '0' });

// Scripted strategy reads + run counting. runCheck always tries the
// persisted 'fetch' strategy first, so one queue covers every scenario.
let runCount = 0;
let scripted: StrategyOutcome[] = [];
const realFetchRun = STRATEGIES.fetch.run;
STRATEGIES.fetch.run = (async () => {
  runCount += 1;
  const next = scripted.shift();
  if (!next) throw new Error('strategy run queue exhausted');
  return next;
}) as typeof STRATEGIES.fetch.run;

async function historyValues(id: string): Promise<Array<string | null>> {
  return (unwrap(await getHistory(id)) as any[]).map((e) => e.value);
}

section('0. predicate pins the three conditions exactly');
{
  const fresh = { lastValue: null };
  const established = { lastValue: '314,271' };
  const establishedZero = { lastValue: '0' };
  const numZero = { semanticValue: { type: 'number', normalized: 0 } } as any;
  const numNonZero = { semanticValue: { type: 'number', normalized: 42 } } as any;
  const textZero = { semanticValue: { type: 'text', normalized: null } } as any;
  const noSem = { semanticValue: null } as any;
  assert(needsZeroConfirmation(fresh as any, numZero) === true, 'fresh + numeric + exact 0 → confirm');
  assert(needsZeroConfirmation(fresh as any, numNonZero) === false, 'fresh + non-zero → no confirm');
  assert(needsZeroConfirmation(fresh as any, textZero) === false, 'fresh + text "0" → no confirm');
  assert(needsZeroConfirmation(fresh as any, noSem) === false, 'fresh + null semantic → no confirm');
  assert(needsZeroConfirmation(established as any, numZero) === false, 'established value → no confirm');
  assert(
    needsZeroConfirmation(establishedZero as any, numZero) === false,
    'established committed 0 → no confirm (never re-enters on "current value is 0")',
  );
}

section('1. fresh monitor, 0 → non-zero: only non-zero commits');
{
  await monitorsItem.setValue([seedMonitor()]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [zeroOutcome(), successOutcome('314,271', detectSemanticValue('314,271'))];

  await runCheck(seedMonitor());

  const after = unwrap(await getMonitor('zf-1')) as any;
  assert(after.lastValue === '314,271', `first value is the confirmed reading (got ${JSON.stringify(after.lastValue)})`);
  assert(runCount === 2, `second read ran once (got ${runCount})`);
  assert(
    JSON.stringify(await historyValues('zf-1')) === JSON.stringify(['314,271']),
    'history holds only the confirmed value (discarded 0 never appended)',
  );
  assert(after.stats?.low === 314271, 'stats built from the confirmed value, never 0');
  assert(after.totalSuccessfulChecks === 1, 'exactly one success counted');
}

section('2. fresh monitor, 0 → 0: commits 0 normally');
{
  await monitorsItem.setValue([seedMonitor()]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [zeroOutcome(), zeroOutcome()];

  await runCheck(seedMonitor());

  const after = unwrap(await getMonitor('zf-1')) as any;
  assert(after.lastValue === '0', 'repeat zero commits as the first value');
  assert(runCount === 2, 'confirmation ran before committing');
  assert(JSON.stringify(await historyValues('zf-1')) === JSON.stringify(['0']), 'repeat zero history recorded');
  assert(after.stats?.low === 0, 'repeat zero stats recorded');
}

section('3. fresh monitor, non-zero first read: unchanged, no second read');
{
  await monitorsItem.setValue([seedMonitor()]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [successOutcome('314,271', detectSemanticValue('314,271'))];

  await runCheck(seedMonitor());

  const after = unwrap(await getMonitor('zf-1')) as any;
  assert(after.lastValue === '314,271', 'first value commits directly');
  assert(runCount === 1, `second-read path never runs (got ${runCount})`);
}

section('4. established non-zero monitor reads 0: existing guard blocks, no second read');
{
  await monitorsItem.setValue([
    seedMonitor({
      lastValue: '314,271',
      lastSemanticValue: detectSemanticValue('314,271'),
      lastStatus: 'unchanged',
      stats: { low: 300_000, lowDate: 1, high: 314_800, sum: 3_100_000, count: 10 },
      totalSuccessfulChecks: 10,
    }),
  ]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [zeroOutcome()];

  await runCheck(seedMonitor({ lastValue: '314,271' }));

  const after = unwrap(await getMonitor('zf-1')) as any;
  assert(after.lastValue === '314,271', 'established value preserved');
  assert(runCount === 1, `confirmation never runs for established monitors (got ${runCount})`);
  assert(after.stats.low === 300_000, 'established stats untouched');
  assert((await historyValues('zf-1')).length === 0, 'nothing appended');
}

section('5. established monitor at confirmed 0, reads 0: tracks normally, no re-confirm');
{
  await monitorsItem.setValue([
    seedMonitor({
      lastValue: '0',
      lastSemanticValue: { type: 'number', normalized: 0, unit: null, raw: '0' },
      lastStatus: 'unchanged',
      stats: { low: 0, lowDate: 1, high: 0, sum: 0, count: 1 },
      totalSuccessfulChecks: 1,
    }),
  ]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [zeroOutcome()];

  await runCheck(seedMonitor({ lastValue: '0' }));

  const after = unwrap(await getMonitor('zf-1')) as any;
  assert(after.lastValue === '0', 'confirmed zero keeps tracking');
  assert(runCount === 1, `no re-confirmation on committed zeros (got ${runCount})`);
}

section('6. text monitor with "0": completely unaffected');
{
  await monitorsItem.setValue([
    seedMonitor({ lastValue: null, lastSemanticValue: null, lastStatus: 'idle' }),
  ]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [
    successOutcome('0', { type: 'text', normalized: null, unit: null, raw: '0' }),
  ];

  await runCheck(seedMonitor());

  const after = unwrap(await getMonitor('zf-1')) as any;
  assert(after.lastValue === '0', 'text "0" commits directly');
  assert(runCount === 1, `confirmation never runs for text (got ${runCount})`);
  assert(after.stats === null, 'no stats fabricated for text');
}

section('7. fresh monitor, 0 → confirmation errors: nothing committed');
{
  await monitorsItem.setValue([seedMonitor()]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [zeroOutcome(), failureOutcome('NETWORK_ERROR', 'connection refused')];

  await runCheck(seedMonitor());

  const after = unwrap(await getMonitor('zf-1')) as any;
  assert(after.lastValue === null, 'monitor still fresh (no fallback to the discarded 0)');
  assert(runCount === 2, 'confirmation was attempted');
  const values = await historyValues('zf-1');
  assert(!values.some((v) => v !== null), 'no value entries in history');
  assert(after.consecutiveFailures === 1, 'recorded as an ordinary failure for retry');
}

section('8. monitor deleted/disabled mid-confirmation: nothing written');
{
  // The second scripted read deletes the monitor before returning a
  // good value: the final write gate must drop the result.
  await monitorsItem.setValue([seedMonitor()]);
  await historyItem('zf-1').setValue([]);
  runCount = 0;
  scripted = [
    zeroOutcome(),
    {
      ...successOutcome('314,271', detectSemanticValue('314,271')),
    },
  ];
  const secondRun = STRATEGIES.fetch.run;
  STRATEGIES.fetch.run = (async (monitor: any) => {
    runCount += 1;
    if (runCount === 2) {
      const { deleteMonitor } = await import('../lib/monitors/store');
      await deleteMonitor(monitor.id);
    }
    const next = scripted.shift();
    if (!next) throw new Error('strategy run queue exhausted');
    return next;
  }) as typeof STRATEGIES.fetch.run;

  await runCheck(seedMonitor());
  STRATEGIES.fetch.run = secondRun;

  const gone = await getMonitor('zf-1');
  assert(gone.ok === false, 'deleted monitor stays deleted (result dropped, not resurrected)');

  // Disabled mid-confirmation: same drop, monitor intact but untouched.
  await monitorsItem.setValue([seedMonitor({ id: 'zf-2' })]);
  await historyItem('zf-2').setValue([]);
  runCount = 0;
  scripted = [zeroOutcome(), successOutcome('314,271', detectSemanticValue('314,271'))];
  const thirdRun = STRATEGIES.fetch.run;
  STRATEGIES.fetch.run = (async (monitor: any) => {
    runCount += 1;
    if (runCount === 2) {
      const { updateMonitor } = await import('../lib/monitors/store');
      await updateMonitor('zf-2', { enabled: false });
    }
    const next = scripted.shift();
    if (!next) throw new Error('strategy run queue exhausted');
    return next;
  }) as typeof STRATEGIES.fetch.run;

  await runCheck(seedMonitor({ id: 'zf-2' }));
  STRATEGIES.fetch.run = thirdRun;

  const disabled = unwrap(await getMonitor('zf-2')) as any;
  assert(disabled.lastValue === null, 'disabled monitor keeps no value');
  assert(disabled.enabled === false, 'disabled flag preserved');
}

STRATEGIES.fetch.run = realFetchRun;

console.log(`\n${failures === 0 ? 'All zero-confirmation tests passed.' : `${failures} zero-confirmation assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
