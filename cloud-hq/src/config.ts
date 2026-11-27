export type CentralConfig = {
  databasePath: string;
  host: string;
  port: number;
  /** Interim HQ staff credential (a long random value). HQ users with their own passwords arrive with P3; until then this guards `/branches`. */
  adminToken: string;
  production: boolean;
  /** Where product pictures are kept (default: `uploads` next to the database). */
  uploadsDir?: string;
  /**
   * Extra host names HQ answers to (its public name). localhost, 127.0.0.1 and [::1] are always allowed. Any other name is refused,
   * which blocks "DNS rebinding" (a web page pointing its own name at this server).
   */
  allowedHosts: string[];
};

/** Read HQ's configuration from the environment. It refuses to start without a real admin token. */
export function loadCentralConfig(env: NodeJS.ProcessEnv = process.env): CentralConfig {
  const adminToken = env.HQ_ADMIN_TOKEN ?? '';
  if (adminToken.length < 24) throw new Error('HQ_ADMIN_TOKEN must be set to a random value of at least 24 characters');
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a port number');
  return {
    databasePath: env.DATABASE_PATH ?? './data/hq/hq.db',
    host: env.HOST ?? '127.0.0.1', // localhost only unless told otherwise
    port,
    adminToken,
    production: env.NODE_ENV === 'production',
    uploadsDir: env.UPLOADS_DIR || undefined,
    allowedHosts: (env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
