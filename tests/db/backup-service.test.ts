import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupService, RETRY_AFTER_MS, STALE_AFTER_MS } from '../../apps/api/src/backup/service';
import { migrate } from '../../apps/api/src/db/migrate';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { shopDayStart } from '../../apps/api/src/util/time';

// US-30: the daily backup runs once a day from the chosen time, catches up when the PC was off, and says when it is overdue.
let root: string;
let db: Db;
let n = 0;
const HOUR = 3_600_000;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pos-backup-svc-'));
  const path = join(root, 'live.db');
  migrate(path);
  db = openDatabase(path);
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A service whose clock we move by hand. `at(h)` is h hours after the shop's midnight today (shop-local time). */
function setup(settings: { at?: string; withDir?: boolean } = {}) {
  const midnight = shopDayStart().getTime();
  let now = new Date(midnight);
  const service = new BackupService(
    db,
    { dir: settings.withDir === false ? undefined : join(root, `svc-${++n}`), at: settings.at ?? '02:00', keep: 30 },
    undefined,
    () => now,
  );
  return {
    service,
    at: (hours: number) => (now = new Date(midnight + hours * HOUR)),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe('when a backup is due', () => {
  it('not before the chosen time, then yes, and then not again that day', async () => {
    const t = setup();
    t.at(1.9);
    expect(await t.service.due()).toBe(false);
    t.at(2);
    expect(await t.service.due()).toBe(true);
    await t.service.run('schedule');
    t.at(20);
    expect(await t.service.due()).toBe(false);
  });

  it('catches up: the PC was off at 02:00 and is switched on at 09:30', async () => {
    const t = setup();
    t.at(9.5);
    expect(await t.service.due()).toBe(true);
  });

  it('is due again the next day, from the chosen time', async () => {
    const t = setup();
    t.at(3);
    await t.service.run('schedule');
    t.at(24 + 1);
    expect(await t.service.due()).toBe(false);
    t.at(24 + 2);
    expect(await t.service.due()).toBe(true);
  });

  it('honours a different time', async () => {
    const t = setup({ at: '23:30' });
    t.at(23.4);
    expect(await t.service.due()).toBe(false);
    t.at(23.5);
    expect(await t.service.due()).toBe(true);
  });

  it('is never due without a backup folder', async () => {
    const t = setup({ withDir: false });
    t.at(12);
    expect(t.service.configured).toBe(false);
    expect(await t.service.due()).toBe(false);
    await expect(t.service.run('manual')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('after a failure', () => {
  it('waits half an hour before trying again, then tries again', async () => {
    // A folder that cannot be made (it would have to sit inside a file), so every attempt fails.
    let now = new Date(shopDayStart().getTime() + 3 * HOUR);
    const broken = new BackupService(db, { dir: join(root, 'live.db', 'nope'), at: '02:00', keep: 30 }, undefined, () => now);
    expect(await broken.due()).toBe(true);

    await expect(broken.run('schedule')).rejects.toThrow();
    expect(broken.last).toMatchObject({ ok: false, trigger: 'schedule' });
    expect(broken.last!.error).toBeTruthy();

    expect(await broken.due()).toBe(false); // straight after the failure
    now = new Date(now.getTime() + RETRY_AFTER_MS - 1000);
    expect(await broken.due()).toBe(false); // 29 minutes 59 seconds
    now = new Date(now.getTime() + 1000);
    expect(await broken.due()).toBe(true); // half an hour: try again
  });

  it('a second request while one is running shares its result instead of starting another', async () => {
    const t = setup();
    t.at(3);
    const [a, b] = await Promise.all([t.service.run('manual'), t.service.run('manual')]);
    expect(a.file).toBe(b.file);
    expect((await t.service.files()).length).toBe(1);
  });
});

describe('status', () => {
  it('has never been backed up: overdue when configured, quiet when not', async () => {
    const t = setup();
    expect(await t.service.status()).toMatchObject({
      configured: true,
      lastBackupAt: null,
      stale: true,
      encrypted: false,
      hasSecondCopy: false,
    });
    const off = setup({ withDir: false });
    expect(await off.service.status()).toMatchObject({ configured: false, stale: false });
  });

  it('is fine right after a backup, overdue once the newest one is more than 36 hours old', async () => {
    const t = setup();
    t.at(3);
    const r = await t.service.run('manual');
    // pretend the file was written just now (its real modification time) and look at it from the future
    t.at(3);
    expect((await t.service.status()).stale).toBe(false);
    const future = new Date(Date.now() + STALE_AFTER_MS + HOUR);
    utimesSync(r.path, new Date(), new Date()); // keep it at "now"
    const later = new BackupService(db, t.service.settings, undefined, () => future);
    expect((await later.status()).stale).toBe(true);
  });

  it('never reveals the passphrase', async () => {
    const service = new BackupService(db, { dir: join(root, 'p'), passphrase: 'a very secret passphrase', at: '02:00', keep: 5 });
    expect(JSON.stringify(await service.status())).not.toContain('secret');
  });
});
