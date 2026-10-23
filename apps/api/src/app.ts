import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import authPlugin from './auth/plugin';
import { BackupService, type BackupSettings } from './backup/service';
import backupRoutes from './modules/backup/routes';
import authRoutes, { meRoute } from './auth/routes';
import { loadConfig } from './config';
import { openDatabase } from './db/open';
import { errorHandler, notFoundHandler, problem } from './errors';
import { windowsSpoolerPrinter, type ReceiptPrinter } from './modules/printing/driver';
import auditRoutes from './modules/audit/routes';
import { STORED_NAME, mimeOfStored } from './modules/catalog/images';
import lookupRoutes from './modules/catalog/lookups';
import barcodeRoutes from './modules/catalog/barcodes';
import productRoutes from './modules/catalog/products';
import expenseRoutes from './modules/expenses/routes';
import serviceRoutes from './modules/services/routes';
import inventoryRoutes from './modules/inventory/routes';
import customerRoutes from './modules/customers/routes';
import holdRoutes from './modules/holds/routes';
import purchaseRoutes from './modules/purchases/routes';
import returnRoutes from './modules/returns/routes';
import registerRoutes from './modules/registers/routes';
import reportRoutes from './modules/reports/routes';
import saleRoutes from './modules/sales/routes';
import rateRoutes from './modules/settings/rates';
import settingsRoutes from './modules/settings/routes';
import userRoutes from './modules/users/routes';

export type BuildOptions = {
  databasePath: string;
  logger?: boolean;
  /** Where log lines go instead of the console. Used by the test that proves no secret reaches the log. */
  logStream?: { write(line: string): void };
  jwtSecret?: string;
  /** Per-IP rate limits on /auth/*. On in production, off by default elsewhere (account lockout still applies). */
  rateLimit?: boolean;
  /** The receipt printer. Defaults to the Windows print spooler. */
  printer?: ReceiptPrinter;
  /** Backup settings. Anything left out comes from the environment (BACKUP_DIR and friends). */
  backup?: Partial<BackupSettings>;
  /** Called when a restore needs the server to stop and start again. The entry point exits; tests leave it out. */
  restart?: () => void;
  /** Where product pictures are kept. Defaults to UPLOADS_DIR, then an `uploads` folder beside the database. */
  uploadsDir?: string;
  /** The built web app to serve (apps/web/dist). Defaults to the WEB_DIST environment variable. Nothing is served without it. */
  webDist?: string;
  /** Serve over HTTPS with this certificate and key (PEM text). Defaults to the files named by TLS_CERT and TLS_KEY. */
  tls?: { cert: string | Buffer; key: string | Buffer };
};

/**
 * The API. The database must already be migrated (see db/migrate.ts). The app owns its connection and closes it on `close()`.
 * Only this process may write to the SQLite file.
 */
export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const config = loadConfig({ ...process.env, ...(options.jwtSecret ? { JWT_SECRET: options.jwtSecret } : {}) });
  const db = openDatabase(options.databasePath);

  const tls =
    options.tls ?? (config.tlsCert && config.tlsKey ? { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) } : undefined);
  const app = Fastify({
    logger: options.logger ? (options.logStream ? { stream: options.logStream } : true) : false,
    trustProxy: false,
    ...(tls ? { https: tls } : {}),
  }) as unknown as FastifyInstance; // the https server type differs only in the server it holds
  app.decorate('tls', !!tls);
  const registeredRoutes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
  });
  app.decorate('registeredRoutes', registeredRoutes);
  app.decorate('uploadsDir', resolve(options.uploadsDir ?? config.uploadsDir ?? join(dirname(options.databasePath), 'uploads')));
  app.addHook('onClose', async () => {
    db.close();
  });

  // The built web app is served by this same server when it exists (see the end of this function).
  const webRoot = options.webDist ?? config.webDist;
  const serveWeb = !!webRoot && existsSync(resolve(webRoot, 'index.html'));

  app.setErrorHandler(errorHandler);
  // A page address such as /products belongs to the web app's router: answer with the app, not a 404. The API keeps its JSON 404s.
  app.setNotFoundHandler((req, reply) => {
    if (serveWeb && req.method === 'GET' && !req.url.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html'))
      return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
    return notFoundHandler(req, reply);
  });

  // Only answer to this PC's own names. A web page on the internet can point its own name at 127.0.0.1 ("DNS rebinding") and
  // then talk to this server from the shop's browser; its requests carry that foreign name in Host and Origin.
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...config.allowedHosts]);
  const hostOf = (value: string) => {
    try {
      return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  app.addHook('onRequest', async (req, reply) => {
    const host = hostOf(req.headers.host ?? '');
    if (!host || !allowedHosts.has(host))
      return reply
        .status(403)
        .type('application/problem+json')
        .send(problem(403, 'HOST_NOT_ALLOWED', 'This server does not answer to that address'));
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const from = hostOf(origin);
      if (!from || !allowedHosts.has(from))
        return reply
          .status(403)
          .type('application/problem+json')
          .send(problem(403, 'ORIGIN_NOT_ALLOWED', 'Requests from other websites are not accepted'));
    }
  });

  // The API serves private data: never cache it. Nothing may be sniffed into another content type, framed by another
  // page, or loaded from anywhere but this server. (The web app's own files set their own caching below.)
  app.addHook('onSend', async (req, reply) => {
    void reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cross-Origin-Opener-Policy', 'same-origin')
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()')
      .header(
        'Content-Security-Policy',
        // Styles allow inline because React writes style="" attributes; scripts allow only this server's own files.
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; " +
          "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    if (req.url.startsWith('/api/')) void reply.header('Cache-Control', 'no-store');
    // Over HTTPS the browser is told to keep using it.
    if (tls) void reply.header('Strict-Transport-Security', 'max-age=31536000');
  });

  if (options.rateLimit ?? config.production) await app.register(rateLimit, { global: false });
  await app.register(authPlugin, { db, jwtSecret: config.jwtSecret });
  app.decorate('dbPath', resolve(options.databasePath));
  app.decorate('requestRestart', options.restart ?? (() => undefined));
  app.decorate('printer', options.printer ?? windowsSpoolerPrinter);
  app.decorate(
    'backups',
    new BackupService(
      db,
      {
        dir: config.backupDir,
        copyDir: config.backupCopyDir,
        passphrase: config.backupPassphrase,
        uploadsDir: app.uploadsDir,
        at: config.backupAt,
        keep: config.backupKeep,
        ...options.backup,
      },
      app.log,
    ),
  );
  app.addHook('onClose', async () => {
    app.backups.stop();
  });

  await app.register(
    async (api) => {
      api.get('/healthz', async () => ({ status: 'ok' }));
      api.get('/readyz', async () => {
        const row = db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get() as { name: string } | undefined;
        return { status: 'ready', schema: row?.name ?? null };
      });

      await api.register(authRoutes, { prefix: '/auth' });
      meRoute(api);
      await api.register(userRoutes);
      await api.register(settingsRoutes);
      await api.register(auditRoutes);
      await api.register(productRoutes);
      await api.register(barcodeRoutes);
      await api.register(lookupRoutes);
      await api.register(expenseRoutes);
      await api.register(inventoryRoutes);
      await api.register(serviceRoutes);
      await api.register(rateRoutes);
      await api.register(customerRoutes);
      await api.register(registerRoutes);
      await api.register(saleRoutes);
      await api.register(returnRoutes);
      await api.register(holdRoutes);
      await api.register(purchaseRoutes);
      await api.register(reportRoutes);
      await api.register(backupRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Product pictures. Public on purpose: an <img> cannot send a sign-in, and a picture of a packet of biscuits is not a secret.
  // Only names of the one shape the server itself makes (24 hex digits and a picture extension) are served, so nothing else
  // in or near this folder (a saved web page, a stray file, a path with ".." in it) can ever be reached. The name is made
  // from the picture's content, so a given name never changes: it can be cached for good.
  app.get('/uploads/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const mime = STORED_NAME.test(file) ? mimeOfStored(file) : null;
    if (!mime) return notFoundHandler(req, reply);
    try {
      const bytes = await readFile(join(app.uploadsDir, file));
      return reply
        .type(mime)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('Content-Disposition', 'inline')
        .send(bytes);
    } catch {
      return notFoundHandler(req, reply);
    }
  });

  // The till's browser loads the web app from this same server (one process, one address). Hashed asset files never change,
  // so they are cached for good; the page itself is always re-checked so an update shows up at once.
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: resolve(webRoot!),
      wildcard: false,
      setHeaders(res, path) {
        const immutable = /[\\/]assets[\\/]/.test(path);
        void res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  return app;
}
