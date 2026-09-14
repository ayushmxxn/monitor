import './mockBrowser';
import {
  setCueListenerForTesting,
  setSoundEnabledForTesting,
  isSoundEnabled,
  syncSoundSetting,
  playCue,
  playSparkleCue,
  playErrorCue,
  SPARKLE_VOLUME,
  ERROR_VOLUME,
} from '../lib/monitors/sound';
import { recordSuccess, recordFailure } from '../lib/monitors/checker';
import { settingsItem, monitorsItem, migrateSettingsV6 } from '../lib/storage/items';
import { DEFAULT_SETTINGS, type AppSettings } from '../lib/storage/schema';
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

console.log('\n=== Global Sound Setting Tests ===');

// --- 1. Default Setting Verification ---
console.log('\n--- 1. Defaults & Initial State ---');
assert(DEFAULT_SETTINGS.soundEnabled === true, 'DEFAULT_SETTINGS has soundEnabled: true');

const initialSettings = await settingsItem.getValue();
assert(initialSettings.soundEnabled === true, 'settingsItem resolves soundEnabled: true by default');
assert(isSoundEnabled() === true, 'sound.ts isSoundEnabled() returns true by default');

let playedCues: { sound: string; volume: number }[] = [];
setCueListenerForTesting((sound, volume) => {
  playedCues.push({ sound, volume });
});

// Direct cues play when enabled
playedCues = [];
playSparkleCue();
assert(playedCues.length === 1 && playedCues[0].sound === 'sparkle', 'playSparkleCue() plays when soundEnabled is true');

playedCues = [];
playErrorCue();
assert(playedCues.length === 1 && playedCues[0].sound === 'error', 'playErrorCue() plays when soundEnabled is true');

// --- 2. Suppression when Sound is OFF ---
console.log('\n--- 2. Suppression when Sound is OFF ---');

// Persistently disable sound in settings
await settingsItem.setValue({
  ...initialSettings,
  soundEnabled: false,
});
await syncSoundSetting();

const disabledSettings = await settingsItem.getValue();
assert(disabledSettings.soundEnabled === false, 'Persistent setting correctly stored as soundEnabled: false');
assert(isSoundEnabled() === false, 'sound.ts recognizes soundEnabled is false');

// Direct cues must be suppressed
playedCues = [];
playSparkleCue();
assert(playedCues.length === 0, 'playSparkleCue() is suppressed when sound is OFF');

playedCues = [];
playErrorCue();
assert(playedCues.length === 0, 'playErrorCue() is suppressed when sound is OFF');

playedCues = [];
playCue('sparkle');
playCue('error');
assert(playedCues.length === 0, 'playCue() is suppressed when sound is OFF');

// Monitor checker integration: Value change must NOT trigger sound cue when OFF
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

const testMonitor: Monitor = {
  id: 'm-sound-test-1',
  name: 'Sound Test Monitor',
  url: 'https://example.com/sound',
  intervalMinutes: 5,
  checkStrategy: 'fetch',
  consecutiveFailures: 0,
  consecutiveRelocations: 0,
  totalSuccessfulChecks: 2,
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

await monitorsItem.setValue([testMonitor]);

playedCues = [];
await recordSuccess(testMonitor, 'fetch', outcomeFor('$150.00'));
assert(playedCues.length === 0, 'Checker value change ($100 -> $150) triggers NO sound when sound is OFF');

// Monitor checker integration: Check failure must NOT trigger error cue when OFF
playedCues = [];
await recordFailure(testMonitor, [{ code: 'ELEMENT_NOT_FOUND', message: 'Element missing' }], 'fetch');
assert(playedCues.length === 0, 'Checker failure triggers NO error cue when sound is OFF');

// --- 3. Re-enabling Sound (ON) ---
console.log('\n--- 3. Restoring Sound to ON ---');

// Persistently re-enable sound in settings
await settingsItem.setValue({
  ...initialSettings,
  soundEnabled: true,
});
await syncSoundSetting();

const reenabledSettings = await settingsItem.getValue();
assert(reenabledSettings.soundEnabled === true, 'Persistent setting correctly stored as soundEnabled: true');
assert(isSoundEnabled() === true, 'sound.ts recognizes soundEnabled is restored to true');

// Value change cue now triggers
playedCues = [];
await recordSuccess(testMonitor, 'fetch', outcomeFor('$175.00'));
assert(playedCues.length === 1 && playedCues[0].sound === 'sparkle', 'Checker value change plays sparkle cue when sound is ON');
assert(playedCues[0].volume === SPARKLE_VOLUME, 'Sparkle volume matches SPARKLE_VOLUME');

// Direct cues work again
playedCues = [];
playErrorCue();
assert(playedCues.length === 1 && playedCues[0].sound === 'error', 'Error cue plays when sound is ON');
assert(playedCues[0].volume === ERROR_VOLUME, 'Error volume matches ERROR_VOLUME');

// --- 4. Schema Migration & Fallback ---
console.log('\n--- 4. Schema Migrations ---');
// If stored settings have no soundEnabled field (from v5 or earlier)
const v5Stored = {
  schemaVersion: 5,
  notificationsEnabled: true,
  defaultIntervalMinutes: 15,
  theme: 'dark' as const,
};
const migrated = migrateSettingsV6(v5Stored);
assert(migrated.soundEnabled === true, 'v5 settings missing soundEnabled default to soundEnabled: true');
assert(migrated.theme === 'dark', 'Existing settings are preserved during migration');
assert(migrated.defaultIntervalMinutes === 15, 'defaultIntervalMinutes preserved during migration');

// If stored settings had soundEnabled explicitly set to false
const v5StoredWithFalse = {
  schemaVersion: 5,
  notificationsEnabled: true,
  soundEnabled: false,
};
const migratedFalse = migrateSettingsV6(v5StoredWithFalse);
assert(migratedFalse.soundEnabled === false, 'Stored soundEnabled: false is preserved during migration');

// Clean up test listener
setCueListenerForTesting(null);
setSoundEnabledForTesting(null);

console.log('\nAll Global Sound Setting tests passed!');
