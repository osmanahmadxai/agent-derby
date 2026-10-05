import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, runDir, writeJsonAtomic } from './paths.js';

export const isWindows = process.platform === 'win32';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a program to completion and capture its output. Never throws. */
export function exec(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const spec = resolveSpawn(command, args);
    const child = execFile(
      spec.command,
      spec.args,
      {
        cwd: opts.cwd,
        env: opts.env ?? childEnv(),
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        shell: spec.shell,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: String(stdout),
          stderr: e && typeof e.code === 'string' ? `${stderr}${e.message}` : String(stderr),
          timedOut: Boolean(e?.killed),
        });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/**
 * Extra directories put in front of PATH for every child process.
 * The desktop app uses this to provide `node`/`npm`/`npx` when the machine has none.
 */
const extraPath: string[] = [];
export function prependPath(dir: string): void {
  if (!extraPath.includes(dir)) extraPath.unshift(dir);
}

export function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (extraPath.length) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[key] = [...extraPath, env[key] ?? ''].join(path.delimiter);
  }
  // Agent CLIs behave differently when they think they are nested inside another agent session.
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Find an executable on PATH (including the extra dirs). Returns an absolute path or null. */
export function which(name: string): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const env = childEnv();
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const dirs = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  const exts = isWindows ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'), name + ext);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) {
          if (!isWindows) fs.accessSync(full, fs.constants.X_OK);
          return full;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Windows cannot spawn `.cmd` shims without a shell. For npm shims we find the
 * JavaScript file behind the shim and run it with Node directly, which keeps
 * arguments byte-exact; otherwise we fall back to a quoted shell invocation.
 */
export function resolveSpawn(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (!isWindows || !/\.(cmd|bat)$/i.test(command)) return { command, args, shell: false };
  try {
    const shim = fs.readFileSync(command, 'utf8');
    const m = shim.match(/"%dp0%\\([^"]+?\.(?:js|mjs|cjs))"/i) ?? shim.match(/%~dp0\\([^"\s]+?\.(?:js|mjs|cjs))/i);
    if (m) {
      const js = path.join(path.dirname(command), m[1]!);
      if (fs.existsSync(js)) return { command: process.execPath, args: [js, ...args], shell: false };
    }
  } catch {
    /* fall through */
  }
  const quote = (s: string) => `"${s.replace(/(["^&|<>%])/g, '^$1')}"`;
  return { command: quote(command), args: args.map(quote), shell: true };
}

/** Spawn a long-running child in its own process group so the whole tree can be stopped. */
export function spawnGroup(command: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const spec = resolveSpawn(command, args);
  return spawn(spec.command, spec.args, {
    ...opts,
    env: opts.env ?? childEnv(),
    shell: spec.shell || opts.shell,
    detached: !isWindows,
    windowsHide: true,
  });
}

/** Spawn a shell command line (finish commands, install/start commands of previews). */
export function spawnShell(commandLine: string, opts: SpawnOptions = {}): ChildProcess {
  if (isWindows) {
    return spawn(commandLine, [], { ...opts, env: opts.env ?? childEnv(), shell: true, windowsHide: true });
  }
  return spawn('/bin/sh', ['-c', commandLine], { ...opts, env: opts.env ?? childEnv(), detached: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Send a signal to a whole process group (POSIX) or kill the tree (Windows). */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Ask nicely, then insist. Resolves when the process is gone (or after the final kill). */
export async function stopTree(pid: number, graceMs = 3000): Promise<void> {
  if (!pid || !isAlive(pid)) return;
  killTree(pid, 'SIGINT');
  if (await waitGone(pid, graceMs)) return;
  killTree(pid, 'SIGTERM');
  if (await waitGone(pid, 2000)) return;
  killTree(pid, 'SIGKILL');
  await waitGone(pid, 1000);
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid) && !groupAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid) && !groupAlive(pid);
}

function groupAlive(pid: number): boolean {
  if (isWindows) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Process registry: lets the next start-up clean up after a server that was killed.
// ---------------------------------------------------------------------------

interface RegistryEntry {
  pid: number;
  label: string;
  /** Process start time as printed by `ps`, to guard against pid reuse. */
  started: string | null;
}

const tracked = new Map<number, RegistryEntry>();

function registryFile(serverPid = process.pid): string {
  return path.join(runDir(), `${serverPid}.json`);
}

function psStart(pid: number): Promise<string | null> {
  if (isWindows) return Promise.resolve(null);
  return exec('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 3000 }).then((r) =>
    r.code === 0 ? r.stdout.trim() || null : null,
  );
}

function flushRegistry(): void {
  try {
    if (tracked.size === 0) fs.rmSync(registryFile(), { force: true });
    else writeJsonAtomic(registryFile(), [...tracked.values()]);
  } catch {
    /* best effort */
  }
}

export function trackProcess(pid: number | undefined, label: string): void {
  if (!pid) return;
  const entry: RegistryEntry = { pid, label, started: null };
  tracked.set(pid, entry);
  flushRegistry();
  void psStart(pid).then((s) => {
    if (tracked.get(pid) === entry) {
      entry.started = s;
      flushRegistry();
    }
  });
}

export function untrackProcess(pid: number | undefined): void {
  if (!pid || !tracked.delete(pid)) return;
  flushRegistry();
}

/** Kill everything this server started. Synchronous so it can run from an exit handler. */
export function killAllTracked(): void {
  for (const { pid } of tracked.values()) killTree(pid, 'SIGKILL');
  tracked.clear();
  try {
    fs.rmSync(registryFile(), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Called at start-up: find registries left by servers that no longer exist and
 * stop the processes they left behind. Returns labels of what was reaped.
 */
export async function reapOrphans(): Promise<string[]> {
  const dir = ensureDir(runDir());
  const reaped: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    const serverPid = Number(path.basename(file, '.json'));
    if (!serverPid || serverPid === process.pid) continue;
    if (isAlive(serverPid)) continue; // another Agent Derby instance is running; leave it alone
    const entries = readJson<RegistryEntry[]>(path.join(dir, file), []);
    for (const e of entries) {
      if (!isAlive(e.pid)) continue;
      // Only kill when we can prove it is the same process (not a reused pid).
      const started = await psStart(e.pid);
      if (e.started && started && e.started === started) {
        killTree(e.pid, 'SIGKILL');
        reaped.push(e.label);
      }
    }
    fs.rmSync(path.join(dir, file), { force: true });
  }
  return reaped;
}

/** Address the server and previews listen on. 127.0.0.1 unless running in a container. */
export function bindHost(): string {
  return process.env.AGENT_DERBY_HOST || '127.0.0.1';
}

/** Optional fixed range for preview ports ("4750-4769"), so a container can publish them. */
export function previewPortRange(): [number, number] | null {
  const m = (process.env.AGENT_DERBY_PREVIEW_PORTS ?? '').match(/^(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function portIsFree(net: typeof import('node:net'), port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** Reserve a free TCP port on localhost (from the preview range when one is configured). */
export async function freePort(taken: Set<number> = new Set(), useRange = false): Promise<number> {
  const net = await import('node:net');
  const range = useRange ? previewPortRange() : null;
  if (range) {
    for (let port = range[0]; port <= range[1]; port++) {
      if (!taken.has(port) && (await portIsFree(net, port, bindHost()))) return port;
    }
    throw new Error(`All preview ports ${range[0]}-${range[1]} are in use; stop a preview first`);
  }
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    if (!taken.has(port)) return port;
  }
  throw new Error('Could not find a free port');
}
