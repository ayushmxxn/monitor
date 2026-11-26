import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_DIR = 'test';
const PRELOAD_PATH = './test/mockBrowser.ts';

const testFiles = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.ts') || name.endsWith('.test.tsx'))
  .sort((a, b) => a.localeCompare(b))
  .map((name) => join(TEST_DIR, name));

if (testFiles.length === 0) {
  console.error('No test files found under test/.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} isolated test suites...\n`);

for (const file of testFiles) {
  console.log(`\n>>> ${file}`);
  const result = spawnSync(process.execPath, ['--preload', PRELOAD_PATH, file], {
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Failed to execute ${file}:`, result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\nTest suite failed: ${file} (exit code ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${testFiles.length} test suites passed.`);
