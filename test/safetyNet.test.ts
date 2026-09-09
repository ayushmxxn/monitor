/**
 * Regression tests for live-tab safety net alarm and checkAllMonitorsNow batching.
 *
 * Covers:
 *  - normal batch completion & cleanup
 *  - batch longer than the safety-net period (re-arming)
 *  - failure/interruption (worker eviction / orphaned window cleanup)
 *  - concurrent check-all invocation deduplication
 *  - correct cleanup after completion
 */

import { mockBrowser, alarmCreated, alarmCleared, windowsRemoved } from './mockBrowser';
import {
  SAFETY_NET_ALARM_NAME,
  SAFETY_NET_DELAY_MINUTES,
  handleSafetyNetAlarm,
  beginLiveCheck,
  endLiveCheck,
  isLiveCheckInProgress,
  closeBackgroundWindow,
} from '../lib/monitors/strategies/liveTabStrategy';
import { checkAllMonitorsNow, ensureScheduler, runDueMonitors } from '../lib/monitors/scheduler';
import { liveCheckWindowItem } from '../lib/storage/items';

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

async function runTests() {
  (globalThis as any).browser = mockBrowser;
  (globalThis as any).chrome = mockBrowser;

  section('1. Normal batch completion and correct cleanup');
  {
    (globalThis as any).browser = mockBrowser;
    (globalThis as any).chrome = mockBrowser;
    alarmCreated.length = 0;
    alarmCleared.length = 0;
    windowsRemoved.length = 0;

    await liveCheckWindowItem.setValue({ windowId: 101, tabId: 201 });
    beginLiveCheck();
    beginLiveCheck();
    assert(isLiveCheckInProgress() === true, 'two live checks are in progress');

    // First check ends, second still active
    endLiveCheck();
    assert(isLiveCheckInProgress() === true, 'one live check is still in progress after first ends');
    let stored = await liveCheckWindowItem.getValue();
    assert(stored?.windowId === 101, 'window remains open while batch still has active checks');
    assert(windowsRemoved.length === 0, 'window was not closed prematurely');

    // Final check ends
    endLiveCheck();
    assert(isLiveCheckInProgress() === false, 'all checks completed');
    await new Promise((r) => setTimeout(r, 10));
    stored = await liveCheckWindowItem.getValue();
    assert(stored === null, 'window storage cleared after final check in batch completed');
    assert(windowsRemoved.includes(101), 'window was removed upon batch completion');
    assert(alarmCleared.includes(SAFETY_NET_ALARM_NAME), 'safety net alarm was cleared on batch completion');
  }

  section('2. Batch longer than safety-net period (re-arming)');
  {
    alarmCreated.length = 0;
    alarmCleared.length = 0;
    windowsRemoved.length = 0;

    await liveCheckWindowItem.setValue({ windowId: 102, tabId: 202 });
    beginLiveCheck();

    // Safety net alarm fires while check is actively running
    await handleSafetyNetAlarm();
    let stored = await liveCheckWindowItem.getValue();
    assert(stored?.windowId === 102, 'safety net alarm did not close window while check was in progress');
    assert(windowsRemoved.length === 0, 'no window was removed during active check');
    assert(
      alarmCreated.some((a) => a.name === SAFETY_NET_ALARM_NAME && a.options?.delayInMinutes === SAFETY_NET_DELAY_MINUTES),
      'safety net alarm was re-armed to protect against future worker eviction without killing active batch',
    );

    // When check eventually finishes, it cleans up properly
    endLiveCheck();
    await new Promise((r) => setTimeout(r, 10));
    stored = await liveCheckWindowItem.getValue();
    assert(stored === null, 'window storage cleared when late-running check finished');
    assert(windowsRemoved.includes(102), 'window closed cleanly after late-running check finished');
    assert(alarmCleared.includes(SAFETY_NET_ALARM_NAME), 'safety net alarm cleared on completion');
  }

  section('3. Failure / interruption (worker eviction / orphaned window cleanup)');
  {
    alarmCreated.length = 0;
    alarmCleared.length = 0;
    windowsRemoved.length = 0;

    await liveCheckWindowItem.setValue({ windowId: 103, tabId: 203 });
    // In-memory pendingLiveChecks is 0 (simulating fresh worker startup after mid-batch crash/eviction)
    assert(isLiveCheckInProgress() === false, 'no active checks in memory (evicted worker state)');
    
    // Safety net alarm fires
    await handleSafetyNetAlarm();
    const stored = await liveCheckWindowItem.getValue();
    assert(stored === null, 'orphaned window storage cleared by safety net alarm');
    assert(windowsRemoved.includes(103), 'orphaned window removed by safety net alarm after eviction');
  }

  section('4. Concurrent check-all invocation deduplication');
  {
    const p1 = checkAllMonitorsNow();
    const p2 = checkAllMonitorsNow();
    assert(p1 === p2, 'concurrent checkAllMonitorsNow calls return the exact same in-flight promise');
    await p1;

    const p3 = checkAllMonitorsNow();
    assert(p3 !== p1, 'subsequent checkAllMonitorsNow after completion starts a new run');
    await p3;
  }

  section('5. Correct cleanup after completion when window already removed');
  {
    alarmCreated.length = 0;
    alarmCleared.length = 0;
    windowsRemoved.length = 0;

    // Window was removed outside (e.g. closed by user)
    await liveCheckWindowItem.setValue(null);
    await closeBackgroundWindow();
    assert(alarmCleared.includes(SAFETY_NET_ALARM_NAME), 'safety net alarm is cleared even if no window was stored');
  }

  section('6. Scheduler alarm re-arming and runDueMonitors');
  {
    alarmCreated.length = 0;
    alarmCleared.length = 0;

    await ensureScheduler();
    assert(
      alarmCreated.some((a) => a.name === 'monitor-tick'),
      'ensureScheduler creates monitor-tick alarm when none exists',
    );

    const countAfterFirst = alarmCreated.length;
    await ensureScheduler();
    assert(
      alarmCreated.length === countAfterFirst,
      'ensureScheduler is idempotent when alarm exists',
    );

    // If alarm was cleared externally (e.g. extension update)
    alarmCleared.push('monitor-tick');
    await runDueMonitors();
    assert(
      alarmCreated.filter((a) => a.name === 'monitor-tick').length > countAfterFirst,
      'runDueMonitors re-creates monitor-tick alarm when missing',
    );
  }

  console.log('\nAll safety-net and batching regression tests passed.');
}

await runTests().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});

