import { createReadStream, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createCatalogCopy, type CatalogCopy } from './catalogCopy';
import { createLinkMonitor, type LinkMonitor, type LinkSnapshot } from './link';

// The till's own small server (docs/11-multi-branch.md §8.4). It runs on the till PC and does three things:
//   1. serves the till screens (the built web app, `web/dist`) from this PC;
//   2. passes the screens' calls (`/api/...`, `/uploads/...`, the live-update stream) on to the BRANCH SERVER at the address saved in
//      this till's settings, and gives the answer back unchanged. It decides nothing: totals, prices, stock and sign-in stay the
//      branch server's job;
//   3. keeps the one setting a till needs, the branch server's address, and can test it (`/till/...`, this PC only).
// It imports nothing from the other projects and holds no business data except a read-only copy of the products and their prices
// on disk (catalogCopy.ts, docs/14 §4). Rule 19 (every route needs a sign-in) is about the branch
// server; this server holds no data and has no sign-in of its own, so its protection is: it listens on this PC only by default, it
// answers only to this PC's own names (so a web page on the internet cannot reach it through DNS rebinding), and the settings
// routes refuse anyone who is not on this PC.

export type TillServerOptions = {
  /** Folder holding `till.json` (the saved settings). Created if missing. */
  dataDir: string;
  /** The built web app. Without it the till answers its own routes and the proxy, but serves no screens. */
  webDist?: string;
  /** Used when nothing is saved yet (the BRANCH_SERVER_URL environment variable). */
  defaultBranchServer?: string;
  /** Extra names this till server answers to besides this PC's own (ALLOWED_HOSTS). */
  allowedHosts?: string[];
  /** The port this server listens on: needed to refuse an address that points back at this very till. */
  port: number;
  /** Seconds to wait for the branch server to accept a connection before giving up (default 5). */
  connectTimeoutMs?: number;
  /** How the heartbeat to the branch server runs (docs/14). The defaults are right for a shop; tests use short times. */
  link?: { intervalMs?: number; timeoutMs?: number; missesToFail?: number; enabled?: boolean };
  /** The catalog copy kept on disk (docs/14 §4). `enabled: false` turns it off (everything is then passed to the branch server). */
  catalog?: { enabled?: boolean; pageSize?: number; safetyMs?: number; pageTimeoutMs?: number };
  log?: (message: string) => void;
};

type Saved = { branchServer?: string };

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  // Same policy as the branch server's: scripts only from this server's own files (styles may be inline, React writes style="").
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Turn what a person typed into the branch server's address (`http://host:port`), or say what is wrong with it. */
export function normalizeBranchUrl(input: string, selfPort?: number): string {
  let text = input.trim();
  if (!text) throw new Error('Type the branch server address, for example 192.168.1.10:3000');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That is not an address. Use the form 192.168.1.10:3000 or http://branch-server:3000');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The address must start with http:// or https://');
  if (url.username || url.password) throw new Error('Do not put a user name or password in the address');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new Error('Give only the server and port, with nothing after it');
  if (!url.hostname) throw new Error('The address has no server name');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (selfPort !== undefined && loopback && Number(port) === selfPort)
    throw new Error('That is this till itself: give the address of the branch server');
  return url.origin;
}

export const isLoopbackAddress = (address: string | undefined): boolean =>
  !!address && (address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1');

const hostOf = (value: string): string | null => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
};

function problem(res: ServerResponse, status: number, code: string, detail: string, proxyError = false): void {
  if (res.headersSent) return void res.destroy();
  const body = JSON.stringify({ type: 'about:blank', title: http.STATUS_CODES[status] ?? 'Error', status, code, detail });
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/problem+json',
    'Cache-Control': 'no-store',
    ...(proxyError ? { 'X-Till-Proxy-Error': code } : {}),
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export type TillServer = {
  server: Server;
  /** The branch server's address now in use, or null. */
  branchServer(): string | null;
  /** The heartbeat to the branch server: what `GET /till/link` reports. */
  link: LinkMonitor;
  listen(host: string): Promise<number>;
  close(): Promise<void>;
};

export function createTillServer(opts: TillServerOptions): TillServer {
  const log = opts.log ?? (() => undefined);
  const settingsFile = join(opts.dataDir, 'till.json');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase())]);
  const webRoot = opts.webDist ? resolve(opts.webDist) : null;
  const connectTimeout = opts.connectTimeoutMs ?? 5_000;
  let selfPort = opts.port;
  const linkOpts = opts.link ?? {};
  // The catalog copy on this PC's disk (docs/14 §4), kept current by the heartbeat.
  const catalogOpts = opts.catalog ?? {};
  const catalogCopy: CatalogCopy | null =
    catalogOpts.enabled === false
      ? null
      : createCatalogCopy({ dataDir: opts.dataDir, branchServer: () => currentBranchServer().url, ...catalogOpts, log });
  const link = createLinkMonitor({
    branchServer: () => currentBranchServer().url,
    ...linkOpts,
    onPing: (info) => catalogCopy?.onPing(info),
    log,
  });

  function loadSaved(): Saved {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8')) as Saved;
    } catch {
      return {};
    }
  }
  function saveBranchServer(url: string): void {
    mkdirSync(opts.dataDir, { recursive: true });
    const tmp = `${settingsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ branchServer: url } satisfies Saved, null, 2));
    renameSync(tmp, settingsFile); // never leave a half-written file
  }
  function currentBranchServer(): { url: string | null; source: 'saved' | 'environment' | null } {
    const saved = loadSaved().branchServer;
    if (saved) {
      try {
        return { url: normalizeBranchUrl(saved), source: 'saved' };
      } catch {
        /* a damaged file: fall through to the default */
      }
    }
    if (opts.defaultBranchServer) {
      try {
        return { url: normalizeBranchUrl(opts.defaultBranchServer), source: 'environment' };
      } catch {
        /* a wrong environment value is the same as none */
      }
    }
    return { url: null, source: null };
  }

  // ---- /till/*: this till's own settings (this PC only)
  async function tillRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/till/health' && req.method === 'GET')
      return json(res, 200, { status: 'ok', configured: currentBranchServer().url !== null });
    if (!isLoopbackAddress(req.socket.remoteAddress))
      return problem(res, 403, 'LOCAL_ONLY', 'The till settings can only be changed on the till PC itself');

    // What the screens poll: is the branch server answering? The screen sends its device token so the heartbeat can use the guarded ping
    // (no token: the open health check). The token is kept in memory only, never written to disk or to a log.
    if (path === '/till/link' && req.method === 'GET') {
      const sent = req.headers['x-terminal-token'];
      link.setToken(typeof sent === 'string' && sent ? sent : null);
      const snap: LinkSnapshot = link.snapshot();
      return json(res, 200, snap);
    }
    // How the copy of the catalog on this PC is doing (this PC only; no product data, no token).
    if (path === '/till/catalog' && req.method === 'GET')
      return json(
        res,
        200,
        catalogCopy?.status() ?? { ready: false, products: 0, watermark: null, pulling: false, lastPullAt: null, lastError: null },
      );
    if (path === '/till/config' && req.method === 'GET') {
      const { url, source } = currentBranchServer();
      return json(res, 200, { branchServer: url, source });
    }
    if (path === '/till/config' && req.method === 'PUT') {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return problem(res, 400, 'VALIDATION', 'The request was not valid JSON');
      }
      const raw = (body as { branchServer?: unknown }).branchServer;
      if (typeof raw !== 'string') return problem(res, 400, 'VALIDATION', 'branchServer must be text');
      let url: string;
      try {
        url = normalizeBranchUrl(raw, selfPort);
      } catch (e) {
        return problem(res, 400, 'VALIDATION', (e as Error).message);
      }
      saveBranchServer(url);
      log(`Branch server address set to ${url}`);
      return json(res, 200, { branchServer: url, source: 'saved' });
    }
    if (path === '/till/test' && req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return problem(res, 400, 'VALIDATION', 'The request was not valid JSON');
      }
      const raw = (body as { branchServer?: unknown }).branchServer;
      let url: string | null;
      try {
        url = typeof raw === 'string' && raw.trim() ? normalizeBranchUrl(raw, selfPort) : currentBranchServer().url;
      } catch (e) {
        return json(res, 200, { ok: false, reason: 'BAD_ADDRESS', detail: (e as Error).message });
      }
      if (!url) return json(res, 200, { ok: false, reason: 'NOT_CONFIGURED', detail: 'No branch server address is set yet' });
      return json(res, 200, await testBranch(url));
    }
    return problem(res, 404, 'NOT_FOUND', 'Unknown till route');
  }

  async function testBranch(url: string): Promise<Record<string, unknown>> {
    const started = Date.now();
    try {
      const r = await fetch(`${url}/api/v1/healthz`, { signal: AbortSignal.timeout(4_000) });
      const ms = Date.now() - started;
      if (r.ok) return { ok: true, url, ms };
      const p = (await r.json().catch(() => ({}))) as { code?: string };
      if (p.code === 'HOST_NOT_ALLOWED')
        return {
          ok: false,
          url,
          reason: 'HOST_NOT_ALLOWED',
          detail: 'The server is there but does not accept this address: add it to ALLOWED_HOSTS on the branch server',
        };
      return {
        ok: false,
        url,
        reason: 'BAD_ANSWER',
        detail: `Something answered at this address, but not a branch server (status ${r.status})`,
      };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? '';
      const name = (e as Error).name;
      if (name === 'TimeoutError' || cause === 'ETIMEDOUT' || cause === 'UND_ERR_CONNECT_TIMEOUT')
        return {
          ok: false,
          url,
          reason: 'TIMEOUT',
          detail: 'Nothing answered in time: check the address and that the branch server PC is on',
        };
      if (cause === 'ENOTFOUND') return { ok: false, url, reason: 'UNKNOWN_NAME', detail: 'That server name is not known on this network' };
      if (cause === 'ECONNREFUSED')
        return { ok: false, url, reason: 'REFUSED', detail: 'The PC answered but no branch server is running on that port' };
      return { ok: false, url, reason: 'UNREACHABLE', detail: 'Cannot reach that address' };
    }
  }

  // ---- the catalog, answered from this PC's own copy (docs/14 §4)
  // The screens ask `GET /api/v1/products/sync` (paged, `since`/`afterId`/`limit`). When the copy holds a whole catalog, came from THIS
  // branch server and was filled by THIS till's token (the screen must send the same token), it answers from disk, so a scan works at
  // once and a price list is not fetched across the network on every page load. In every other case the call goes to the branch server
  // as before. Returns true when it answered.
  function serveCatalog(req: IncomingMessage, res: ServerResponse): boolean {
    if (!catalogCopy || req.method !== 'GET') return false;
    const token = req.headers['x-terminal-token'];
    if (!catalogCopy.canServe(typeof token === 'string' ? token : undefined)) return false;
    const q = new URL(req.url ?? '/', 'http://till.invalid').searchParams;
    const since = q.get('since') ?? '';
    const afterRaw = q.get('afterId');
    const limitRaw = q.get('limit');
    const afterId = afterRaw === null ? undefined : Number(afterRaw);
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    const bad =
      since.length > 40 ||
      (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) ||
      (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 2000));
    if (bad) return false; // let the branch server say what is wrong, in its own words
    json(res, 200, catalogCopy.store.readFeed(since, afterId, limit));
    return true;
  }

  // ---- the pass-through to the branch server
  function proxy(req: IncomingMessage, res: ServerResponse): void {
    const target = currentBranchServer().url;
    if (!target) return problem(res, 503, 'BRANCH_NOT_CONFIGURED', 'This till does not know its branch server yet', true);
    const base = new URL(target);
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    const device = req.headers['x-terminal-token']; // the heartbeat pings as this till (kept in memory only)
    if (typeof device === 'string' && device) link.setToken(device);
    for (const h of HOP_BY_HOP) delete headers[h];
    // The browser's Origin and Referer name THIS till; the branch server's check is about other websites, and this server already did it.
    delete headers.origin;
    delete headers.referer;
    headers.host = base.host;
    const mod = base.protocol === 'https:' ? https : http;
    const up = mod.request(
      { protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method: req.method, path: req.url, headers },
      (upstream) => {
        const out: http.OutgoingHttpHeaders = { ...upstream.headers };
        for (const h of HOP_BY_HOP) delete out[h];
        res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, out);
        upstream.on('error', () => res.destroy());
        upstream.pipe(res);
      },
    );
    // A branch server that is switched off or unplugged must be noticed in seconds, not after the operating system's long wait.
    up.on('socket', (socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => up.destroy(new Error('connect timeout')), connectTimeout);
      socket.once('connect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
    });
    up.on('error', () => problem(res, 502, 'BRANCH_UNREACHABLE', 'Cannot reach the branch server', true));
    // The screen hung up (a closed page, or the end of the live stream or a long wait): stop asking the branch server.
    res.on('close', () => up.destroy());
    req.on('error', () => up.destroy());
    req.pipe(up);
  }

  // ---- the screens
  function serveFile(res: ServerResponse, file: string, immutable: boolean, head: boolean): void {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (head) return void res.end();
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  function serveWeb(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (!webRoot) return problem(res, 404, 'NO_SCREENS', 'The till screens are not built here: run "npm run build" in the till folder');
    const head = req.method === 'HEAD';
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return problem(res, 400, 'BAD_PATH', 'Bad address');
    }
    const file = normalize(join(webRoot, decoded));
    // Nothing outside the built folder, however the address is written.
    const inside = file === webRoot || file.startsWith(webRoot + sep);
    if (inside) {
      try {
        if (statSync(file).isFile()) return serveFile(res, file, /[\\/]assets[\\/]/.test(file), head);
      } catch {
        /* not a file: fall through */
      }
    }
    // A page address such as /products belongs to the web app's router: answer with the app. A missing file keeps its 404.
    if ((req.headers.accept ?? '').includes('text/html')) {
      try {
        return serveFile(res, join(webRoot, 'index.html'), false, head);
      } catch {
        return problem(res, 404, 'NO_SCREENS', 'The till screens are not built here: run "npm run build" in the till folder');
      }
    }
    return problem(res, 404, 'NOT_FOUND', 'No such file');
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const host = hostOf(req.headers.host ?? '');
      if (!host || !allowedHosts.has(host)) return problem(res, 403, 'HOST_NOT_ALLOWED', 'This till does not answer to that address');
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const from = hostOf(origin);
        if (!from || !allowedHosts.has(from))
          return problem(res, 403, 'ORIGIN_NOT_ALLOWED', 'Requests from other websites are not accepted');
      }
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (path.startsWith('/till/')) return await tillRoute(req, res, path);
      if (path === '/api/v1/products/sync' && serveCatalog(req, res)) return;
      if (path.startsWith('/api/') || path.startsWith('/uploads/')) return proxy(req, res);
      if (req.method === 'GET' || req.method === 'HEAD') return serveWeb(req, res, path);
      return problem(res, 405, 'METHOD_NOT_ALLOWED', 'Not allowed');
    })().catch((e) => {
      log(`Unexpected error: ${(e as Error).message}`);
      problem(res, 500, 'INTERNAL', 'Something went wrong in the till');
    });
  });

  return {
    server,
    branchServer: () => currentBranchServer().url,
    link,
    listen: (host) =>
      new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(opts.port, host, () => {
          const address = server.address();
          selfPort = typeof address === 'object' && address ? address.port : opts.port;
          if (linkOpts.enabled !== false) link.start();
          resolveListen(selfPort);
        });
      }),
    close: () =>
      new Promise((resolveClose) => {
        link.stop();
        // Held connections (the live-update stream) would keep the server open for ever: end them first.
        server.closeAllConnections();
        server.close(() => void (catalogCopy?.close() ?? Promise.resolve()).finally(() => resolveClose()));
      }),
  };
}
