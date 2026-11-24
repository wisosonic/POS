// A tiny key-value store for what the till keeps on its own computer (the catalog copy, sales waiting to sync).
// IndexedDB in the browser; a plain Map in tests, or if the browser refuses storage (private windows, blocked site data).

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (m.has(key) ? (structuredClone(m.get(key)) as T) : undefined),
    set: async (key, value) => void m.set(key, structuredClone(value)),
    delete: async (key) => void m.delete(key),
  };
}

export function indexedDbKV(dbName: string, store = 'kv'): KV {
  const fallback = memoryKV();
  let opened: Promise<IDBDatabase | null> | undefined;

  const open = () =>
    (opened ??= new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      try {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }));

  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
    const db = await open();
    if (!db) return undefined;
    return new Promise<T | undefined>((resolve) => {
      try {
        const req = fn(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  };

  return {
    async get<T>(key: string) {
      if (!(await open())) return fallback.get<T>(key);
      return run('readonly', (s) => s.get(key) as IDBRequest<T>);
    },
    async set(key, value) {
      if (!(await open())) return fallback.set(key, value);
      await run('readwrite', (s) => s.put(value, key));
    },
    async delete(key) {
      if (!(await open())) return fallback.delete(key);
      await run('readwrite', (s) => s.delete(key));
    },
  };
}
