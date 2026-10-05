// Builds everything into dist/: the CLI + server bundle, the mock agent, the
// desktop shell, and (unless --server-only) the web UI.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverOnly = process.argv.includes('--server-only');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  absWorkingDir: root,
  external: ['ws', 'node-pty', 'electron'],
  logLevel: 'warning',
};

await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', banner: { js: '#!/usr/bin/env node' } });
await build({ ...common, entryPoints: ['src/mock/mock-agent.ts'], outfile: 'dist/mock-agent.js' });
if (fs.existsSync(path.join(root, 'desktop/main.ts'))) {
  await build({ ...common, entryPoints: ['desktop/main.ts'], outfile: 'dist/desktop.js' });
}
fs.chmodSync(path.join(root, 'dist/cli.js'), 0o755);

if (!serverOnly) {
  if (!fs.existsSync(path.join(root, 'web/vite.config.ts'))) {
    console.error('web/ is missing; built the server only.');
  } else {
    const vite = path.join(root, 'node_modules/vite/bin/vite.js');
    const r = spawnSync(process.execPath, [vite, 'build', '--config', 'web/vite.config.ts'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}
console.log('built dist/');
