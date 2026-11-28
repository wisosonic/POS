import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuth, startHq, type Hq } from './helpers';

// The HQ screen is served by HQ itself (docs/18, P7+): its own files may load scripts and styles from HQ and nowhere else, a page address belongs to the app's router,
// the API keeps its JSON answers and its strict headers, and a route that sets its own headers (the payslip page) is not overridden.
let hq: Hq;
let bare: Hq;
let dist = '';
const api = '/api/v1';
const html = { Accept: 'text/html' };

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'hq-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
  );
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("hq")');
  writeFileSync(join(dist, 'secret.txt'), 'outside assets');
  hq = await startHq({ webDist: dist });
  bare = await startHq();
});
afterAll(async () => {
  await hq.close();
  await bare.close();
  rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('serving the HQ screen (US-HQ-screen)', () => {
  it('serves the app at the root with a policy that lets it load only its own scripts and styles', async () => {
    const r = await hq.http.get('/').set(html);
    expect(r.status).toBe(200);
    expect(r.text).toContain('<div id="root">');
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['cache-control']).toBe('no-cache');
    const csp = r.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|https?:\/\//);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('keeps a built file for a year, and serves only what is in the built folder', async () => {
    const a = await hq.http.get('/assets/app.js');
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toContain('immutable');
    expect((await hq.http.get('/..%2f..%2fpackage.json')).status).not.toBe(200);
    expect((await hq.http.get('/../../package.json')).status).not.toBe(200);
  });

  it('gives a page address to the app (a browser asks for it), and the API its JSON answers', async () => {
    const page = await hq.http.get('/branches').set(html);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<div id="root">');
    // not a browser asking for a page: an honest 404
    expect((await hq.http.get('/branches')).status).toBe(404);
    // the API never answers with the app
    const lost = await hq.http.get(`${api}/nothing-here`).set(html);
    expect(lost.status).toBe(404);
    expect(lost.headers['content-type']).toContain('json');
    // and a page POST is not the app's either
    expect((await hq.http.post('/branches').set(html).send({})).status).toBe(404);
  });

  it('the API keeps its strict headers: nothing cached, nothing loadable', async () => {
    const r = await hq.http.get(`${api}/healthz`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    const staff = await hq.http.get(`${api}/branches`).set(adminAuth);
    expect(staff.headers['cache-control']).toBe('no-store');
  });

  it('answers the API only when there is no built screen', async () => {
    expect((await bare.http.get('/').set(html)).status).toBe(404);
    expect((await bare.http.get(`${api}/healthz`)).status).toBe(200);
  });

  it('refuses a foreign Host or Origin for the screen too', async () => {
    expect((await hq.http.get('/').set(html).set('Host', 'evil.example.com')).status).toBe(403);
    expect((await hq.http.get('/').set(html).set('Origin', 'https://evil.example.com')).status).toBe(403);
  });
});

describe('a route that sets its own headers is not overridden (the payslip page)', () => {
  it('keeps its inline style allowed, and still forbids everything else', async () => {
    const run = (sql: string, p: (string | number | null)[] = []) => hq.app.database.run(sql, p);
    await run("INSERT INTO employees (id, code, name, active, created_at, updated_at) VALUES (1, 'E1', 'Sami', 1, 'x', 'x')");
    await run("INSERT INTO payroll_runs (id, from_day, to_day, status, created_at) VALUES (1, '2026-10-01', '2026-10-31', 'draft', 'x')");
    await run(
      `INSERT INTO payslips (id, run_id, employee_id, employee_code, employee_name, currency, days_worked, regular_minutes, overtime_minutes, gross_minor, deductions_minor, net_minor,
         employer_cost_minor, profile_json, rules_json, created_at) VALUES (1, 1, 1, 'E1', 'Sami', 'LBP', 1, 480, 0, 100, 0, 100, 0, '{}', '[]', 'x')`,
    );
    const link = await hq.http.post(`${api}/payroll/payslips/1/print-link`).set(adminAuth).send({});
    expect(link.status).toBe(201);
    const page = await hq.http.get(link.body.url);
    expect(page.status).toBe(200);
    const csp = page.headers['content-security-policy'] as string;
    expect(csp).toContain("style-src 'unsafe-inline'"); // without it a browser drops the page's own style block
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(page.headers['cache-control']).toContain('no-store');
  });
});
