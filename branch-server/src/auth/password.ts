import { hash, verify } from '@node-rs/argon2';

// Argon2id (CLAUDE.md rule 11). Tests use cheap parameters so suites stay fast: NODE_ENV=test or VITEST.
const cheap = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;
const OPTIONS = cheap ? { memoryCost: 1024, timeCost: 1, parallelism: 1 } : { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // malformed hash, never throw to the caller
  }
}
