/**
 * M2: a stale in-flight check must not overwrite newer monitor state.
 *
 * The real commit gate only activates under an extension runtime, so
 * this file spawns `test/staleCheckProbe.ts` in a fresh `bun` process
 * with a fake `chrome.storage` and asserts on its JSON report.
 * Hermetic by construction: no globals leak into other test files.
 */

// Untyped on purpose: this repo's tsconfig has no `bun` typings.
const BunRuntime = (globalThis as { Bun?: any }).Bun;

export {};

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

section('M2: stale checks never overwrite newer state, history, or alerts');

const proc = BunRuntime.spawnSync([process.execPath, 'test/staleCheckProbe.ts'], {
  stdout: 'pipe',
  stderr: 'pipe',
  timeout: 60_000,
});

assert(proc.exitCode === 0, `probe process exits cleanly (got ${proc.exitCode})`);
if (proc.exitCode !== 0) {
  console.error(String(proc.stderr ?? ''));
  throw new Error('probe failed to run');
}

const report = JSON.parse(String(proc.stdout).trim().split('\n').pop() ?? '{}');

assert(report.deletedNoMonitor === true, 'deleted monitor stays deleted after stale commit');
assert(report.deletedNoHistory === true, 'deleted monitor history is not recreated');
assert(report.deletedNoAlert === true, 'no alert for a deleted monitor');

assert(report.disabledStillDisabled === true, 'disabled monitor stays disabled after stale commit');
assert(report.disabledValueKept === true, 'disabled monitor value is not overwritten');
assert(report.disabledNoHistory === true, 'disabled monitor gets no history entry');
assert(report.disabledNoAlert === true, 'no alert for a disabled monitor');

assert(report.renameKept === true, 'rename during check is preserved');
assert(report.renameValueCommitted === true, 'fresh result still committed alongside rename');
assert(report.renameHistory === true, 'history appended for the committed result');
assert(report.renameAlert === true, 'alert still fires for the committed change');

assert(report.successValue === true, 'normal success commits the new value');
assert(report.successStatus === true, 'normal success sets changed status');
assert(report.successHistory === true, 'normal success appends changed history');
assert(report.successAlert === true, 'normal success notifies');

assert(report.failCounted === true, 'normal failure increments consecutiveFailures');
assert(report.failValueKept === true, 'normal failure preserves lastValue');
assert(report.failStatus === true, 'temporary failure keeps healthy status');
assert(report.failHistory === true, 'normal failure appends an error history entry');

console.log('\nAll stale-check guard tests finished.');
