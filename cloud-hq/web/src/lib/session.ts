// The signed-in person. The token lives in sessionStorage (gone when the tab closes, never written to disk by the page), and in memory if the browser blocks
// storage. It is only ever sent to HQ, in a header.

export type Role = 'viewer' | 'catalog' | 'hr' | 'payroll' | 'admin' | 'employee';
export type Me = { id: number | null; username: string; name: string; role: Role; mustResetPassword: boolean };

const KEY = 'hq-session';
let memory: { token: string; me: Me } | null = null;

function read(): { token: string; me: Me } | null {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) memory = JSON.parse(raw) as { token: string; me: Me };
  } catch {
    /* storage blocked: the memory copy is all there is */
  }
  return memory;
}

export const getToken = (): string | null => read()?.token ?? null;
export const getMe = (): Me | null => read()?.me ?? null;

export function setSession(token: string, me: Me): void {
  memory = { token, me };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* blocked */
  }
}

export function clearSession(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* blocked */
  }
}

/** Only an admin changes people, branches and backups; everyone on staff reads the chain's figures (the server enforces both, this only hides buttons). */
export const isAdmin = (me: Me | null): boolean => me?.role === 'admin';

/** What the menu shows: HR changes people, payroll reads pay, an admin does both (the server enforces each; this only hides buttons and pages). */
export const canHr = (me: Me | null): boolean => me?.role === 'admin' || me?.role === 'hr';
export const canPayroll = (me: Me | null): boolean => me?.role === 'admin' || me?.role === 'payroll';
