import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// US-29 (cut-over): the rehearsal command, run for real on the real dump, as a person would run it. It must pass every check.
// Skipped when the dump is not there (157 MB, not in CI).
const DUMP = resolve(process.env.POSDB_DUMP ?? 'POSDB.sql');
const maybe = existsSync(DUMP) ? describe : describe.skip;

maybe('the cut-over rehearsal (US-29)', () => {
  it('imports the dump, checks the shop adds up, sells on it, and restores a backup of it: every check passes', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', resolve('apps/api/src/cli/rehearse.ts'), '--dump', DUMP], {
      encoding: 'utf8',
      timeout: 540_000,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toMatch(/\bFAIL\b/);
    expect(out).toMatch(/(\d+) of \1 checks passed/);
    expect(r.status).toBe(0);
    // the things a person is told to look at are listed
    expect(out).toContain('For a person to look at before the real cut-over');
    expect(out).toContain('the old app’s open register can be counted and closed');
    expect(out).toContain('the restored copy is the same shop');
  }, 560_000);

  it('refuses a missing file, and a missing --dump, with exit code 2', () => {
    const missing = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('apps/api/src/cli/rehearse.ts'), '--dump', resolve('no-such-dump.sql')],
      {
        encoding: 'utf8',
      },
    );
    expect(missing.status).toBe(2);
    const none = spawnSync(process.execPath, ['--import', 'tsx', resolve('apps/api/src/cli/rehearse.ts')], { encoding: 'utf8' });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('Usage: rehearse --dump');
  });
});
