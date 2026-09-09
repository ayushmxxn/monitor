/**
 * M6: a failed permission *check* is not a permission *denial*.
 *
 * Spawns `test/permissionCheckProbe.ts` in a fresh `bun` process (fake
 * `chrome.permissions` + neutralized strategies) which drives the real
 * exported `runCheck` through all three permission outcomes, then
 * asserts on its JSON report. Hermetic: no globals leak into other
 * test files.
 */
export {};

// Untyped on purpose: this repo's tsconfig has no `bun` typings.
const BunRuntime = (globalThis as { Bun?: any }).Bun;

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

section('M6: permission API errors are retryable, denials stay denied');

const proc6 = BunRuntime.spawnSync([process.execPath, 'test/permissionCheckProbe.ts'], {
  stdout: 'pipe',
  stderr: 'pipe',
  timeout: 60_000,
});

assert(proc6.exitCode === 0, `probe process exits cleanly (got ${proc6.exitCode})`);
if (proc6.exitCode !== 0) {
  console.error(String(proc6.stderr ?? ''));
  throw new Error('probe failed to run');
}

const report6 = JSON.parse(String(proc6.stdout).trim().split('\n').pop() ?? '{}');

assert(report6.deniedCode === 'PERMISSION_DENIED', 'genuine denial records PERMISSION_DENIED');
assert(report6.deniedFailures === 1, 'denial increments consecutiveFailures');
assert(report6.deniedValueKept === true, 'denial preserves lastValue');
assert(report6.deniedStatus === 'error', 'denial stays immediately permanent (behavior preserved)');
assert(report6.deniedNoStrategy === true, 'denial runs no strategies');
assert(report6.deniedHistory === 1, 'denial still records history');

assert(report6.errCode === 'UNKNOWN', 'API error records UNKNOWN, not PERMISSION_DENIED');
assert(report6.errFailures === 1, 'API error increments consecutiveFailures');
assert(report6.errValueKept === true, 'API error preserves lastValue');
assert(report6.errStatus === 'unchanged', 'API error stays temporary (healthy status kept)');
assert(report6.errNoStrategy === true, 'API error runs no strategies');
assert(report6.errHistory === 1, 'API error still records history');
assert(report6.errMentionsCause === true, 'API error keeps the underlying cause for debugging');
assert(report6.errRetryable === true, 'UNKNOWN failure offers a working Retry action');

assert(report6.grantedRuns === 1, 'granted permission runs the strategy cascade');
assert(report6.grantedValue === '$11.00', 'granted check commits the extracted value');
assert(report6.grantedStatus === 'changed', 'granted check detects the change');
assert(report6.grantedHistory === 1, 'granted check appends history');
assert(report6.grantedAlert === 1, 'granted check still notifies');

console.log('\nAll permission-branch tests finished.');
