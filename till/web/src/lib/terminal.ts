// Which till is this browser? An admin enrols the device once with a one-time code (Settings → Tills), the server answers with a
// device token, and this file keeps it. Every request then carries it (lib/api.ts) so the server knows which register and
// warehouse are meant (docs/11-multi-branch.md §3.4). The token is NOT a password: it only says "this is Till 2"; signing in is
// still needed to do anything. It is kept in this browser only. If storage is blocked it lives in memory until the page is closed.

const KEY = 'pos.terminalToken';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

const storage = (): Store => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked: the token is kept in memory
  }
};

let memory: string | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

/** Be told when the token is set or cleared (the screens ask the server who this till is again). */
export function subscribeTerminal(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function getTerminalToken(store: Store = storage()): string | null {
  try {
    return store?.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setTerminalToken(token: string, store: Store = storage()): void {
  memory = token;
  try {
    store?.setItem(KEY, token);
  } catch {
    /* storage full or blocked: the token stays in memory */
  }
  changed();
}

export function clearTerminalToken(store: Store = storage()): void {
  memory = null;
  try {
    store?.removeItem(KEY);
  } catch {
    /* nothing to remove from */
  }
  changed();
}
