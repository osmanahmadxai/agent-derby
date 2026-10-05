import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { emptyPreview, type BuildOutcome, type ManualPreviewRequest, type PreviewInfo } from '../../shared/types.js';
import { bindHost, childEnv, freePort, isWindows, previewPortRange, spawnGroup, spawnShell, stopTree, killTree, trackProcess, untrackProcess } from '../proc.js';
import { wrapShell, type SandboxStatus } from '../sandbox.js';
import { buildCommand, detectPlan, readManifest, type RunPlan } from './plan.js';
import { serveStatic } from './static.js';

/**
 * Runs what each agent built: installs dependencies, checks the build, starts
 * the result on a free port and waits until it answers. One entry per lane;
 * a failure in one never affects another. Everything started here is stopped
 * when the race is closed or the app exits.
 */

const LOG_LIMIT = 400_000;
const INSTALL_TIMEOUT = 10 * 60_000;
const BUILD_TIMEOUT = 5 * 60_000;
const START_TIMEOUT = 90_000;

interface Entry {
  key: string;
  raceId: string;
  workspace: string;
  info: PreviewInfo;
  log: string;
  plan: RunPlan | null;
  child: ChildProcess | null;
  server: http.Server | null;
  /** Container mode: forwards a published port to an app that only listens on localhost. */
  forwarder: net.Server | null;
  /** Bumped on every start/stop so a superseded run stops reporting. */
  generation: number;
}

export interface TerminalSpec {
  command: string;
  args: string[];
  cwd: string;
  shown: string;
}

export type PreviewListener = (key: string, info: PreviewInfo, build?: BuildOutcome) => void;

function probe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true); // any HTTP answer, even a 404, means a server is there
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function answers(port: number): Promise<boolean> {
  return (await probe(port, '127.0.0.1')) || (await probe(port, '::1'));
}

export class PreviewManager {
  private entries = new Map<string, Entry>();
  private ports = new Set<number>();

  constructor(
    private sandbox: SandboxStatus,
    private listener: PreviewListener,
  ) {}

  static key(raceId: string, laneId: string): string {
    return `${raceId}/${laneId}`;
  }

  logs(key: string): string {
    return this.entries.get(key)?.log ?? '';
  }

  info(key: string): PreviewInfo | null {
    return this.entries.get(key)?.info ?? null;
  }

  private log(e: Entry, text: string): void {
    e.log += text;
    if (e.log.length > LOG_LIMIT) e.log = `… earlier output dropped …\n${e.log.slice(-LOG_LIMIT * 0.75)}`;
  }

  private update(e: Entry, gen: number, patch: Partial<PreviewInfo>, build?: BuildOutcome): void {
    if (e.generation !== gen) return;
    e.info = { ...e.info, ...patch };
    this.listener(e.key, e.info, build);
  }

  /** Run one shell step (install or build) to completion inside the sandbox. */
  private runStep(e: Entry, gen: number, commandLine: string, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      this.log(e, `\n$ ${commandLine}\n`);
      const w = wrapShell(this.sandbox, commandLine, { workspace: e.workspace });
      const child = isWindows
        ? spawnShell(commandLine, { cwd: e.workspace, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ CI: '1' }) })
        : spawnGroup(w.command, w.args, { cwd: e.workspace, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ CI: '1' }) });
      e.child = child;
      trackProcess(child.pid, `preview step ${e.key}`);
      const timer = setTimeout(() => {
        this.log(e, `\n[agent-derby] timed out after ${Math.round(timeoutMs / 1000)}s\n`);
        if (child.pid) killTree(child.pid, 'SIGKILL');
      }, timeoutMs);
      child.stdout?.on('data', (b: Buffer) => this.log(e, b.toString()));
      child.stderr?.on('data', (b: Buffer) => this.log(e, b.toString()));
      const done = (code: number | null) => {
        clearTimeout(timer);
        untrackProcess(child.pid);
        if (e.child === child) e.child = null;
        resolve(e.generation === gen ? code : null);
      };
      child.on('error', (err) => {
        this.log(e, `\n[agent-derby] could not run: ${err.message}\n`);
        done(127);
      });
      child.on('close', done);
    });
  }

  /**
   * Start (or restart) the preview for a lane. Without `manual`, the manifest
   * is tried first, then detection from the project's files.
   */
  async start(raceId: string, laneId: string, workspace: string, manual?: ManualPreviewRequest): Promise<void> {
    const key = PreviewManager.key(raceId, laneId);
    await this.stop(key, false);
    const e: Entry = this.entries.get(key) ?? { key, raceId, workspace, info: emptyPreview(), log: '', plan: null, child: null, server: null, forwarder: null, generation: 0 };
    this.entries.set(key, e);
    const gen = ++e.generation;
    e.workspace = workspace;
    e.log = '';
    e.info = emptyPreview();

    // 1. Decide how to run it.
    let plan: RunPlan | null = null;
    let manifestProblem: string | null = null;
    if (manual?.command?.trim()) {
      plan = { type: manual.type ?? 'web', install: null, start: manual.command.trim(), root: null, source: 'manual' };
    } else if (manual?.type === 'static') {
      plan = { type: 'static', install: null, start: null, root: '.', source: 'manual' };
    } else {
      const m = readManifest(workspace);
      if (m.plan) plan = m.plan;
      else {
        manifestProblem = m.problem;
        this.log(e, `[agent-derby] ${m.problem}; detecting the project type from its files instead.\n`);
        plan = detectPlan(workspace);
      }
    }
    if (!plan) {
      this.log(e, '[agent-derby] Could not work out how to run this project.\n');
      this.update(e, gen, {
        status: 'failed',
        manifestProblem,
        error: 'Could not work out how to run this project. Enter a command below to try it yourself.',
      });
      return;
    }
    e.plan = plan;
    this.update(e, gen, {
      type: plan.type,
      source: plan.source,
      installCommand: plan.install,
      startCommand: plan.start,
      manifestProblem,
      status: plan.install ? 'installing' : 'starting',
    });

    // 2. Install dependencies.
    if (plan.install) {
      const code = await this.runStep(e, gen, plan.install, INSTALL_TIMEOUT);
      if (e.generation !== gen) return;
      if (code !== 0) {
        this.update(e, gen, { status: 'failed', error: `Installing dependencies failed (exit code ${code ?? 'unknown'}). See the logs.` });
        return;
      }
    }

    // 3. Does it build? (Only when the project declares a build script.)
    const build = buildCommand(workspace);
    let buildOutcome: BuildOutcome = 'no_build_script';
    if (build) {
      this.update(e, gen, { status: 'building' });
      const code = await this.runStep(e, gen, build, BUILD_TIMEOUT);
      if (e.generation !== gen) return;
      buildOutcome = code === 0 ? 'passed' : 'failed';
      if (code !== 0) this.log(e, `\n[agent-derby] build failed (exit code ${code}); trying to start anyway.\n`);
    }
    this.update(e, gen, { status: 'starting' }, buildOutcome);

    // 4. Start it.
    try {
      if (plan.type === 'static') await this.startStatic(e, gen, plan);
      else if (plan.type === 'web') await this.startWeb(e, gen, plan);
      else if (plan.start) {
        // Terminal programs start when the embedded terminal connects.
        this.update(e, gen, { status: 'ready', note: this.sandbox.kind === 'none' ? null : 'Runs inside the sandbox' });
      } else {
        this.update(e, gen, { status: 'failed', error: 'The agent described this as "other" and gave no command to run. Enter one below.' });
      }
    } catch (err) {
      this.log(e, `\n[agent-derby] ${(err as Error).message}\n`);
      this.update(e, gen, { status: 'failed', error: (err as Error).message });
    }
  }

  private async reservePort(published = true): Promise<number> {
    const port = await freePort(this.ports, published);
    this.ports.add(port);
    return port;
  }

  private async startStatic(e: Entry, gen: number, plan: RunPlan): Promise<void> {
    const root = path.resolve(e.workspace, plan.root ?? '.');
    const port = await this.reservePort();
    const server = await serveStatic(root, port, bindHost());
    if (e.generation !== gen) {
      server.close();
      this.ports.delete(port);
      return;
    }
    e.server = server;
    this.log(e, `[agent-derby] Serving ${path.relative(e.workspace, root) || '.'} on port ${port}\n`);
    this.update(e, gen, { status: 'ready', port, url: `http://${bindHost() === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:${port}/` });
  }

  /**
   * In a container only a fixed range of ports is published, and apps often
   * listen on localhost only. Publish `appPort` on a port from the range.
   */
  private async publish(e: Entry, appPort: number): Promise<number> {
    if (!previewPortRange() || bindHost() === '127.0.0.1') return appPort;
    const port = await this.reservePort(true);
    const forwarder = net.createServer((client) => {
      const connect = (host: string, retry: boolean) => {
        const upstream = net.connect(appPort, host);
        upstream.once('error', () => (retry ? connect('::1', false) : client.destroy()));
        upstream.once('connect', () => {
          client.pipe(upstream);
          upstream.pipe(client);
        });
        client.once('error', () => upstream.destroy());
        client.once('close', () => upstream.destroy());
      };
      connect('127.0.0.1', true);
    });
    await new Promise<void>((resolve, reject) => {
      forwarder.once('error', reject);
      forwarder.listen(port, bindHost(), () => resolve());
    });
    e.forwarder = forwarder;
    return port;
  }

  private async startWeb(e: Entry, gen: number, plan: RunPlan): Promise<void> {
    const port = await this.reservePort(false);
    const commandLine = plan.start!;
    this.log(e, `\n$ PORT=${port} ${commandLine}\n`);
    const env = childEnv({ PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' });
    const w = wrapShell(this.sandbox, commandLine, { workspace: e.workspace });
    const child = isWindows
      ? spawnShell(commandLine, { cwd: e.workspace, stdio: ['ignore', 'pipe', 'pipe'], env })
      : spawnGroup(w.command, w.args, { cwd: e.workspace, stdio: ['ignore', 'pipe', 'pipe'], env });
    e.child = child;
    trackProcess(child.pid, `preview ${e.key}`);
    this.update(e, gen, { port });

    let exited: number | null | undefined;
    let spawnError: string | null = null;
    child.stdout?.on('data', (b: Buffer) => this.log(e, b.toString()));
    child.stderr?.on('data', (b: Buffer) => this.log(e, b.toString()));
    child.on('error', (err) => {
      spawnError = err.message;
      exited = 127;
    });
    child.on('close', (code) => {
      exited = code;
      untrackProcess(child.pid);
      this.ports.delete(port);
      if (e.child === child) e.child = null;
      // The app died after it was up: say so instead of leaving a dead iframe.
      if (e.generation === gen && e.info.status === 'ready') {
        this.log(e, `\n[agent-derby] the app exited (code ${code}).\n`);
        this.update(e, gen, { status: 'failed', error: `The app stopped running (exit code ${code}).`, url: null });
      }
    });

    const deadline = Date.now() + START_TIMEOUT;
    while (Date.now() < deadline) {
      if (e.generation !== gen) return;
      if (exited !== undefined) {
        throw new Error(spawnError ? `Could not start: ${spawnError}` : `The start command exited straight away (exit code ${exited}). See the logs.`);
      }
      if (await answers(port)) {
        const shown = await this.publish(e, port);
        this.update(e, gen, { status: 'ready', port: shown, url: `http://localhost:${shown}/` });
        return;
      }
      // Some servers ignore PORT. If the log names another local port and it answers, use it and say so.
      const other = this.portFromLog(e.log, port);
      if (other && (await answers(other))) {
        const shown = await this.publish(e, other);
        this.update(e, gen, {
          status: 'ready',
          port: shown,
          url: `http://localhost:${shown}/`,
          note: `The app ignored PORT=${port} and is listening on ${other}`,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    if (child.pid) killTree(child.pid, 'SIGKILL');
    throw new Error(`Nothing answered on port ${port} within ${START_TIMEOUT / 1000}s. See the logs.`);
  }

  private portFromLog(log: string, assigned: number): number | null {
    const matches = [...log.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/g)];
    for (const m of matches.reverse()) {
      const p = Number(m[1]);
      if (p && p !== assigned) return p;
    }
    return null;
  }

  /** Command for the embedded terminal of a terminal-type preview. */
  terminalSpec(key: string): TerminalSpec | null {
    const e = this.entries.get(key);
    if (!e?.plan?.start || (e.plan.type !== 'terminal' && e.plan.type !== 'other')) return null;
    if (isWindows) return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', e.plan.start], cwd: e.workspace, shown: e.plan.start };
    const w = wrapShell(this.sandbox, e.plan.start, { workspace: e.workspace });
    return { command: w.command, args: w.args, cwd: e.workspace, shown: e.plan.start };
  }

  async stop(key: string, announce = true): Promise<void> {
    const e = this.entries.get(key);
    if (!e) return;
    e.generation++;
    const child = e.child;
    e.child = null;
    if (child?.pid) {
      await stopTree(child.pid, 1500);
      untrackProcess(child.pid);
    }
    if (e.server) {
      e.server.closeAllConnections?.();
      e.server.close();
      e.server = null;
    }
    if (e.forwarder) {
      e.forwarder.close();
      e.forwarder = null;
    }
    if (e.info.port) this.ports.delete(e.info.port);
    if (announce && e.info.status !== 'none' && e.info.status !== 'failed') {
      e.info = { ...e.info, status: 'stopped', url: null, port: null };
      this.listener(e.key, e.info);
    }
  }

  async stopRace(raceId: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter((e) => e.raceId === raceId).map((e) => this.stop(e.key)));
  }

  forget(raceId: string): void {
    for (const [key, e] of this.entries) if (e.raceId === raceId) this.entries.delete(key);
  }

  /** Synchronous: used from process exit handlers. */
  killAllNow(): void {
    for (const e of this.entries.values()) {
      e.generation++;
      if (e.child?.pid) killTree(e.child.pid, 'SIGKILL');
      e.server?.close();
      e.forwarder?.close();
    }
  }
}
