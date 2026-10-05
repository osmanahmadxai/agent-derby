import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { childEnv, envForCwd, isWindows, killTree, trackProcess, untrackProcess, which } from './proc.js';

/**
 * Interactive terminals for terminal previews and CLI sign-in.
 * Preference order: node-pty (a real pseudo-terminal with resize), then the
 * system `script` utility (a real pseudo-terminal, fixed size), then plain
 * pipes (works for line-based programs only).
 */

export type PtyBackend = 'node-pty' | 'script' | 'pipe';

export interface Terminal {
  pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface TerminalOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  label: string;
}

let nodePty: any | null | undefined;

function loadNodePty(): any | null {
  if (nodePty !== undefined) return nodePty;
  try {
    const require = createRequire(import.meta.url);
    const mod = require('node-pty');
    // Published prebuilds ship the spawn helper without its execute bit on macOS.
    try {
      const helper = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    } catch {
      /* not fatal */
    }
    nodePty = mod;
  } catch {
    nodePty = null;
  }
  return nodePty;
}

export function ptyBackend(): PtyBackend {
  if (loadNodePty()) return 'node-pty';
  if (!isWindows && which('script')) return 'script';
  return 'pipe';
}

export function openTerminal(opts: TerminalOptions): Terminal {
  const env = envForCwd(childEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', ...opts.env }), opts.cwd) as Record<string, string>;
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const pty = loadNodePty();
  if (pty) {
    try {
      const p = pty.spawn(opts.command, opts.args, { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env });
      trackProcess(p.pid, opts.label);
      let exited = false;
      return {
        pid: p.pid,
        write: (d) => !exited && p.write(d),
        resize: (c, r) => {
          try {
            if (!exited && c > 0 && r > 0) p.resize(c, r);
          } catch {
            /* terminal already gone */
          }
        },
        kill: () => {
          try {
            killTree(p.pid, 'SIGKILL');
            p.kill();
          } catch {
            /* already gone */
          }
        },
        onData: (cb) => p.onData(cb),
        onExit: (cb) =>
          p.onExit((e: { exitCode: number }) => {
            exited = true;
            untrackProcess(p.pid);
            cb(e.exitCode);
          }),
      };
    } catch {
      /* fall through to the next backend */
    }
  }

  let child: ChildProcess;
  if (!isWindows && which('script')) {
    // `script` allocates a pseudo-terminal. Its size cannot be changed later, so set it up front.
    const quoted = [opts.command, ...opts.args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${quoted}`;
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', inner] : ['-qfec', inner, '/dev/null'];
    child = spawn('script', args, { cwd: opts.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    child = spawn(opts.command, opts.args, { cwd: opts.cwd, env, detached: !isWindows, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  trackProcess(child.pid, opts.label);
  child.stdin?.on('error', () => {});
  return {
    pid: child.pid,
    write: (d) => {
      if (child.stdin?.writable) child.stdin.write(d);
    },
    resize: () => {},
    kill: () => child.pid && killTree(child.pid, 'SIGKILL'),
    onData: (cb) => {
      child.stdout?.on('data', (b: Buffer) => cb(b.toString()));
      child.stderr?.on('data', (b: Buffer) => cb(b.toString()));
    },
    onExit: (cb) => {
      child.on('error', (e) => cb(null) ?? e);
      child.on('close', (code) => {
        untrackProcess(child.pid);
        cb(code);
      });
    },
  };
}
