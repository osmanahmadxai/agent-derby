import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, which } from './proc.js';

/**
 * OS-level confinement for everything a race runs: the agent CLIs, the finish
 * command, and the code the agents wrote (install/build/start of previews).
 *
 * The sandbox is deliberately "a real environment": the full filesystem is
 * readable, every installed tool works, and the network is open. What it takes
 * away is the ability to WRITE anywhere except the agent's own workspace, temp
 * folders, package-manager caches, and the agent CLI's own state folder.
 *
 *   macOS   -> Seatbelt (sandbox-exec), built into the OS
 *   Linux   -> bubblewrap (bwrap), when installed
 *   Windows -> no OS sandbox available; reported as such, never hidden
 */

export type SandboxKind = 'seatbelt' | 'bubblewrap' | 'none';

export interface SandboxStatus {
  kind: SandboxKind;
  /** One line for the UI. */
  label: string;
  /** Why there is no sandbox, when kind is 'none'. */
  reason: string | null;
}

let cached: SandboxStatus | null = null;

export async function sandboxStatus(): Promise<SandboxStatus> {
  if (cached) return cached;
  cached = await probe();
  return cached;
}

async function probe(): Promise<SandboxStatus> {
  if (process.env.AGENT_DERBY_NO_SANDBOX === '1') {
    return { kind: 'none', label: 'Sandbox off (AGENT_DERBY_NO_SANDBOX=1)', reason: 'disabled by environment variable' };
  }
  if (process.env.AGENT_DERBY_CONTAINER === '1') {
    return { kind: 'none', label: 'Running in a container: the container is the sandbox', reason: 'the container itself is the boundary' };
  }
  if (process.platform === 'darwin') {
    const r = await exec('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeoutMs: 5000 });
    if (r.code === 0) {
      return { kind: 'seatbelt', label: 'macOS sandbox: writes limited to the workspace', reason: null };
    }
    return {
      kind: 'none',
      label: 'No sandbox: sandbox-exec is not usable here',
      reason: (r.stderr || 'sandbox-exec failed').trim().slice(0, 200),
    };
  }
  if (process.platform === 'linux') {
    const bwrap = which('bwrap');
    if (bwrap) {
      const r = await exec(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '/bin/true'], { timeoutMs: 5000 });
      if (r.code === 0) return { kind: 'bubblewrap', label: 'bubblewrap sandbox: writes limited to the workspace', reason: null };
      return {
        kind: 'none',
        label: 'No sandbox: bubblewrap is installed but cannot start',
        reason: (r.stderr || 'bwrap failed').trim().slice(0, 200),
      };
    }
    return {
      kind: 'none',
      label: 'No sandbox: install bubblewrap (bwrap) to confine agents',
      reason: 'bubblewrap (bwrap) not found on PATH',
    };
  }
  return {
    kind: 'none',
    label: 'No OS sandbox on this platform: agents are separated by workspace only',
    reason: `no sandbox backend for ${process.platform}`,
  };
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Places outside the workspace that must stay writable for a normal
 * development environment to work: temp folders, package-manager caches and
 * toolchain state. Nothing here is the user's own work.
 */
function sharedWritable(): string[] {
  const home = os.homedir();
  const list = [
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    '/private/var/folders',
    '/var/folders',
    '/var/tmp',
    path.join(home, '.npm'),
    path.join(home, '.cache'),
    path.join(home, '.pnpm-store'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.local', 'state'),
    path.join(home, '.yarn'),
    path.join(home, '.bun'),
    path.join(home, '.cargo'),
    path.join(home, '.rustup'),
    path.join(home, 'go', 'pkg'),
    path.join(home, '.gradle'),
    path.join(home, '.m2'),
    path.join(home, '.pub-cache'),
    path.join(home, 'Library', 'Caches'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, 'Library', 'Logs'),
  ];
  return list;
}

export interface WrapOptions {
  workspace: string;
  /** Extra writable paths (an agent CLI's own state folder). Files or directories. */
  writable?: string[];
}

export interface Wrapped {
  command: string;
  args: string[];
}

/** Wrap a command so it runs confined. Returns it unchanged when no sandbox is available. */
export function wrap(status: SandboxStatus, command: string, args: string[], opts: WrapOptions): Wrapped {
  if (status.kind === 'seatbelt') return wrapSeatbelt(command, args, opts);
  if (status.kind === 'bubblewrap') return wrapBubblewrap(command, args, opts);
  return { command, args };
}

function sbQuote(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function seatbeltProfile(opts: WrapOptions): string {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const add = (p: string) => {
    for (const v of new Set([p, real(p)])) {
      let isFile = false;
      try {
        isFile = fs.statSync(v).isFile();
      } catch {
        isFile = /\.[a-z]+$/i.test(path.basename(v)) && !v.endsWith('.d');
      }
      (isFile ? files : dirs).add(v);
    }
  };
  add(opts.workspace);
  for (const p of sharedWritable()) dirs.add(p), dirs.add(real(p));
  for (const p of opts.writable ?? []) add(p);

  const rules: string[] = [];
  for (const d of dirs) rules.push(`(subpath ${sbQuote(d)})`);
  for (const f of files) {
    rules.push(`(literal ${sbQuote(f)})`);
    // CLIs write state files atomically: <file>.tmp.<n>, <file>.lock, <file>.backup
    if (!f.includes('"')) rules.push(`(regex #"^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.|-)")`);
  }
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/") (literal "/dev/ptmx") (literal "/dev/random") (literal "/dev/urandom")',
    ...rules.map((r) => `  ${r}`),
    ')',
  ].join('\n');
}

function wrapSeatbelt(command: string, args: string[], opts: WrapOptions): Wrapped {
  return { command: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(opts), command, ...args] };
}

function wrapBubblewrap(command: string, args: string[], opts: WrapOptions): Wrapped {
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent'];
  const bind = (p: string) => {
    const r = real(p);
    if (fs.existsSync(r)) a.push('--bind', r, r);
  };
  for (const p of sharedWritable()) bind(p);
  for (const p of opts.writable ?? []) bind(p);
  bind(opts.workspace);
  a.push('--chdir', real(opts.workspace), command, ...args);
  return { command: which('bwrap') ?? 'bwrap', args: a };
}

/** Wrap a shell command line (finish command, preview install/build/start). */
export function wrapShell(status: SandboxStatus, commandLine: string, opts: WrapOptions): Wrapped {
  if (process.platform === 'win32') return { command: commandLine, args: [] };
  return wrap(status, '/bin/sh', ['-c', commandLine], opts);
}
