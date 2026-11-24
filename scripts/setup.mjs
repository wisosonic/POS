// Installs what each project needs, in its own folder: `npm run setup` from the top, or `npm install` inside one project.
// Each project is complete on its own (docs/11-multi-branch.md §8), so a machine that runs only one of them installs only that one.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);
const projects = ['branch-server', 'cloud-hq', 'till'].filter((p) => only.length === 0 || only.includes(p));
for (const p of projects) {
  console.log(`\n== npm install in ${p}`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: resolve(root, p), stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
