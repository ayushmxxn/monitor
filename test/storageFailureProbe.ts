/**
 * Hermetic H3 probe. Runs in its own `bun` process so it gets a fresh
 * module registry: it installs a fake `chrome.storage` (with injectable
 * get/set failures) BEFORE importing the real storage/store modules,
 * exercising the genuine `safeDefineItem` branch instead of the
 * non-extension fallback items that unit tests otherwise see.
 *
 * Prints one JSON object to stdout; exits non-zero on unexpected error.
 * Not a `*.test.ts` file on purpose, so `bun test` doesn't run it
 * directly - `test/storageFailures.test.ts` spawns it and asserts.
 */
export {};

const mem = new Map<string, unknown>();
const failures = { get: null as Error | null, set: null as Error | null };
let setCalls = 0;

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

function makeArea() {
  return {
    get: async (keys?: unknown) => {
      if (failures.get) throw failures.get;
      return pick(keys);
    },
    set: async (items: Record<string, unknown>) => {
      setCalls += 1;
      if (failures.set) throw failures.set;
      for (const k of Object.keys(items)) mem.set(k, items[k]);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) mem.delete(k);
    },
    getBytesInUse: async () => 0,
    clear: async () => {
      mem.clear();
    },
  };
}

const sessionMem = new Map<string, unknown>();
const fakeChrome = {
  runtime: { id: 'h3-probe', getURL: (p: string) => `chrome-extension://h3-probe${p}` },
  storage: {
    local: makeArea(),
    session: {
      get: async (keys?: unknown) => {
        void keys;
        return {};
      },
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
void sessionMem;
(globalThis as any).chrome = fakeChrome;
(globalThis as any).browser = fakeChrome;

const { monitorsItem } = await import('../lib/storage/items');
const store = await import('../lib/monitors/store');

const out: Record<string, unknown> = {};
const snapshot = () => JSON.stringify([...mem].sort());

function seedMonitor(id: string) {
  return {
    id,
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

// Prime one existing monitor through the real stack (proves the fake works).
mem.set('monitors', [seedMonitor('seed-1')]);
const primed = await monitorsItem.getValue();
out.primeCount = Array.isArray(primed) ? primed.length : -1;

// 1. Read failure must reject (never resolve as empty/default data).
failures.get = new Error('read boom');
let rejected = false;
try {
  await monitorsItem.getValue();
} catch {
  rejected = true;
}
out.readRejects = rejected;
const listed = await store.listMonitors();
out.listErr = !listed.ok;
failures.get = null;

// 2. Write failure must propagate to the Result.
mem.set('monitors', [seedMonitor('seed-1')]);
failures.set = new Error('write boom');
const createdFail = await store.createMonitor({
  name: 'New',
  url: 'https://example.com/',
  fingerprint: {} as any,
  extractMode: 'text',
});
out.createWriteErr = !createdFail.ok && (createdFail as any).error?.code === 'STORAGE_WRITE_FAILED';
const updatedFail = await store.updateMonitor('seed-1', { enabled: false });
out.updateWriteErr = !updatedFail.ok && (updatedFail as any).error?.code === 'STORAGE_WRITE_FAILED';
failures.set = null;

// 3. Failed read during create/update must not overwrite existing data.
mem.set('monitors', [seedMonitor('seed-1')]);
const before = snapshot();
const setsBefore = setCalls;
failures.get = new Error('read boom');
const createdReadFail = await store.createMonitor({
  name: 'New',
  url: 'https://example.com/',
  fingerprint: {} as any,
  extractMode: 'text',
});
const updatedReadFail = await store.updateMonitor('seed-1', { enabled: false });
failures.get = null;
out.createReadErr = !createdReadFail.ok;
out.updateReadErr = !updatedReadFail.ok;
out.noOverwrite = snapshot() === before && setCalls === setsBefore;

// 4. Successful behavior unchanged.
mem.set('monitors', [seedMonitor('seed-1')]);
const created = await store.createMonitor({
  name: 'New',
  url: 'https://example.com/',
  fingerprint: {} as any,
  extractMode: 'text',
});
const afterCreate = await store.listMonitors();
const updated = await store.updateMonitor('seed-1', { enabled: false });
const fetched = await store.getMonitor('seed-1');
out.successCreate =
  created.ok &&
  afterCreate.ok &&
  (afterCreate as any).value.length === 2 &&
  (afterCreate as any).value.some((m: any) => m.id === (created as any).value.id);
out.successUpdate =
  updated.ok && fetched.ok && (fetched as any).value.enabled === false;

console.log(JSON.stringify(out));
