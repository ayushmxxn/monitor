/**
 * H3: storage failures must propagate instead of silently becoming
 * fallback data or swallowed writes.
 *
 * The real `safeDefineItem` branch only activates under an extension
 * runtime, so this file spawns `test/storageFailureProbe.ts` in a fresh
 * `bun` process with a fake `chrome.storage` (injectable get/set
 * failures) and asserts on its JSON report. Hermetic by construction:
 * no globals leak into other test files.
 */

// Untyped on purpose: this repo's tsconfig has no `bun` module or
// `import.meta.dir` typings; runtime access needs no declarations.
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

section('H3: storage read/write failures propagate, never masquerade as data');

// Inherits the runner's cwd (the project root for every npm/bun script
// in this repo), so the probe path stays root-relative.
const proc = BunRuntime.spawnSync([process.execPath, 'test/storageFailureProbe.ts'], {
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
assert(report.primeCount === 1, 'probe reads seeded data through the real stack');

assert(report.readRejects === true, 'failed getValue() rejects instead of resolving fallback data');
assert(report.listErr === true, 'failed read surfaces as listMonitors() error');

assert(report.createWriteErr === true, 'failed write surfaces as createMonitor() STORAGE_WRITE_FAILED');
assert(report.updateWriteErr === true, 'failed write surfaces as updateMonitor() STORAGE_WRITE_FAILED');

assert(report.createReadErr === true, 'failed read fails createMonitor() instead of writing over empty data');
assert(report.updateReadErr === true, 'failed read fails updateMonitor() instead of clobbering');
assert(report.noOverwrite === true, 'no storage write happens after a failed read (existing data intact)');

assert(report.successCreate === true, 'successful create persists and lists the new monitor');
assert(report.successUpdate === true, 'successful update persists the patch');

console.log('\nAll storage failure propagation tests finished.');
