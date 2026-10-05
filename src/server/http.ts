import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, CustomAgentConfig, ServerMessage, SystemInfo, TermClientMessage, TermServerMessage } from '../shared/types.js';
import { describeAgents, getAdapter, installAgent, invalidateDetection, detectCached } from './adapters/index.js';
import { deleteCustom, saveCustom, validateCustom } from './adapters/custom.js';
import { APP_VERSION, ensureDir, homeDir, packageFile, runDir, writeJsonAtomic } from './paths.js';
import { PreviewManager } from './preview/manager.js';
import { safeJoin, sendFile } from './preview/static.js';
import { bindHost, isWindows, killAllTracked, reapOrphans } from './proc.js';
import { RaceEngine } from './race/engine.js';
import { checkRepo, gitVersion } from './race/workspace.js';
import { sandboxStatus } from './sandbox.js';
import { openTerminal, ptyBackend, type Terminal } from './term.js';

export interface AppOptions {
  port: number;
  /** Also accept the Vite dev server as an origin. */
  dev?: boolean;
  desktop?: boolean;
  /** Pick another free port when the requested one is taken. */
  fallbackPort?: boolean;
  /**
   * Stop a race's previews (freeing their ports) once nobody has had that race
   * open for this long. Off when undefined — the terminal UI has no browser viewer.
   */
  idlePreviewStopMs?: number;
}

export interface App {
  url: string;
  port: number;
  engine: RaceEngine;
  /** What was cleaned up from a previous run that was killed. */
  recovered: { races: number; processes: string[] };
  close(): void;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
      if (data.length > 2_000_000) reject(new HttpError(413, 'Request too large'));
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(port, bindHost(), () => {
      server.off('error', onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}

export async function startApp(opts: AppOptions): Promise<App> {
  ensureDir(homeDir());
  const processes = await reapOrphans();
  const sandbox = await sandboxStatus();
  const engine = new RaceEngine(sandbox);
  const races = engine.recoverInterrupted();

  const server = http.createServer();
  let port: number;
  try {
    port = await listen(server, opts.port);
  } catch (e) {
    if (!opts.fallbackPort || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    port = await listen(server, 0);
  }

  // Only this app's own pages may talk to the API. That keeps other websites —
  // and the agent-built apps running in preview iframes — from driving it.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const originAllowed = (origin: string | undefined): boolean => {
    if (!origin) return true; // not a browser (curl, the terminal UI)
    try {
      const u = new URL(origin);
      if (allowedHosts.has(u.host)) return true;
      return Boolean(opts.dev) && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    } catch {
      return false;
    }
  };
  const hostAllowed = (host: string | undefined) => Boolean(host && (allowedHosts.has(host) || (opts.dev && /^(localhost|127\.0\.0\.1):\d+$/.test(host))));

  const webRoot = packageFile('dist', 'web');

  // ---- WebSocket: race updates -------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const termWss = new WebSocketServer({ noServer: true });
  const subs = new Map<WebSocket, Set<string>>();
  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    for (const ws of subs.keys()) send(ws, msg);
  };
  engine.on('message', (msg: ServerMessage) => {
    const raceId = 'raceId' in msg ? msg.raceId : msg.type === 'race' ? msg.race.id : null;
    for (const [ws, set] of subs) if (!raceId || set.has(raceId)) send(ws, msg);
  });
  wss.on('connection', (ws) => {
    subs.set(ws, new Set());
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'subscribe' && typeof msg.raceId === 'string') {
        subs.get(ws)?.add(msg.raceId);
        for (const m of engine.snapshotMessages(msg.raceId)) send(ws, m);
      } else if (msg.type === 'unsubscribe') subs.get(ws)?.delete(msg.raceId);
    });
    ws.on('close', () => subs.delete(ws));
    ws.on('error', () => subs.delete(ws));
  });

  // ---- WebSocket: interactive terminals ----------------------------------
  const terminals = new Set<Terminal>();
  termWss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const tsend = (m: TermServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    let term: Terminal | null = null;
    let size = { cols: 80, rows: 24 };
    let closed = false;

    const start = async () => {
      let spec: { command: string; args: string[]; cwd: string; env?: Record<string, string>; shown: string; label: string; after?: () => void } | null = null;
      const login = q.get('login');
      if (login) {
        const adapter = getAdapter(login);
        const det = adapter ? await detectCached(adapter) : null;
        if (adapter?.login && det?.path) {
          const l = adapter.login(det.path);
          spec = {
            command: l.command,
            args: l.args,
            env: l.env,
            cwd: os.homedir(),
            shown: `${adapter.name} sign-in`,
            label: `login ${login}`,
            after: () => {
              invalidateDetection(login);
              broadcast({ type: 'agents_changed' });
            },
          };
          tsend({ type: 'data', data: `\x1b[2m${l.hint}\x1b[0m\r\n\r\n` });
        }
      } else {
        const t = engine.previews.terminalSpec(PreviewManager.key(q.get('raceId') ?? '', q.get('laneId') ?? ''));
        if (t) spec = { ...t, label: `terminal ${q.get('raceId')}/${q.get('laneId')}` };
      }
      if (!spec) {
        tsend({ type: 'data', data: 'Nothing to run here.\r\n' });
        tsend({ type: 'exit', code: null });
        return;
      }
      if (closed) return;
      const t = openTerminal({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, cols: size.cols, rows: size.rows, label: spec.label });
      term = t;
      terminals.add(t);
      tsend({ type: 'started', command: spec.shown });
      t.onData((data) => tsend({ type: 'data', data }));
      t.onExit((code) => {
        terminals.delete(t);
        if (term === t) term = null;
        spec?.after?.();
        tsend({ type: 'exit', code });
      });
    };

    ws.on('message', (raw) => {
      let msg: TermClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') term?.write(msg.data);
      else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
        size = { cols: Math.min(500, Math.floor(msg.cols)), rows: Math.min(300, Math.floor(msg.rows)) };
        term?.resize(size.cols, size.rows);
      } else if (msg.type === 'restart') {
        term?.kill();
        term = null;
        void start();
      }
    });
    const end = () => {
      closed = true;
      term?.kill();
      if (term) terminals.delete(term);
      term = null;
    };
    ws.on('close', end);
    ws.on('error', end);
    // Give the client a moment to report its size, so full-screen programs draw correctly from the start.
    setTimeout(() => void start(), 120);
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      socket.destroy();
      return;
    }
    if (pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else if (pathname === '/ws/term') termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
    else socket.destroy();
  });

  // ---- REST ----------------------------------------------------------------
  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};
    const is = (m: string, ...pattern: string[]) =>
      method === m && parts.length === pattern.length && pattern.every((p, i) => p.startsWith(':') || p === parts[i]);

    if (is('GET', 'system')) {
      const info: SystemInfo = {
        appVersion: APP_VERSION,
        platform: process.platform,
        git: await gitVersion(),
        node: process.version,
        home: homeDir(),
        pty: ptyBackend(),
        desktop: Boolean(opts.desktop),
      };
      return json(res, 200, { ...info, sandbox });
    }
    if (is('GET', 'agents')) return json(res, 200, await describeAgents());
    if (is('POST', 'agents', ':id', 'install')) {
      const adapter = getAdapter(parts[1]!);
      if (!adapter?.managed) throw new HttpError(400, 'This agent cannot be installed automatically');
      const agentId = adapter.id;
      void installAgent(adapter, (line) => broadcast({ type: 'install', agentId, line })).then((ok) => {
        broadcast({ type: 'install', agentId, done: true, ok });
        broadcast({ type: 'agents_changed' });
      });
      return json(res, 200, { ok: true });
    }
    if (is('POST', 'agents', 'refresh')) {
      invalidateDetection();
      return json(res, 200, await describeAgents());
    }
    if (is('POST', 'custom-agents')) {
      const c = body as CustomAgentConfig;
      const problem = validateCustom(c);
      if (problem) throw new HttpError(400, problem);
      saveCustom(c);
      invalidateDetection();
      broadcast({ type: 'agents_changed' });
      return json(res, 200, { ok: true });
    }
    if (is('DELETE', 'custom-agents', ':id')) {
      deleteCustom(parts[1]!);
      broadcast({ type: 'agents_changed' });
      return json(res, 200, { ok: true });
    }
    if (is('POST', 'check-repo')) return json(res, 200, await checkRepo(String(body.path ?? '')));

    if (is('POST', 'races')) {
      const race = await engine.create(body).catch((e) => {
        throw new HttpError(400, (e as Error).message);
      });
      return json(res, 200, { id: race.id });
    }
    if (is('GET', 'races')) return json(res, 200, engine.list());

    if (parts[0] === 'races' && parts[1]) {
      const raceId = parts[1];
      const laneId = parts[2] === 'lanes' ? parts[3] : undefined;
      const wrap = async <T>(fn: () => T | Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (e) {
          const message = (e as Error).message;
          throw new HttpError(/not found/i.test(message) ? 404 : 400, message);
        }
      };
      if (is('GET', 'races', ':id')) {
        const race = engine.get(raceId);
        if (!race) throw new HttpError(404, 'Race not found');
        return json(res, 200, race);
      }
      if (is('DELETE', 'races', ':id')) return json(res, 200, (await wrap(() => engine.deleteRace(raceId)), { ok: true }));
      if (is('POST', 'races', ':id', 'stop')) return json(res, 200, (await wrap(() => engine.stopRace(raceId)), { ok: true }));
      if (is('POST', 'races', ':id', 'close')) return json(res, 200, (await wrap(() => engine.closeRace(raceId)), { ok: true }));
      if (is('GET', 'races', ':id', 'export')) {
        const data = await wrap(() => engine.exportRace(raceId));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="agent-derby-${raceId}.json"`,
        });
        res.end(JSON.stringify(data, null, 2));
        return;
      }
      if (laneId) {
        const rest = parts.slice(4);
        const at = (m: string, ...p: string[]) => method === m && rest.length === p.length && p.every((x, i) => x === rest[i]);
        if (at('GET', 'feed')) return json(res, 200, await wrap(() => engine.feed(raceId, laneId)));
        if (at('GET', 'diff')) return json(res, 200, await wrap(() => engine.diff(raceId, laneId)));
        if (at('POST', 'stop')) return json(res, 200, (await wrap(() => engine.stopLane(raceId, laneId)), { ok: true }));
        if (at('POST', 'keep')) return json(res, 200, { ok: true, detail: await wrap(() => engine.keep(raceId, laneId, body)) });
        if (at('POST', 'preview', 'start')) return json(res, 200, (await wrap(() => engine.startPreview(raceId, laneId, body)), { ok: true }));
        if (at('POST', 'preview', 'stop')) return json(res, 200, (await wrap(() => engine.stopPreview(raceId, laneId)), { ok: true }));
        if (at('GET', 'preview', 'logs')) return json(res, 200, { log: await wrap(() => engine.previewLogs(raceId, laneId)) });
        if (at('POST', 'open')) {
          const race = engine.get(raceId);
          const lane = race?.lanes.find((l) => l.id === laneId);
          if (!lane || !fs.existsSync(lane.workspace)) throw new HttpError(404, 'Workspace not found');
          const opener = process.platform === 'darwin' ? 'open' : isWindows ? 'explorer' : 'xdg-open';
          spawn(opener, [lane.workspace], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
          return json(res, 200, { ok: true, path: lane.workspace });
        }
      }
    }
    throw new HttpError(404, 'Not found');
  }

  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !originAllowed(req.headers.origin)) {
        json(res, 403, { error: 'Forbidden origin' });
        return;
      }
      api(req, res, url).catch((e) => {
        if (res.headersSent) return res.end();
        if (e instanceof HttpError) json(res, e.status, { error: e.message });
        else json(res, 500, { error: (e as Error).message || 'Internal error' });
      });
      return;
    }
    const file = safeJoin(webRoot, url.pathname === '/' ? '/index.html' : url.pathname);
    if (file && sendFile(res, file, url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store')) return;
    if (sendFile(res, path.join(webRoot, 'index.html'))) return;
    res.writeHead(503, { 'Content-Type': 'text/plain' }).end('The web UI has not been built. Run: npm run build');
  });

  // Previews nobody is looking at should not keep ports open.
  const lastWatched = new Map<string, number>();
  const idleTimer = opts.idlePreviewStopMs
    ? setInterval(() => {
        const watched = new Set<string>();
        for (const set of subs.values()) for (const id of set) watched.add(id);
        for (const summary of engine.liveRaces()) {
          if (watched.has(summary.id)) lastWatched.set(summary.id, Date.now());
          else if (summary.hasPreviews && !summary.running) {
            const since = lastWatched.get(summary.id) ?? (lastWatched.set(summary.id, Date.now()), Date.now());
            if (Date.now() - since > opts.idlePreviewStopMs!) {
              lastWatched.delete(summary.id);
              void engine.closeRace(summary.id);
            }
          }
        }
      }, 15_000)
    : null;
  idleTimer?.unref();

  // Lets `agent-derby watch` and friends find a running instance.
  const marker = path.join(ensureDir(runDir()), 'server.json');
  writeJsonAtomic(marker, { pid: process.pid, port });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearInterval(idleTimer);
    engine.shutdownNow();
    for (const t of terminals) t.kill();
    killAllTracked();
    try {
      const current = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (current.pid === process.pid) fs.rmSync(marker, { force: true });
    } catch {
      /* already gone */
    }
    for (const ws of subs.keys()) ws.terminate();
    server.close();
    server.closeAllConnections?.();
  };

  return { url: `http://localhost:${port}`, port, engine, recovered: { races, processes }, close };
}
