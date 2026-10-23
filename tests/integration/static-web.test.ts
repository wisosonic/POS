import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// The till's browser loads the web app from the API itself (one process, one address, on the shop PC).
const HTML = '<!doctype html><html><body><div id="root"></div>POS-APP</body></html>';
let root: string;
let site: string;
let c: TestCtx;
let bare: TestCtx;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pos-web-'));
  site = join(root, 'dist');
  mkdirSync(join(site, 'assets'), { recursive: true });
  writeFileSync(join(site, 'index.html'), HTML);
  writeFileSync(join(site, 'assets', 'app-3f9a1c.js'), 'console.log("app")');
  writeFileSync(join(root, 'secret.txt'), 'not for the web');
  c = await startCtx({ webDist: site });
  bare = await startCtx();
});
afterAll(async () => {
  await c.close();
  await bare.close();
  rmSync(root, { recursive: true, force: true });
});

describe('serving the web app', () => {
  it('the address of the shop PC shows the app, and the page is always re-checked so an update shows at once', async () => {
    const res = await c.http.get('/').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('POS-APP');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('hashed asset files are cached for good', async () => {
    const res = await c.http.get('/assets/app-3f9a1c.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a page address of the app (a refresh on /products) gets the app, not a 404', async () => {
    for (const path of ['/products', '/reports?tab=sales', '/register/close']) {
      const res = await c.http.get(path).set('Accept', 'text/html,application/xhtml+xml');
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('POS-APP');
    }
  });

  it('the API keeps its own answers: JSON 404s for unknown API paths, never the app, and nothing from it is cached', async () => {
    const missing = await c.http.get('/api/v1/nothing-here').set('Accept', 'text/html');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/problem\+json/);
    const health = await c.http.get('/api/v1/healthz');
    expect(health.body).toEqual({ status: 'ok' });
    expect(health.headers['cache-control']).toBe('no-store');
  });

  it('a missing file that is not a page stays a 404', async () => {
    expect((await c.http.get('/assets/gone-123.js')).status).toBe(404);
    expect((await c.http.post('/products').set('Accept', 'text/html')).status).toBe(404);
  });

  it('cannot be used to read files outside the web folder', async () => {
    for (const path of ['/../secret.txt', '/..%2Fsecret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt']) {
      const res = await c.http.get(path).set('Accept', 'text/html');
      expect(res.text, path).not.toContain('not for the web');
    }
  });
});

describe('without a built web app (development)', () => {
  it('serves nothing at the root and the API answers as before', async () => {
    const res = await bare.http.get('/').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect((await bare.http.get('/api/v1/healthz')).status).toBe(200);
  });
});
