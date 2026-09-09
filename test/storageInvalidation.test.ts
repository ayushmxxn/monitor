/**
 * Focused regression test for:
 * 1. 'wxt/storage' must be loaded in a web extension environment
 * 2. Uncaught TypeError: Cannot read properties of undefined (reading 'onMessage')
 * 3. Safe cleanup and unwatch handling during context invalidation
 */

import './mockBrowser';
import { settingsItem, monitorsItem, historyItem } from '../lib/storage/items';
import { onMessage } from '../lib/messaging';

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
  section('1. Valid extension environment operations');
  {
    const settings = await settingsItem.getValue();
    assert(settings !== null && typeof settings === 'object', 'settingsItem reads default settings');
    assert(settings.theme === 'light', 'settings has expected default theme');

    const item1 = historyItem('test-monitor-1');
    const item2 = historyItem('test-monitor-1');
    assert(item1 === item2, 'historyItem returns cached instance for same monitorId');

    const history = await item1.getValue();
    assert(Array.isArray(history), 'historyItem returns array fallback');
  }

  section('2. onMessage safe unregister against invalidated context');
  {
    const unregister = onMessage('ping' as any, () => 'pong');
    assert(typeof unregister === 'function', 'onMessage returns unregister function');

    // Simulate context invalidation where chrome.runtime becomes undefined
    const origChrome = (globalThis as any).chrome;
    try {
      (globalThis as any).chrome = {};
      let threw = false;
      try {
        unregister();
      } catch (err) {
        threw = true;
      }
      assert(!threw, 'unregistering message listener when context is invalidated does not throw');
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  }

  section('3. Storage items resilience when context is invalidated');
  {
    const origChrome = (globalThis as any).chrome;
    const origBrowser = (globalThis as any).browser;
    try {
      // Simulate invalidated context (runtime.id is absent/undefined)
      (globalThis as any).chrome = { ...origChrome, runtime: {} };
      (globalThis as any).browser = { ...origBrowser, runtime: {} };

      let threw = false;
      let dynamicItem: any = null;
      try {
        // Calling historyItem on an invalidated context must not throw
        dynamicItem = historyItem('invalid-context-monitor');
      } catch (err) {
        threw = true;
      }
      assert(!threw, 'historyItem on invalidated context does not throw');
      assert(dynamicItem !== null, 'dynamicItem is created as fallback item');

      const val = await dynamicItem.getValue();
      assert(Array.isArray(val) && val.length === 0, 'fallback item getValue resolves fallback array');

      // Unwatch on fallback item must not throw
      let unwatchThrew = false;
      try {
        const unwatch = dynamicItem.watch(() => {});
        unwatch();
      } catch {
        unwatchThrew = true;
      }
      assert(!unwatchThrew, 'unwatch on fallback item does not throw');
    } finally {
      (globalThis as any).chrome = origChrome;
      (globalThis as any).browser = origBrowser;
    }
  }

  console.log('\nAll storage invalidation regression tests finished.');
}

await runTests();
