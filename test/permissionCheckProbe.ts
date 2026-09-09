/**
 * Hermetic M6 probe. Runs in its own `bun` process so it gets a fresh
 * module registry: it installs a fake `chrome` (storage area,
 * programmable `permissions.contains`, recording notifications) BEFORE
 * importing the real checker/store/strategies modules, then drives the
 * real exported `runCheck` through all three permission outcomes.
 * Strategies are neutralized by replacing the mutable STRATEGIES record
 * entries (no network, no tabs).
 *
 * Prints one JSON object to stdout; exits non-zero on unexpected error.
 * Not a `*.test.ts` file on purpose - `test/permissionCheck.test.ts`
 * spawns it and asserts.
 */
export {};

const mem = new Map<string, unknown>();
let permMode: 'allow' | 'deny' | 'throw' = 'allow';
const notifications: Array<string> = [];
let strategyRuns = 0;

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

const fakeChrome = {
  runtime: { id: 'm6-probe', getURL: (p: string) => `chrome-extension://m6-probe${p}` },
  notifications: {
    create: async (id: string) => {
      notifications.push(id);
      return id;
    },
  },
  permissions: {
    contains: async () => {
      if (permMode === 'throw') throw new Error('permission backend unavailable');
      return permMode === 'allow';
    },
    request: async () => false,
    remove: async () => false,
  },
  storage: {
    local: {
      get: async (keys?: unknown) => pick(keys),
      set: async (items: Record<string, unknown>) => {
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
const strategies = await import('../lib/monitors/strategies');
const { getFailureStateInfo } = await import('../lib/monitors/diagnostics');

// Neutralize strategy execution: fast, deterministic, no network/tabs.
(strategies as any).STRATEGIES.fetch = {
  id: 'fetch',
  run: async () => {
    strategyRuns += 1;
    return {
      value: '$11.00',
      diagnostic: { code: 'OK', message: 'Checked successfully.', detail: null },
      updatedFingerprint: null,
      confidence: 100,
      method: 'test',
      semanticValue: null,
    };
  },
};
(strategies as any).STRATEGIES.live = {
  id: 'live',
  run: async () => {
    strategyRuns += 1;
    return {
      value: null,
      diagnostic: { code: 'UNKNOWN', message: 'not used', detail: null },
      updatedFingerprint: null,
      confidence: 0,
      method: 'none',
      semanticValue: null,
    };
  },
};

const out: Record<string, unknown> = {};

function seedMonitor() {
  return {
    id: 'm6-1',
    name: 'M6 Monitor',
    url: 'https://example.com/item',
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

function reset() {
  mem.clear();
  notifications.length = 0;
  strategyRuns = 0;
  mem.set('monitors', [seedMonitor()]);
}

async function snapshot() {
  const fetched = await store.getMonitor('m6-1');
  const history = await store.getHistory('m6-1');
  return { fetched, history };
}

// 1. Genuine denial: PERMISSION_DENIED, immediately permanent, no strategies.
reset();
permMode = 'deny';
await (checker as any).runCheck({ ...(mem.get('monitors') as any[])[0] });
{
  const { fetched, history } = await snapshot();
  out.deniedCode = (fetched as any).value.lastDiagnosticCode;
  out.deniedFailures = (fetched as any).value.consecutiveFailures;
  out.deniedValueKept = (fetched as any).value.lastValue === '$10.00';
  out.deniedStatus = (fetched as any).value.lastStatus;
  out.deniedNoStrategy = strategyRuns === 0;
  out.deniedHistory = (history as any).value.length;
}

// 2. API error: UNKNOWN, temporary/retryable, no strategies.
reset();
permMode = 'throw';
await (checker as any).runCheck({ ...(mem.get('monitors') as any[])[0] });
{
  const { fetched, history } = await snapshot();
  out.errCode = (fetched as any).value.lastDiagnosticCode;
  out.errFailures = (fetched as any).value.consecutiveFailures;
  out.errValueKept = (fetched as any).value.lastValue === '$10.00';
  out.errStatus = (fetched as any).value.lastStatus;
  out.errNoStrategy = strategyRuns === 0;
  out.errHistory = (history as any).value.length;
  out.errMentionsCause = String((fetched as any).value.lastError ?? '').includes('permission backend unavailable');
  out.errRetryable = getFailureStateInfo('UNKNOWN').canRetry === true;
}

// 3. Granted: check proceeds normally through the strategy.
reset();
permMode = 'allow';
await (checker as any).runCheck({ ...(mem.get('monitors') as any[])[0] });
{
  const { fetched, history } = await snapshot();
  out.grantedRuns = strategyRuns;
  out.grantedValue = (fetched as any).value.lastValue;
  out.grantedStatus = (fetched as any).value.lastStatus;
  out.grantedHistory = (history as any).value.length;
  out.grantedAlert = notifications.length;
}

console.log(JSON.stringify(out));
