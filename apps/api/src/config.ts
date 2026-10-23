import { randomBytes } from 'node:crypto';

export type Config = {
  databasePath: string;
  host: string;
  port: number;
  jwtSecret: string;
  production: boolean;
  /** Where nightly backups go. Unset means no automatic backups. */
  backupDir?: string;
  /** A second place for each backup: an external drive, or a folder that syncs offsite. */
  backupCopyDir?: string;
  /** Encrypts backups. Without it they are plain database files. */
  backupPassphrase?: string;
  /** Shop-local time of the daily backup, HH:MM. A backup missed because the PC was off runs as soon as it is back on. */
  backupAt: string;
  backupKeep: number;
  /** The built web app, served by the API in production. */
  webDist?: string;
  /** Where product pictures are kept. Defaults to an `uploads` folder beside the database. */
  uploadsDir?: string;
  /**
   * Extra host names the server answers to (a tablet reaching the shop PC by its name or address). localhost, 127.0.0.1 and
   * [::1] are always allowed. A request for any other name is refused: that blocks "DNS rebinding", where a web page on the
   * internet points its own name at this PC to reach the server from the shop's browser.
   */
  allowedHosts: string[];
  /** Serve over HTTPS (a tablet or second PC reaching the shop PC across the network). Both files, or neither. */
  tlsCert?: string;
  tlsKey?: string;
};

/** Read configuration from the environment. Production refuses to start without a real JWT secret. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  let jwtSecret = env.JWT_SECRET ?? '';
  if (production && (jwtSecret.length < 32 || jwtSecret === 'change-me')) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production');
  }
  // Development: a random secret per start. Tokens simply stop working after a restart.
  if (!jwtSecret || jwtSecret === 'change-me') jwtSecret = randomBytes(32).toString('hex');

  if (!!env.TLS_CERT !== !!env.TLS_KEY) throw new Error('Set both TLS_CERT and TLS_KEY (paths to the certificate and its key), or neither');

  const backupAt = env.BACKUP_AT ?? '02:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupAt)) throw new Error('BACKUP_AT must be a time such as 02:00');
  const backupKeep = Number(env.BACKUP_KEEP ?? 30);
  if (!Number.isInteger(backupKeep) || backupKeep < 1) throw new Error('BACKUP_KEEP must be a whole number of at least 1');
  if (env.BACKUP_PASSPHRASE && env.BACKUP_PASSPHRASE.length < 12) throw new Error('BACKUP_PASSPHRASE must be at least 12 characters');

  return {
    databasePath: env.DATABASE_PATH ?? './data/pos.db',
    host: env.HOST ?? '127.0.0.1', // localhost only by default (docs/04-architecture.md §6)
    port: Number(env.PORT ?? 3000),
    jwtSecret,
    production,
    backupDir: env.BACKUP_DIR || undefined,
    backupCopyDir: env.BACKUP_COPY_DIR || undefined,
    backupPassphrase: env.BACKUP_PASSPHRASE || undefined,
    backupAt,
    backupKeep,
    webDist: env.WEB_DIST || undefined,
    tlsCert: env.TLS_CERT || undefined,
    tlsKey: env.TLS_KEY || undefined,
    uploadsDir: env.UPLOADS_DIR || undefined,
    allowedHosts: (env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
