/**
 * Monitor home-screen ordering: pure helpers + persisted reorder.
 *
 * - Order helpers are the single source of truth for drag insertion,
 *   keyboard moves, and the filtered→global merge, so they are tested
 *   directly with fake rects (no DOM needed).
 * - `reorderMonitors` is exercised against the preloaded mock
 *   `chrome.storage` to prove the new order actually persists (i.e. a
 *   reload re-reads the same sequence) without touching any
 *   monitoring/checker logic.
 */
import { mockBrowser } from './mockBrowser';

(globalThis as any).browser = mockBrowser;
(globalThis as any).chrome = mockBrowser;

import {
  applyOrder,
  clampMoveIndex,
  computeInsertionIndex,
  mergeVisibleOrder,
  moveId,
  moveIdByDelta,
  sameIdOrder,
  toOrderRect,
} from '../lib/monitors/order';
import { monitorsItem } from '../lib/storage/items';
import { listMonitors, reorderMonitors } from '../lib/monitors/store';

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

function seedMonitor(id: string): any {
  return {
    id,
    name: `Monitor ${id}`,
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
    lastStatus: 'unchanged',
    lastError: null,
    lastDiagnosticCode: 'OK',
    checkStrategy: null,
    consecutiveFailures: 0,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 1,
    lastFingerprintUpdateAt: null,
    stats: null,
  };
}

// Fake 2-column grid: cards 160x80, gap 8. Row tops at 0, 88, 176...
function gridRect(col: number, row: number) {
  const left = col * (160 + 8);
  const top = row * (80 + 8);
  return toOrderRect({ left, top, right: left + 160, bottom: top + 80, width: 160, height: 80 });
}

section('1. moveId / moveIdByDelta / sameIdOrder');
{
  assert(JSON.stringify(moveId(['a', 'b', 'c', 'd'], 'c', 0)) === JSON.stringify(['c', 'a', 'b', 'd']), 'moves c to front');
  assert(JSON.stringify(moveId(['a', 'b', 'c'], 'a', 10)) === JSON.stringify(['b', 'c', 'a']), 'clamps overshoot to end');
  assert(JSON.stringify(moveId(['a', 'b', 'c'], 'c', -5)) === JSON.stringify(['c', 'a', 'b']), 'clamps undershoot to start');
  assert(JSON.stringify(moveId(['a', 'b'], 'z', 0)) === JSON.stringify(['a', 'b']), 'unknown id returns copy unchanged');
  const input = ['a', 'b', 'c'];
  const moved = moveId(input, 'a', 2);
  assert(input.join(',') === 'a,b,c' && moved.join(',') === 'b,c,a', 'does not mutate the input');
  assert(JSON.stringify(moveIdByDelta(['a', 'b', 'c', 'd'], 'b', 2)) === JSON.stringify(['a', 'c', 'd', 'b']), 'delta +2 moves down one row');
  assert(JSON.stringify(moveIdByDelta(['a', 'b', 'c', 'd'], 'c', -2)) === JSON.stringify(['c', 'a', 'b', 'd']), 'delta -2 moves up one row');
  assert(sameIdOrder(['a', 'b'], ['a', 'b']) === true, 'same order reports equal');
  assert(sameIdOrder(['a', 'b'], ['b', 'a']) === false, 'different order reports unequal');
  assert(sameIdOrder(['a'], ['a', 'b']) === false, 'different lengths report unequal');
  assert(clampMoveIndex(0, -1, 4) === 0, 'keyboard move clamps at start');
  assert(clampMoveIndex(3, 1, 4) === 3, 'keyboard move clamps at end');
  assert(clampMoveIndex(1, 2, 4) === 3, 'keyboard down-arrow (+2) lands one row below');
}

section('2. applyOrder keeps data, never drops');
{
  const monitors = [seedMonitor('a'), seedMonitor('b'), seedMonitor('c')];
  const reordered = applyOrder(monitors, ['c', 'a', 'b']);
  assert(reordered.map((m) => m.id).join(',') === 'c,a,b', 'reorders to the requested sequence');
  assert(reordered[0]?.name === 'Monitor c', 'carries the full monitor objects, not just ids');
  const withNew = applyOrder([...monitors, seedMonitor('d')], ['c', 'a', 'b']);
  assert(withNew.map((m) => m.id).join(',') === 'c,a,b,d', 'monitors missing from the order append in place');
  const withUnknown = applyOrder(monitors, ['c', 'zzz', 'a', 'b']);
  assert(withUnknown.map((m) => m.id).join(',') === 'c,a,b', 'unknown ids are ignored');
  assert(applyOrder([], ['a']).length === 0, 'empty list stays empty');
}

section('3. mergeVisibleOrder (filtered grid slots)');
{
  assert(
    JSON.stringify(mergeVisibleOrder(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'])) ===
      JSON.stringify(['d', 'c', 'b', 'a']),
    'unfiltered reorder applies exactly',
  );
  assert(
    JSON.stringify(mergeVisibleOrder(['a', 'b', 'c', 'd'], ['d', 'b'])) ===
      JSON.stringify(['a', 'd', 'c', 'b']),
    'filtered [b,d]->[d,b] swaps slots 1 and 3, others never move',
  );
  assert(
    JSON.stringify(mergeVisibleOrder(['a', 'b', 'c'], ['a', 'b', 'c'])) ===
      JSON.stringify(['a', 'b', 'c']),
    'no-op visible order leaves global untouched',
  );
  assert(
    JSON.stringify(mergeVisibleOrder(['a', 'b'], [])) === JSON.stringify(['a', 'b']),
    'empty visible order is a no-op, never blanks the list',
  );
}

section('4. computeInsertionIndex over a 2-column grid');
{
  // Full row pair: [a(0,0) b(1,0)], excluding nothing.
  const pair = [
    { id: 'a', rect: gridRect(0, 0) },
    { id: 'b', rect: gridRect(1, 0) },
  ];
  assert(computeInsertionIndex(50, -20, pair) === 0, 'pointer above all inserts at start');
  assert(computeInsertionIndex(50, 500, pair) === 2, 'pointer below all inserts at end');
  assert(computeInsertionIndex(40, 40, pair) === 0, 'left card left half inserts before it');
  assert(computeInsertionIndex(120, 40, pair) === 1, 'left card right half inserts after it (between)');
  assert(computeInsertionIndex(200, 40, pair) === 1, 'right card left half inserts between');
  assert(computeInsertionIndex(300, 40, pair) === 2, 'right card right half inserts after it');

  // Two rows of two: pointer in the second row selects within that row.
  const four = [
    { id: 'a', rect: gridRect(0, 0) },
    { id: 'b', rect: gridRect(1, 0) },
    { id: 'c', rect: gridRect(0, 1) },
    { id: 'd', rect: gridRect(1, 1) },
  ];
  assert(computeInsertionIndex(40, 128, four) === 2, 'second-row left half inserts at row start');
  assert(computeInsertionIndex(300, 128, four) === 4, 'second-row right half inserts at end');
  // Gap between rows maps to the shared boundary index from either side.
  assert(computeInsertionIndex(100, 84, four) === 2, 'gap just below row 0 maps to index 2');
  assert(computeInsertionIndex(100, 86, four) === 2, 'gap just above row 1 maps to the same index 2');

  // Incomplete last row (3 items, active removed): single item row still
  // splits at its center.
  const three = [
    { id: 'a', rect: gridRect(0, 0) },
    { id: 'b', rect: gridRect(1, 0) },
    { id: 'd', rect: gridRect(1, 1) },
  ];
  assert(computeInsertionIndex(40, 128, three) === 2, 'left hole in last row inserts before the right card');
  assert(computeInsertionIndex(300, 128, three) === 3, 'over the right card right half inserts after it');

  assert(computeInsertionIndex(10, 10, []) === 0, 'empty grid inserts at 0');
}

section('5. reorderMonitors persists order (reload restores it)');
{
  await monitorsItem.setValue([seedMonitor('a'), seedMonitor('b'), seedMonitor('c'), seedMonitor('d')]);
  const first = await reorderMonitors(['c', 'a', 'd', 'b']);
  assert(first.ok === true, 'reorder resolves ok');
  const afterDrop = ((await monitorsItem.getValue()) as any[]).map((m) => m.id);
  assert(afterDrop.join(',') === 'c,a,d,b', `storage holds the dropped order (got ${afterDrop.join(',')})`);

  // A "reload" is just another read: the exact order comes back.
  const reloaded = await listMonitors();
  assert(
    reloaded.ok && (reloaded.value as any[]).map((m) => m.id).join(',') === 'c,a,d,b',
    'listMonitors after reorder returns the same sequence',
  );

  // Monitor payloads survive the reorder untouched (only positions move).
  const values = (reloaded.ok ? (reloaded.value as any[]) : []).map((m) => m.lastValue);
  assert(values.every((v) => v === '$10.00'), 'reorder preserves every monitor payload');

  // Unknown ids never blank the list; missing ids append in place.
  const second = await reorderMonitors(['b', 'zzz', 'c']);
  assert(second.ok === true, 'reorder with unknown id still resolves ok');
  const merged = ((await monitorsItem.getValue()) as any[]).map((m) => m.id);
  assert(merged.join(',') === 'b,c,a,d', `unknown ignored, rest appended (got ${merged.join(',')})`);

  // No-op reorder leaves storage alone but still resolves ok.
  const noop = await reorderMonitors(['b', 'c', 'a', 'd']);
  assert(noop.ok === true, 'no-op reorder resolves ok');
  const still = ((await monitorsItem.getValue()) as any[]).map((m) => m.id);
  assert(still.join(',') === 'b,c,a,d', 'no-op keeps the stored sequence');
}

console.log(`\n${failures === 0 ? 'All monitor order tests passed.' : `${failures} monitor order assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
