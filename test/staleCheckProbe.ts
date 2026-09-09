/**
 * Hermetic M2 probe. Runs in its own `bun` process so it gets a fresh
 * module registry: it installs a fake `chrome.storage` (+ minimal
 * notifications stub) BEFORE importing the real checker/store modules,
 * exercising the genuine storage branch instead of the non-extension
 * fallback items that unit tests otherwise see.
 *
 * Simulates the M2 race by snapshotting a monitor (as runCheck does at
 * check start), mutating it through the real store (as the user would
 * mid-check: rename / disable / delete), then committing via the real
 * recordSuccess/recordFailure with the stale snapshot.
 *
 * Prints one JSON object to stdout; exits non-zero on unexpected error.
 * Not a `*.test.ts` file on purpose - `test/staleCheck.test.ts` spawns
 * it and asserts.
 */
export {};

const mem = new Map<string, unknown>();
const failures = { get: null as Error | null, set: null as Error | null };

function pick(keys: unknown): Record<string, unknown> {
  if (keys == null) return Object.fromEntries(mem);
  if (typeof keys === 'string') {
    return mem.has(keys) ? { [keys]: mem.get(keys) } : {};
  }
  if (Array.isArray(keys)) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (mem.has(k)) out[k] = mem.get(k);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(keys as Record<string, unknown>)) {
    out[k] = mem.has(k) ? mem.get(k) : (keys as Record<string, unknown>)[k];
  }
  return out;
}

const notifications: Array<string> = [];
const fakeChrome = {
  runtime: { id: 'm2-probe', getURL: (p: string) => `chrome-extension://m2-probe${p}` },
  notifications: {
    create: async (id: string) => {
      notifications.push(id);
      return id;
    },
  },
  storage: {
    local: {
      get: async (keys?: unknown) => {
        if (failures.get) throw failures.get;
        return pick(keys);
      },
      set: async (items: Record<string, unknown>) => {
        if (failures.set) throw failures.set;
        for (const k of Object.keys(items)) mem.set(k, items[k]);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) mem.delete(k);
      },
      getBytesInUse: async () => 0,
    },
    session: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
      getBytesInUse: async () => 0,
    },
    onChanged: {
      addListener: () => {},
      removeListener: () => {},
      hasListener: () => false,
    },
  },
};
(globalThis as any).chrome = fakeChrome;
(globalThis as any).browser = fakeChrome;

const store = await import('../lib/monitors/store');
const checker = await import('../lib/monitors/checker');
const { diagnostic } = await import('../lib/monitors/diagnostics');
const { detectSemanticValue } = await import('../lib/monitors/semanticValue');

const out: Record<string, unknown> = {};
const historyKeys = () => [...mem.keys()].filter((k) => k.startsWith('history:'));

function seedMonitor() {
  return {
    id: 'm1',
    name: 'Seed',
    url: 'https://example.com/',
    fingerprint: {},
    extractMode: 'text',
    attributeName: null,
    intervalMinutes: 30,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: null,
    lastValue: '$10.00',
    lastSemanticValue: null,
    lastStatus: 'unchanged',
    lastError: null,
    lastDiagnosticCode: null,
    checkStrategy: null,
    consecutiveFailures: 0,
    lastConfidence: null,
    consecutiveRelocations: 0,
    totalSuccessfulChecks: 0,
    lastFingerprintUpdateAt: null,
    stats: null,
  };
}

function outcomeFor(text: string) {
  return {
    value: text,
    diagnostic: diagnostic('OK'),
    updatedFingerprint: null,
    confidence: 100,
    method: 'test',
    semanticValue: detectSemanticValue(text),
  };
}

function reset() {
  mem.clear();
  notifications.length = 0;
  mem.set('monitors', [seedMonitor()]);
}

// 1. Deleted during check -> no write, no history, no alert.
reset();
const snapDeleted = { ...(mem.get('monitors') as any[])[0] };
await store.deleteMonitor('m1');
await (checker as any).recordSuccess(snapDeleted, 'fetch', outcomeFor('$11.00'));
{
  const listed = await store.listMonitors();
  out.deletedNoMonitor = listed.ok && (listed as any).value.length === 0;
  out.deletedNoHistory = historyKeys().length === 0;
  out.deletedNoAlert = notifications.length === 0;
}

// 2. Disabled during check -> no stale result, no alert.
reset();
const snapDisabled = { ...(mem.get('monitors') as any[])[0] };
await store.updateMonitor('m1', { enabled: false });
await (checker as any).recordSuccess(snapDisabled, 'fetch', outcomeFor('$11.00'));
{
  const fetched = await store.getMonitor('m1');
  out.disabledStillDisabled = fetched.ok && (fetched as any).value.enabled === false;
  out.disabledValueKept = fetched.ok && (fetched as any).value.lastValue === '$10.00';
  out.disabledNoHistory = historyKeys().length === 0;
  out.disabledNoAlert = notifications.length === 0;
}

// 3. Renamed during check -> rename preserved, result still committed.
reset();
const snapRenamed = { ...(mem.get('monitors') as any[])[0] };
await store.updateMonitor('m1', { name: 'New Name' });
await (checker as any).recordSuccess(snapRenamed, 'fetch', outcomeFor('$11.00'));
{
  const fetched = await store.getMonitor('m1');
  const history = await store.getHistory('m1');
  out.renameKept = fetched.ok && (fetched as any).value.name === 'New Name';
  out.renameValueCommitted = fetched.ok && (fetched as any).value.lastValue === '$11.00';
  out.renameHistory = history.ok && (history as any).value.length === 1;
  out.renameAlert = notifications.length === 1;
}

// 4. Normal successful check -> unchanged behavior.
reset();
const snapOk = { ...(mem.get('monitors') as any[])[0] };
await (checker as any).recordSuccess(snapOk, 'fetch', outcomeFor('$11.00'));
{
  const fetched = await store.getMonitor('m1');
  const history = await store.getHistory('m1');
  out.successValue = fetched.ok && (fetched as any).value.lastValue === '$11.00';
  out.successStatus = fetched.ok && (fetched as any).value.lastStatus === 'changed';
  out.successHistory = history.ok && (history as any).value.length === 1 && (history as any).value[0].changed === true;
  out.successAlert = notifications.length === 1;
}

// 5. Normal failed check -> unchanged behavior.
reset();
const snapFail = { ...(mem.get('monitors') as any[])[0] };
await (checker as any).recordFailure(snapFail, [diagnostic('NETWORK_ERROR', 'x')], null);
{
  const fetched = await store.getMonitor('m1');
  const history = await store.getHistory('m1');
  out.failCounted = fetched.ok && (fetched as any).value.consecutiveFailures === 1;
  out.failValueKept = fetched.ok && (fetched as any).value.lastValue === '$10.00';
  out.failStatus = fetched.ok && (fetched as any).value.lastStatus === 'unchanged';
  out.failHistory =
    history.ok && (history as any).value.length === 1 && (history as any).value[0].error !== null;
}

console.log(JSON.stringify(out));
