import './mockBrowser';
import { setCueListenerForTesting, SPARKLE_VOLUME, ERROR_VOLUME, CUE_VOLUME } from '../lib/monitors/sound';
import { recordSuccess, recordFailure } from '../lib/monitors/checker';
import * as store from '../lib/monitors/store';
import { monitorsItem } from '../lib/storage/items';
import type { StrategyOutcome } from '../lib/monitors/strategies';
import type { Monitor } from '../lib/monitors/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log('\n=== Cuelume Sound Cue Tests (Sparkle & Error) ===');

// Assert volume is between 0.3 and 0.4
assert(CUE_VOLUME >= 0.3 && CUE_VOLUME <= 0.4, `CUE_VOLUME is subtle in 0.3-0.4 (got ${CUE_VOLUME})`);
assert(SPARKLE_VOLUME >= 0.3 && SPARKLE_VOLUME <= 0.4, `SPARKLE_VOLUME is subtle in 0.3-0.4 (got ${SPARKLE_VOLUME})`);
assert(ERROR_VOLUME >= 0.3 && ERROR_VOLUME <= 0.4, `ERROR_VOLUME is subtle in 0.3-0.4 (got ${ERROR_VOLUME})`);

let playedCues: { sound: string; volume: number }[] = [];
setCueListenerForTesting((sound, volume) => {
  playedCues.push({ sound, volume });
});

function outcomeFor(value: string): StrategyOutcome {
  return {
    value,
    diagnostic: { code: 'OK', message: 'ok' },
    updatedFingerprint: null,
    confidence: 100,
    method: 'exact',
    semanticValue: {
      type: 'currency',
      raw: value,
      normalized: parseFloat(value.replace(/[^0-9.]/g, '')),
      unit: '$',
    },
  };
}

const mockMonitor: Monitor = {
  id: 'm-cuelume-1',
  name: 'Test Monitor',
  url: 'https://example.com/test',
  intervalMinutes: 5,
  checkStrategy: 'fetch',
  consecutiveFailures: 0,
  consecutiveRelocations: 0,
  totalSuccessfulChecks: 1,
  enabled: true,
  createdAt: 1000,
  updatedAt: 1000,
  lastCheckedAt: 2000,
  lastValue: '$100.00',
  lastSemanticValue: {
    type: 'currency',
    raw: '$100.00',
    normalized: 100,
    unit: '$',
  },
  lastStatus: 'unchanged',
  lastError: null,
  lastDiagnosticCode: 'OK',
  lastConfidence: 100,
  extractMode: 'text',
  attributeName: null,
  fingerprint: {} as any,
  lastFingerprintUpdateAt: 1000,
  alertCondition: null,
  stats: null,
};

// Seed store
await monitorsItem.setValue([mockMonitor]);

// --- PART 1: Sparkle Cue Tests ---
console.log('\n--- Sparkle Cue (Value Change) ---');

// 1. Unchanged check -> NO cues
playedCues = [];
await recordSuccess(mockMonitor, 'fetch', outcomeFor('$100.00'));
assert(playedCues.length === 0, 'Unchanged check ($100 -> $100) plays no cues');

// 2. Genuinely changed value -> Plays sparkle cue at configured volume
playedCues = [];
await recordSuccess(mockMonitor, 'fetch', outcomeFor('$120.00'));
assert(playedCues.length === 1, 'Genuinely changed check ($100 -> $120) triggers 1 cue');
assert(playedCues[0]?.sound === 'sparkle', 'Plays sparkle sound cue');
assert(playedCues[0]?.volume === SPARKLE_VOLUME, `Plays sparkle with volume ${SPARKLE_VOLUME}`);

// 3. Initial check on brand new monitor (lastValue was null) -> NO sparkle cue
const newMonitor: Monitor = {
  ...mockMonitor,
  id: 'm-cuelume-new',
  lastValue: null,
  lastSemanticValue: null,
  totalSuccessfulChecks: 0,
};
const refreshedMon1 = await store.getMonitor('m-cuelume-1');
await monitorsItem.setValue([refreshedMon1.ok ? refreshedMon1.value : mockMonitor, newMonitor]);

playedCues = [];
await recordSuccess(newMonitor, 'fetch', outcomeFor('$50.00'));
assert(playedCues.length === 0, 'Initial check on new monitor (null -> $50) does NOT play sparkle cue');

// 4. Subsequent changed check on the new monitor -> Plays sparkle cue
playedCues = [];
const savedNew = await store.getMonitor('m-cuelume-new');
if (savedNew.ok) {
  await recordSuccess(savedNew.value, 'fetch', outcomeFor('$55.00'));
  assert(playedCues.length === 1, 'Second check with genuine change ($50 -> $55) DOES play sparkle cue');
  assert(playedCues[0]?.sound === 'sparkle', 'Sparkle cue played');
}

// 5. Retry with unchanged value -> NO sparkle cue
playedCues = [];
const currentMon = await store.getMonitor('m-cuelume-new');
if (currentMon.ok) {
  await recordSuccess(currentMon.value, 'fetch', outcomeFor('$55.00'));
  assert(playedCues.length === 0, 'Retry/check resulting in same value ($55 -> $55) does NOT play sparkle cue');
}

// --- PART 2: Error Cue Tests ---
console.log('\n--- Error Cue (Check Failure) ---');

// Reset m-cuelume-1 to a healthy state with lastValue
const healthyMonitor: Monitor = {
  ...mockMonitor,
  consecutiveFailures: 0,
  lastError: null,
  lastValue: '$120.00',
  lastSemanticValue: {
    type: 'currency',
    raw: '$120.00',
    normalized: 120,
    unit: '$',
  },
  totalSuccessfulChecks: 2,
};
await monitorsItem.setValue([healthyMonitor]);

// 6. First genuine check failure on an established monitor -> Plays error cue ONCE
playedCues = [];
await recordFailure(healthyMonitor, [{ code: 'ELEMENT_NOT_FOUND', message: 'Price element missing' }], 'fetch');
assert(playedCues.length === 1, 'First failure on established monitor triggers 1 cue');
assert(playedCues[0]?.sound === 'error', 'Plays error sound cue');
assert(playedCues[0]?.volume === ERROR_VOLUME, `Plays error with volume ${ERROR_VOLUME}`);

// 7. Repeated check / retry while the SAME error persists -> Does NOT play error cue again
playedCues = [];
const failedMon = await store.getMonitor('m-cuelume-1');
assert(failedMon.ok && failedMon.value.consecutiveFailures === 1, 'Monitor has consecutiveFailures = 1');
if (failedMon.ok) {
  await recordFailure(failedMon.value, [{ code: 'ELEMENT_NOT_FOUND', message: 'Price element missing' }], 'fetch');
  assert(playedCues.length === 0, 'Repeated failure while error persists does NOT play error cue again');
}

// 8. Further retry while still failing -> Does NOT play error cue
playedCues = [];
const failedMon2 = await store.getMonitor('m-cuelume-1');
assert(failedMon2.ok && failedMon2.value.consecutiveFailures === 2, 'Monitor has consecutiveFailures = 2');
if (failedMon2.ok) {
  await recordFailure(failedMon2.value, [{ code: 'ELEMENT_NOT_FOUND', message: 'Price element missing' }], 'fetch');
  assert(playedCues.length === 0, 'Third failure retry does NOT play error cue');
}

// 9. Initial check failure on brand-new monitor (never had a value) -> NO error cue
const brandNewMon: Monitor = {
  ...mockMonitor,
  id: 'm-brand-new',
  lastValue: null,
  lastSemanticValue: null,
  totalSuccessfulChecks: 0,
  consecutiveFailures: 0,
};
await monitorsItem.setValue([healthyMonitor, brandNewMon]);

playedCues = [];
await recordFailure(brandNewMon, [{ code: 'ELEMENT_NOT_FOUND', message: 'Never found' }], 'fetch');
assert(playedCues.length === 0, 'Initial failure during brand new monitor creation does NOT play error cue');

// 10. Recovery followed by a new failure -> DOES play error cue again (new failure state)
playedCues = [];
// Recover healthyMonitor
await recordSuccess(healthyMonitor, 'fetch', outcomeFor('$120.00'));
assert(playedCues.length === 0, 'Recovery with same value plays no cue');
const recoveredMon = await store.getMonitor('m-cuelume-1');
assert(recoveredMon.ok && recoveredMon.value.consecutiveFailures === 0, 'consecutiveFailures reset to 0 upon recovery');

// Now fail again -> This is a NEW failure state!
playedCues = [];
if (recoveredMon.ok) {
  await recordFailure(recoveredMon.value, [{ code: 'NETWORK_ERROR', message: 'Network timeout' }], 'fetch');
  assert(playedCues.length === 1, 'New failure state after recovery plays error cue again');
  assert(playedCues[0]?.sound === 'error', 'Plays error sound cue');
}

console.log('\nAll Cuelume sound cue tests passed!');
