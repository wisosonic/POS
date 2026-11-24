// The print agent for a till PC. Two commands:
//
//   npm run print-agent -w @pos/till-agent -- enrol --server http://192.168.1.10:3000 --code XXXXX-XXXXX --printer "POS-80" [--config agent.json]
//   npm run print-agent -w @pos/till-agent -- run [--config agent.json]
//
// `enrol` trades the one-time code (Settings → Tills → Print agent → New code) for the agent's own token and saves it, with the
// printer's Windows name, in the config file. `run` keeps asking the server for this till's receipts and prints them. For an
// https server with its own certificate, set NODE_EXTRA_CA_CERTS to the certificate file. The token is a secret: keep the file
// readable only by the person who runs the agent, and never paste it into chat or a ticket.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRefusedError, runAgent } from './agent';
import { windowsSpoolerPrinter } from '@pos/core/printer';

type Config = { server: string; token: string; printerName: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (message: string) => console.log(`${stamp()}  ${message}`);

const command = process.argv[2];
const configPath = resolve(arg('config') ?? 'agent.json');

if (command === 'enrol') {
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
  console.error('Usage: print-agent enrol|run  (see the comment at the top of apps/till-agent/src/cli.ts)');
  process.exit(1);
}
