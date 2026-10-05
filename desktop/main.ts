/**
 * Desktop shell: the same local server and web UI as `npx agent-derby`, in a
 * native window. It also makes the app self-sufficient on machines without
 * Node.js: Electron's own runtime is exposed to child processes as `node`,
 * with a bundled `npm`/`npx`, so agent CLIs can be installed and agent-built
 * projects can be run without installing anything else.
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startApp, type App } from '../src/server/http.js';
import { ensureDir, homeDir } from '../src/server/paths.js';
import { prependPath, which } from '../src/server/proc.js';

let server: App | null = null;
let win: BrowserWindow | null = null;

/** Apps launched from the Dock or Start menu get a bare PATH; recover the user's real one. */
function fixPath(): void {
  if (process.platform === 'win32') return;
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin')];
  try {
    const shellPath = execFileSync(process.env.SHELL || '/bin/sh', ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (shellPath.includes('/')) process.env.PATH = shellPath;
  } catch {
    /* keep what we have */
  }
  const have = new Set((process.env.PATH ?? '').split(path.delimiter));
  process.env.PATH = [process.env.PATH, ...extra.filter((d) => !have.has(d) && fs.existsSync(d))].filter(Boolean).join(path.delimiter);
}

/** When the machine has no Node.js, provide `node`, `npm` and `npx` backed by Electron. */
function provideNode(): void {
  if (which('node') && which('npm')) return;
  const dir = ensureDir(path.join(homeDir(), 'shims'));
  const require = createRequire(import.meta.url);
  let npmCli: string | null = null;
  let npxCli: string | null = null;
  try {
    const npmRoot = path.dirname(require.resolve('npm/package.json'));
    npmCli = path.join(npmRoot, 'bin', 'npm-cli.js');
    npxCli = path.join(npmRoot, 'bin', 'npx-cli.js');
  } catch {
    /* npm was not bundled: node alone is still useful */
  }
  const exe = process.execPath;
  const shim = (name: string, script: string | null) => {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" ${script ? `"${script}" ` : ''}%*\r\n`);
    } else {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" ${script ? `"${script}" ` : ''}"$@"\n`);
      fs.chmodSync(file, 0o755);
    }
  };
  if (!which('node')) shim('node', null);
  if (!which('npm') && npmCli) shim('npm', npmCli);
  if (!which('npx') && npxCli) shim('npx', npxCli);
  prependPath(dir);
}

function createWindow(url: string): void {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: 'Agent Derby',
    backgroundColor: '#0e1420',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Links out of the app (docs, "open preview in new tab") go to the real browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  void win.loadURL(url);
  win.on('closed', () => (win = null));
}

function quit(): void {
  server?.close();
  server = null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    fixPath();
    provideNode();
    try {
      server = await startApp({ port: 4747, fallbackPort: true, desktop: true, idlePreviewStopMs: 120_000 });
    } catch (e) {
      dialog.showErrorBox('Agent Derby could not start', (e as Error).message);
      app.quit();
      return;
    }
    createWindow(server.url);
    app.on('activate', () => {
      if (!win && server) createWindow(server.url);
    });
  });

  // Closing the window ends the app everywhere: nothing keeps running unseen.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', quit);
  process.on('exit', quit);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      quit();
      app.exit(0);
    });
  }
}
