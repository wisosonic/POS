import type { Db } from '../db/open';
import { localDay, localMinutes } from '../util/time';
import { BackupError, createBackup, listBackups, type BackupFile, type BackupResult } from './backup';

export type BackupSettings = {
  dir?: string;
  copyDir?: string;
  passphrase?: string;
  /** The product pictures folder, saved alongside the database. */
  uploadsDir?: string;
  /** Shop-local HH:MM. */
  at: string;
  keep: number;
};

export type LastRun = { at: string; ok: boolean; trigger: 'schedule' | 'manual'; file?: string; error?: string; copyError?: string };

/** A backup older than this is reported as overdue (a day plus slack for a PC that was off overnight). */
export const STALE_AFTER_MS = 36 * 3_600_000;
/** After a failed scheduled backup, wait this long before trying again. */
export const RETRY_AFTER_MS = 30 * 60_000;

type Log = { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/** Runs, schedules and reports on backups. One at a time: a second request while one is running waits for the same result. */
export class BackupService {
  private running: Promise<BackupResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastAttemptMs = 0;
  last: LastRun | null = null;

  constructor(
    private readonly db: Db,
    readonly settings: BackupSettings,
    private readonly log: Log = { info: () => undefined, error: () => undefined },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get configured() {
    return !!this.settings.dir;
  }

  async files(): Promise<BackupFile[]> {
    return this.settings.dir ? listBackups(this.settings.dir) : [];
  }

  /** The newest backup on disk, so the answer survives a restart of the service. */
  async lastBackupAt(): Promise<string | null> {
    return (await this.files())[0]?.modifiedAt ?? null;
  }

  async status() {
    const lastBackupAt = await this.lastBackupAt();
    const stale = this.configured && (!lastBackupAt || this.clock().getTime() - Date.parse(lastBackupAt) > STALE_AFTER_MS);
    return {
      configured: this.configured,
      encrypted: !!this.settings.passphrase,
      hasSecondCopy: !!this.settings.copyDir,
      at: this.settings.at,
      keep: this.settings.keep,
      lastBackupAt,
      stale,
      lastRun: this.last,
    };
  }

  run(trigger: 'schedule' | 'manual'): Promise<BackupResult> {
    if (!this.settings.dir) return Promise.reject(new BackupError('NOT_CONFIGURED', 'Backups are not set up: set BACKUP_DIR'));
    if (this.running) return this.running;
    this.lastAttemptMs = this.clock().getTime();
    const started = createBackup(this.db, {
      dir: this.settings.dir,
      copyDir: this.settings.copyDir,
      passphrase: this.settings.passphrase,
      uploadsDir: this.settings.uploadsDir,
      keep: this.settings.keep,
      now: this.clock(),
    })
      .then((result) => {
        this.last = {
          at: new Date().toISOString(),
          ok: true,
          trigger,
          file: result.file,
          copyError: result.copyError ?? result.pictures?.error,
        };
        this.log.info({ file: result.file, bytes: result.bytes, copyError: result.copyError, pictures: result.pictures }, 'backup done');
        return result;
      })
      .catch((err: Error) => {
        this.last = { at: new Date().toISOString(), ok: false, trigger, error: err.message };
        this.log.error({ err }, 'backup failed');
        throw err;
      })
      .finally(() => {
        this.running = null;
      });
    this.running = started;
    return started;
  }

  /** Is a scheduled backup due? Once a day, from the chosen time on, and only if none was taken today. */
  async due(): Promise<boolean> {
    if (!this.configured || this.running) return false;
    const now = this.clock();
    if (now.getTime() - this.lastAttemptMs < RETRY_AFTER_MS) return false;
    const [h, m] = this.settings.at.split(':').map(Number) as [number, number];
    if (localMinutes(now) < h * 60 + m) return false;
    const latest = await this.lastBackupAt();
    return !latest || localDay(latest) !== localDay(now);
  }

  /** Check once a minute. Checking, instead of sleeping until 02:00, also catches up after the PC was off at that hour. */
  start(everyMs = 60_000) {
    if (!this.configured || this.timer) return;
    const tick = () => {
      void this.due()
        .then((due) => (due ? this.run('schedule').catch(() => undefined) : undefined))
        .catch(() => undefined);
    };
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
    tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
