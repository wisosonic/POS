import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// The small pieces every enrolment shares: a till, a print agent and a branch each trade a one-time code for a long-lived token, and
// only hashes are ever stored. (The till and the agent in apps/api keep their own copy of this for now; new code uses this one.)

// No 0/O/1/I/L: the code is read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Case, spaces and the dash do not matter when a code is typed. */
export const normaliseCode = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();

/** A one-time code like `XK3P9-M2WQT`: 10 characters, about 49 bits, to be used once within a short time. */
export function newOneTimeCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** A long-lived secret (256 bits). Shown once, stored only as a hash. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Compare two secrets without leaking, through timing, how much of them matched. */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
