export type CentralConfig = {
  databasePath: string;
  host: string;
  port: number;
  /**
   * Break-glass credential (a long random value), optional: it works as an admin and is audited as `token`. HQ staff sign in with their own name
   * and password (`npm run create-admin` makes the first one); leave this unset once they have accounts.
   */
  adminToken?: string;
  production: boolean;
  /** Where product pictures are kept (default: `uploads` next to the database). */
  uploadsDir?: string;
  /**
   * Extra host names HQ answers to (its public name). localhost, 127.0.0.1 and [::1] are always allowed. Any other name is refused,
   * which blocks "DNS rebinding" (a web page pointing its own name at this server).
   */
  allowedHosts: string[];
  /** The built HQ screen (cloud-hq/web/dist). Without it HQ answers the API only. */
  webDist?: string;
  /** Backups (docs/07 §3): without a folder there are none. The same settings as a branch's. */
  backupDir?: string;
  backupCopyDir?: string;
  backupPassphrase?: string;
  backupAt: string;
  backupKeep: number;
};

/** Read HQ's configuration from the environment. A break-glass token, if set, must be a real one. */
export function loadCentralConfig(env: NodeJS.ProcessEnv = process.env): CentralConfig {
  const adminToken = env.HQ_ADMIN_TOKEN || undefined;
  if (adminToken !== undefined && adminToken.length < 24)
    throw new Error('HQ_ADMIN_TOKEN, if set, must be a random value of at least 24 characters');
  const backupAt = env.BACKUP_AT ?? '02:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupAt)) throw new Error('BACKUP_AT must be a time such as 02:00');
  const backupKeep = Number(env.BACKUP_KEEP ?? 30);
  if (!Number.isInteger(backupKeep) || backupKeep < 1) throw new Error('BACKUP_KEEP must be a whole number of at least 1');
  if (env.BACKUP_PASSPHRASE && env.BACKUP_PASSPHRASE.length < 12) throw new Error('BACKUP_PASSPHRASE must be at least 12 characters');
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a port number');
  return {
    databasePath: env.DATABASE_PATH ?? './data/hq/hq.db',
    host: env.HOST ?? '127.0.0.1', // localhost only unless told otherwise
    port,
    adminToken,
    production: env.NODE_ENV === 'production',
    uploadsDir: env.UPLOADS_DIR || undefined,
    webDist: env.WEB_DIST || undefined,
    backupDir: env.BACKUP_DIR || undefined,
    backupCopyDir: env.BACKUP_COPY_DIR || undefined,
    backupPassphrase: env.BACKUP_PASSPHRASE || undefined,
    backupAt,
    backupKeep,
    allowedHosts: (env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
