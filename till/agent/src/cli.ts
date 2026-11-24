// The till PC's program. Three commands:
//
//   npm run serve --prefix till                          the till's own server: serves the screens and passes calls to the branch server
//                                                        (PORT 8080, HOST 127.0.0.1, TILL_DATA_DIR ./data, WEB_DIST ../web/dist,
//                                                        BRANCH_SERVER_URL as the first address, ALLOWED_HOSTS for extra names).
//                                                        Open http://localhost:8080 ; the branch server's address is set in the till's
//                                                        Settings (or on the sign-in screen's "Branch server" link).
//
// The print agent (separate for now):
//
//   npm run print-agent -w @pos/till-agent -- enrol --server http://192.168.1.10:3000 --code XXXXX-XXXXX --printer "POS-80" [--config agent.json]
//   npm run print-agent -w @pos/till-agent -- run [--config agent.json]
//
// `enrol` trades the one-time code (Settings → Tills → Print agent → New code) for the agent's own token and saves it, with the
// printer's Windows name, in the config file. `run` keeps asking the server for this till's receipts and prints them. For an
// https server with its own certificate, set NODE_EXTRA_CA_CERTS to the certificate file. The token is a secret: keep the file
// readable only by the person who runs the agent, and never paste it into chat or a ticket.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRefusedError, runAgent } from './agent';
import { windowsSpoolerPrinter } from './printer';
import { createTillServer } from './tillServer';

type Config = { server: string; token: string; printerName: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (message: string) => console.log(`${stamp()}  ${message}`);

const command = process.argv[2];
const configPath = resolve(arg('config') ?? 'agent.json');

if (command === 'serve') {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  const here = dirname(fileURLToPath(import.meta.url));
  const till = createTillServer({
    port,
    dataDir: resolve(process.env.TILL_DATA_DIR ?? 'data'),
    webDist: resolve(process.env.WEB_DIST ?? resolve(here, '../../web/dist')),
    defaultBranchServer: process.env.BRANCH_SERVER_URL,
    allowedHosts: (process.env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    log,
  });
  const actual = await till.listen(host);
  log(
    `The till is at http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}  (branch server: ${till.branchServer() ?? 'not set yet, set it in Settings'})`,
  );
  for (const s of ['SIGINT', 'SIGTERM'] as const)
    process.on(s, () => {
      void till.close().then(() => process.exit(0));
    });
} else if (command === 'enrol') {
  const server = arg('server');
  const code = arg('code');
  const printerName = arg('printer');
  if (!server || !code || !printerName) {
    console.error('Usage: print-agent enrol --server <url> --code <XXXXX-XXXXX> --printer "<Windows printer name>" [--config agent.json]');
    process.exit(1);
  }
  const res = await fetch(`${server.replace(/\/+$/, '')}/api/v1/agent/enrol`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; terminal?: { name: string }; detail?: string };
  if (!res.ok || !body.token) {
    console.error(`Could not enrol: ${body.detail ?? `the server answered ${res.status}`}`);
    process.exit(1);
  }
  writeFileSync(configPath, JSON.stringify({ server, token: body.token, printerName } satisfies Config, null, 2), { mode: 0o600 });
  log(`Enrolled as the print agent of "${body.terminal?.name}". Saved to ${configPath}. Start it with: print-agent run`);
} else if (command === 'run') {
  let config: Config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
    if (!config.server || !config.token || !config.printerName) throw new Error('incomplete');
  } catch {
    console.error(`No usable agent file at ${configPath}. Run "print-agent enrol" first.`);
    process.exit(1);
  }
  const stop = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => stop.abort());
  log(`Print agent running for ${config.server}, printer "${config.printerName}".`);
  try {
    await runAgent({ ...config, printer: windowsSpoolerPrinter, log }, stop.signal);
  } catch (e) {
    if (e instanceof AgentRefusedError) {
      console.error(e.message);
      process.exit(2); // not worth restarting by itself: the launcher should stop trying
    }
    throw e;
  }
  log('Print agent stopped.');
} else {
  console.error('Usage: serve | enrol | run  (see the comment at the top of till/agent/src/cli.ts)');
  process.exit(1);
}
