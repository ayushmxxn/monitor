function createStorageArea() {
  const storageMap = new Map<string, any>();
  return {
    get: async (keys?: any) => {
      if (!keys) return Object.fromEntries(storageMap.entries());
      if (typeof keys === 'string') return { [keys]: storageMap.get(keys) };
      if (Array.isArray(keys)) {
        const res: Record<string, any> = {};
        for (const k of keys) res[k] = storageMap.get(k);
        return res;
      }
      const res: Record<string, any> = { ...keys };
      for (const k of Object.keys(keys)) {
        if (storageMap.has(k)) res[k] = storageMap.get(k);
      }
      return res;
    },
    set: async (items: Record<string, any>) => {
      for (const [k, v] of Object.entries(items)) storageMap.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) storageMap.delete(k);
    },
    clear: async () => {
      storageMap.clear();
    },
  };
}

export const alarmCreated: { name: string; options: any }[] = [];
export const alarmCleared: string[] = [];
export const windowsRemoved: number[] = [];

export const mockBrowser = {
  runtime: {
    id: 'mock-extension-id',
    getURL: (path: string) => `chrome-extension://mock${path}`,
    onMessage: {
      addListener: () => {},
      removeListener: () => {},
    },
  },
  notifications: {
    create: async () => {},
    onClicked: {
      addListener: () => {},
    },
  },
  tabs: {
    query: async () => [],
    create: async () => ({ id: 1 }),
    update: async () => ({ id: 1 }),
  },
  alarms: {
    create: (name: string, options: any) => {
      alarmCreated.push({ name, options });
    },
    get: async (name: string) => {
      const created = alarmCreated.find((a) => a.name === name);
      if (created && !alarmCleared.includes(name)) {
        return created;
      }
      return null;
    },
    clear: async (name: string) => {
      alarmCleared.push(name);
      return true;
    },
    onAlarm: {
      addListener: () => {},
    },
  },
  windows: {
    remove: async (windowId: number) => {
      windowsRemoved.push(windowId);
    },
    onRemoved: {
      addListener: () => {},
    },
  },
  storage: {
    local: createStorageArea(),
    session: createStorageArea(),
    sync: createStorageArea(),
  },
};

(globalThis as any).browser = mockBrowser;
(globalThis as any).chrome = mockBrowser;
