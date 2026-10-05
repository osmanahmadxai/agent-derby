import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  emptyMetrics,
  emptyPreview,
  isTerminal,
  rankLanes,
  type BuildOutcome,
  type FeedItem,
  type KeepRequest,
  type Lane,
  type LaneDiff,
  type LaneMetrics,
  type LaneState,
  type ManualPreviewRequest,
  type NowStatus,
  type PreviewInfo,
  type Race,
  type RaceSetup,
  type RaceSummary,
  type ServerMessage,
  type ToolKind,
} from '../../shared/types.js';
import { detectCached, getAdapter, invalidateDetection, type AgentAdapter } from '../adapters/index.js';
import type { AgentEvent, EventParser, StartContext } from '../adapters/types.js';
import { APP_VERSION, ensureDir, raceDir, racesDir, readJson, writeJsonAtomic } from '../paths.js';
import { childEnv, isWindows, killTree, spawnGroup, spawnShell, stopTree, trackProcess, untrackProcess } from '../proc.js';
import { PreviewManager } from '../preview/manager.js';
import { buildPrompt } from '../preview/plan.js';
import { wrap, wrapShell, type SandboxStatus } from '../sandbox.js';
import { MetricsTracker, parseTestCounts } from './metrics.js';
import { loadPrices } from './pricing.js';
import {
  checkRepo,
  codeStats,
  gitVersion,
  keepResult,
  laneDiff,
  liveChangedCount,
  prepareEmpty,
  prepareWorktree,
  removeWorkspace,
  snapshot,
} from './workspace.js';

const FINISH_TIMEOUT = 15 * 60_000;
const MAX_LANES = 8;
const SNAPSHOT_FEED = 300;

type StopReason = 'stopped' | 'timed_out' | 'over_budget';

/** Things about a race that are not part of the public Race object. */
interface Internal {
  repoRoot: string | null;
  resultRefs: Record<string, string>;
}

interface LaneRuntime {
  lane: Lane;
  adapter: AgentAdapter | null;
  ctx: StartContext | null;
  child: ChildProcess | null;
  parser: EventParser | null;
  tracker: MetricsTracker | null;
  feed: FeedItem[];
  feedLoaded: boolean;
  /** Feed items addressable by the id the CLI gave them (tools, streamed text). */
  byId: Map<string, FeedItem>;
  toolStart: Map<string, number>;
  openTools: Set<string>;
  dirty: Set<FeedItem>;
  stopReason: StopReason | null;
  result: { ok: boolean; error?: string; text?: string } | null;
  authError: string | null;
  lastError: string | null;
  stderrTail: string[];
  lastActivity: number;
  sessionId: string | null;
  extra: Pick<LaneMetrics, 'filesChangedLive' | 'code' | 'outcome'>;
  timeLimit: NodeJS.Timeout | null;
  polling: boolean;
  feedSavedAt: number;
}

interface RaceRuntime {
  race: Race;
  internal: Internal;
  lanes: Map<string, LaneRuntime>;
  ticker: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null;
}

function describeTool(kind: ToolKind, name: string, target: string | null, pending: boolean): NowStatus {
  const short = (s: string, n = 70) => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
  };
  const t = target ? short(target) : null;
  switch (kind) {
    case 'read':
      return { kind: 'reading', text: t ? `Reading ${t}` : 'Reading a file' };
    case 'edit':
      return { kind: 'editing', text: t ? `Editing ${t}` : pending ? 'Writing a file' : 'Editing files' };
    case 'command':
      return { kind: 'running', text: t ? `Running ${t}` : 'Preparing a command' };
    case 'search':
      return { kind: 'searching', text: t ? `Searching ${t}` : 'Searching the project' };
    case 'web':
      return { kind: 'browsing', text: t ? `Looking up ${t}` : 'Looking something up' };
    case 'plan':
      return { kind: 'planning', text: t ? `Updating its plan (${t})` : 'Updating its plan' };
    case 'agent':
      return { kind: 'delegating', text: t ? `Delegating: ${t}` : 'Delegating to a sub-agent' };
    default:
      return { kind: 'tool', text: `Using ${name}${t ? `: ${t}` : ''}` };
  }
}

function newRuntimeLane(lane: Lane): LaneRuntime {
  return {
    lane,
    adapter: null,
    ctx: null,
    child: null,
    parser: null,
    tracker: null,
    feed: [],
    feedLoaded: false,
    byId: new Map(),
    toolStart: new Map(),
    openTools: new Set(),
    dirty: new Set(),
    stopReason: null,
    result: null,
    authError: null,
    lastError: null,
    stderrTail: [],
    lastActivity: Date.now(),
    sessionId: null,
    extra: { filesChangedLive: lane.metrics.filesChangedLive, code: lane.metrics.code, outcome: { ...lane.metrics.outcome } },
    timeLimit: null,
    polling: false,
    feedSavedAt: 0,
  };
}

/**
 * The race engine: prepares isolated workspaces, starts every agent at the same
 * moment, turns their output into feed items and metrics, and decides how each
 * lane ended. Lanes share nothing, so a crash or hang in one cannot stall another.
 *
 * Emits 'message' with a ServerMessage for every change; the WebSocket hub and
 * the terminal UI both listen to that.
 */
export class RaceEngine extends EventEmitter {
  private races = new Map<string, RaceRuntime>();
  readonly previews: PreviewManager;
  private prices = loadPrices();
  private flushTimer: NodeJS.Timeout;

  constructor(private sandbox: SandboxStatus) {
    super();
    this.setMaxListeners(100);
    this.previews = new PreviewManager(sandbox, (key, info, build) => this.onPreview(key, info, build));
    this.flushTimer = setInterval(() => this.flushFeeds(), 90);
    this.flushTimer.unref();
  }

  private send(msg: ServerMessage): void {
    this.emit('message', msg);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private feedFile(raceId: string, laneId: string): string {
    return path.join(raceDir(raceId), `feed-${laneId}.json`);
  }

  private save(rt: RaceRuntime, now = false): void {
    const write = () => {
      rt.saveTimer = null;
      try {
        writeJsonAtomic(path.join(raceDir(rt.race.id), 'race.json'), rt.race);
        writeJsonAtomic(path.join(raceDir(rt.race.id), 'internal.json'), rt.internal);
      } catch {
        /* disk problems must not take the race down */
      }
    };
    if (now) {
      if (rt.saveTimer) clearTimeout(rt.saveTimer);
      write();
    } else if (!rt.saveTimer) rt.saveTimer = setTimeout(write, 400);
  }

  private saveFeed(rt: RaceRuntime, lr: LaneRuntime): void {
    try {
      writeJsonAtomic(this.feedFile(rt.race.id, lr.lane.id), lr.feed);
      lr.feedSavedAt = Date.now();
    } catch {
      /* best effort */
    }
  }

  /** Load a past race from disk so it can be reopened. */
  private load(id: string): RaceRuntime | null {
    if (!/^[\w-]+$/.test(id)) return null;
    const file = path.join(raceDir(id), 'race.json');
    if (!fs.existsSync(file)) return null;
    const race = readJson<Race | null>(file, null);
    if (!race || !Array.isArray(race.lanes)) return null;
    const internal = readJson<Internal>(path.join(raceDir(id), 'internal.json'), { repoRoot: null, resultRefs: {} });
    const rt: RaceRuntime = { race, internal, lanes: new Map(), ticker: null, saveTimer: null };
    for (const lane of race.lanes) rt.lanes.set(lane.id, newRuntimeLane(lane));
    this.races.set(id, rt);
    return rt;
  }

  private runtime(id: string): RaceRuntime | null {
    return this.races.get(id) ?? this.load(id);
  }

  private need(id: string): RaceRuntime {
    const rt = this.runtime(id);
    if (!rt) throw new Error('Race not found');
    return rt;
  }

  private needLane(raceId: string, laneId: string): { rt: RaceRuntime; lr: LaneRuntime } {
    const rt = this.need(raceId);
    const lr = rt.lanes.get(laneId);
    if (!lr) throw new Error('Lane not found');
    return { rt, lr };
  }

  /**
   * At start-up: races that were still running when the previous server died
   * are marked interrupted, and previews that can no longer be alive are reset.
   */
  recoverInterrupted(): number {
    let fixed = 0;
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(racesDir());
    } catch {
      return 0;
    }
    for (const id of ids) {
      const file = path.join(raceDir(id), 'race.json');
      const race = readJson<Race | null>(file, null);
      if (!race) continue;
      let changed = false;
      if (race.state === 'running' || race.state === 'preparing') {
        race.state = 'interrupted';
        race.endedAt ??= Date.now();
        changed = true;
        fixed++;
      }
      for (const lane of race.lanes ?? []) {
        if (!isTerminal(lane.state)) {
          lane.state = 'stopped';
          lane.stateReason = 'Agent Derby was closed or killed while this lane was running';
          lane.endedAt ??= Date.now();
          lane.now = { kind: 'done', text: 'Interrupted' };
          changed = true;
        }
        if (['installing', 'building', 'starting', 'ready'].includes(lane.preview?.status)) {
          lane.preview = { ...lane.preview, status: 'stopped', url: null, port: null };
          changed = true;
        }
      }
      if (changed) writeJsonAtomic(file, race);
    }
    return fixed;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get(id: string): Race | null {
    return this.runtime(id)?.race ?? null;
  }

  list(): RaceSummary[] {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(racesDir());
    } catch {
      return [];
    }
    const out: RaceSummary[] = [];
    for (const id of ids) {
      const race = this.races.get(id)?.race ?? readJson<Race | null>(path.join(raceDir(id), 'race.json'), null);
      if (!race?.lanes) continue;
      const done = race.lanes.every((l) => isTerminal(l.state));
      const first = rankLanes(race.lanes)[0];
      out.push({
        id: race.id,
        createdAt: race.createdAt,
        state: race.state,
        task: race.setup.task,
        source: race.setup.source,
        lanes: race.lanes.map((l) => ({ id: l.id, agentName: l.agentName, color: l.color, state: l.state, wallMs: l.metrics.time.wallMs, model: l.metrics.model })),
        winner: done && first?.state === 'finished' ? first.agentName : null,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  private loadFeed(rt: RaceRuntime, lr: LaneRuntime): FeedItem[] {
    if (!lr.feedLoaded && !lr.child && lr.feed.length === 0) {
      lr.feed = readJson<FeedItem[]>(this.feedFile(rt.race.id, lr.lane.id), []);
    }
    lr.feedLoaded = true;
    return lr.feed;
  }

  feed(raceId: string, laneId: string): FeedItem[] {
    const { rt, lr } = this.needLane(raceId, laneId);
    return this.loadFeed(rt, lr);
  }

  /** What a newly connected viewer needs: the race, then the tail of each feed. */
  snapshotMessages(raceId: string): ServerMessage[] {
    const rt = this.runtime(raceId);
    if (!rt) return [];
    const out: ServerMessage[] = [{ type: 'race', race: rt.race }];
    for (const lr of rt.lanes.values()) {
      const items = this.loadFeed(rt, lr).slice(-SNAPSHOT_FEED);
      if (items.length) out.push({ type: 'feed', raceId, laneId: lr.lane.id, items });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Creating and starting
  // -------------------------------------------------------------------------

  async create(setup: RaceSetup): Promise<Race> {
    const task = (setup.task ?? '').trim();
    if (!task) throw new Error('Describe the task first');
    if (!Array.isArray(setup.entrants) || setup.entrants.length === 0) throw new Error('Pick at least one agent');
    if (setup.entrants.length > MAX_LANES) throw new Error(`At most ${MAX_LANES} lanes per race`);
    if (!(await gitVersion())) throw new Error('git was not found. Agent Derby needs git to isolate workspaces and compute diffs.');

    let repoRoot: string | null = null;
    let baseRef: string | null = null;
    if (setup.source?.type === 'repo') {
      const check = await checkRepo(setup.source.path);
      if (!check.ok) throw new Error(check.error ?? 'Not a usable git repository');
      repoRoot = check.path;
      baseRef = check.head;
    }

    const id = `r${new Date().toISOString().slice(2, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;
    const prompt = buildPrompt(task);
    const cleanSetup: RaceSetup = {
      task,
      entrants: setup.entrants.map((e) => ({ agentId: e.agentId, model: (e.model ?? '').trim(), options: e.options ?? {} })),
      source: repoRoot ? { type: 'repo', path: repoRoot } : { type: 'empty' },
      finishCommand: setup.finishCommand?.trim() || undefined,
      timeLimitSec: setup.timeLimitSec && setup.timeLimitSec > 0 ? setup.timeLimitSec : undefined,
      costLimitUsd: setup.costLimitUsd && setup.costLimitUsd > 0 ? setup.costLimitUsd : undefined,
    };

    const race: Race = {
      id,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      state: 'preparing',
      setup: cleanSetup,
      prompt,
      promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
      baseRef,
      lanes: [],
      error: null,
      appVersion: APP_VERSION,
    };
    const rt: RaceRuntime = { race, internal: { repoRoot, resultRefs: {} }, lanes: new Map(), ticker: null, saveTimer: null };

    const used = new Map<string, number>();
    for (const entrant of cleanSetup.entrants) {
      const adapter = getAdapter(entrant.agentId);
      if (!adapter) throw new Error(`Unknown agent "${entrant.agentId}"`);
      let det = await detectCached(adapter);
      if (!det.installed || !det.path) throw new Error(`${adapter.name} is not installed`);
      if (det.auth === 'missing') {
        // The sign-in may have happened since we last looked (in another terminal, say): check once more.
        invalidateDetection(adapter.id);
        det = await detectCached(adapter);
        if (det.auth === 'missing' || !det.path) {
          throw new Error(`${adapter.name} is not signed in, so it cannot race. Sign in first: use "Sign in" on its card, or run: agent-derby login ${adapter.id}`);
        }
      }
      const n = (used.get(adapter.id) ?? 0) + 1;
      used.set(adapter.id, n);
      const laneId = n === 1 ? adapter.id : `${adapter.id}-${n}`;
      const model = entrant.model ?? '';
      const lane: Lane = {
        id: laneId,
        agentId: adapter.id,
        agentName: model ? `${adapter.name} · ${model}` : adapter.name,
        kind: adapter.kind,
        color: n === 1 ? adapter.color : shiftHue(adapter.color, (n - 1) * 47),
        requestedModel: model,
        state: 'pending',
        stateReason: null,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        now: { kind: 'waiting', text: 'Preparing workspace' },
        metrics: { ...emptyMetrics(), cliVersion: det.version },
        preview: emptyPreview(),
        workspace: path.join(raceDir(id), 'workspaces', laneId),
        branch: repoRoot ? `agent-derby/${id}/${laneId}` : null,
        commandLine: null,
        finalMessage: null,
        kept: null,
        feedCount: 0,
      };
      lane.metrics.outcome.finish = cleanSetup.finishCommand ? 'not_run' : 'not_set';
      const lr = newRuntimeLane(lane);
      lr.feedLoaded = true;
      lr.adapter = adapter;
      lr.ctx = {
        exe: det.path,
        prompt,
        workspace: lane.workspace,
        model,
        options: entrant.options ?? {},
        costLimitUsd: cleanSetup.costLimitUsd,
      };
      race.lanes.push(lane);
      rt.lanes.set(laneId, lr);
    }
    // Same agent twice without a model still needs distinguishable names.
    for (const lane of race.lanes) {
      const twins = race.lanes.filter((l) => l.agentName === lane.agentName);
      if (twins.length > 1) twins.forEach((l, i) => (l.agentName = `${l.agentName} #${i + 1}`));
    }

    ensureDir(raceDir(id));
    this.races.set(id, rt);
    this.save(rt, true);
    void this.run(rt);
    return race;
  }

  private async run(rt: RaceRuntime): Promise<void> {
    const { race } = rt;
    try {
      // Prepare every workspace before anyone starts, so no agent gets a head start.
      const prepared = await Promise.all(
        [...rt.lanes.values()].map((lr) =>
          rt.internal.repoRoot
            ? prepareWorktree(rt.internal.repoRoot, lr.lane.workspace, lr.lane.branch!, race.baseRef!)
            : prepareEmpty(lr.lane.workspace),
        ),
      );
      if (!race.baseRef) race.baseRef = prepared[0]?.baseRef ?? null;
      // Empty projects each have their own repository, so each has its own starting commit.
      if (!rt.internal.repoRoot) prepared.forEach((p, i) => (rt.internal.resultRefs[`base:${race.lanes[i]!.id}`] = p.baseRef));
    } catch (e) {
      race.state = 'finished';
      race.error = `Could not prepare the workspaces: ${(e as Error).message}`;
      race.endedAt = Date.now();
      for (const lr of rt.lanes.values()) {
        lr.lane.state = 'failed';
        lr.lane.stateReason = 'The race could not be prepared';
        lr.lane.now = { kind: 'done', text: 'Not started' };
      }
      this.save(rt, true);
      this.send({ type: 'race', race });
      return;
    }

    race.state = 'running';
    race.startedAt = Date.now();
    // One synchronous loop: every child process is created in the same tick.
    for (const lr of rt.lanes.values()) this.spawnLane(rt, lr);
    this.send({ type: 'race', race });
    this.save(rt, true);
    rt.ticker = setInterval(() => this.tick(rt), 500);
  }

  private baseRef(rt: RaceRuntime, laneId: string): string {
    return rt.internal.resultRefs[`base:${laneId}`] ?? rt.race.baseRef ?? 'HEAD';
  }

  private spawnLane(rt: RaceRuntime, lr: LaneRuntime): void {
    const { lane } = lr;
    const adapter = lr.adapter!;
    const ctx = lr.ctx!;
    lr.tracker = new MetricsTracker(this.prices, lane.requestedModel);
    lane.startedAt = Date.now();
    lr.lastActivity = lane.startedAt;
    lane.state = 'running';
    lane.now = { kind: 'starting', text: `Starting ${adapter.name}` };

    let spec;
    try {
      spec = adapter.start(ctx);
      lr.parser = adapter.createParser(ctx);
    } catch (e) {
      this.finishLane(rt, lr, 'failed', `Could not build the command line: ${(e as Error).message}`);
      return;
    }
    const sandboxed = !adapter.ownSandbox && this.sandbox.kind !== 'none';
    const wrapped = sandboxed
      ? wrap(this.sandbox, spec.command, spec.args, { workspace: lane.workspace, writable: adapter.writablePaths?.() ?? [] })
      : { command: spec.command, args: spec.args };
    lane.commandLine = [path.basename(spec.command), ...spec.args.map((a) => (a === ctx.prompt ? '<prompt>' : /\s/.test(a) ? JSON.stringify(a) : a))].join(' ');

    this.pushFeed(lr, {
      type: 'system',
      text: adapter.ownSandbox
        ? `Workspace ready. Confinement: ${adapter.name}'s own sandbox.`
        : sandboxed
          ? `Workspace ready. Confinement: ${this.sandbox.label}.`
          : `Workspace ready. No OS sandbox (${this.sandbox.reason}); the agent is separated by workspace only.`,
    });

    let child: ChildProcess;
    try {
      child = spawnGroup(wrapped.command, wrapped.args, {
        cwd: lane.workspace,
        env: childEnv(spec.env ?? {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.finishLane(rt, lr, 'failed', `Could not start ${adapter.name}: ${(e as Error).message}`);
      return;
    }
    lr.child = child;
    trackProcess(child.pid, `agent ${rt.race.id}/${lane.id}`);

    child.stdin?.on('error', () => {});
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    else child.stdin?.end();

    const reader = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          this.onLine(rt, lr, line, stream);
        }
        // A runaway line without a newline must not grow without bound.
        if (buffer.length > 8_000_000) {
          this.onLine(rt, lr, buffer.slice(0, 2000), stream);
          buffer = '';
        }
      };
    };
    child.stdout?.on('data', reader('stdout'));
    child.stderr?.on('data', reader('stderr'));

    let exited = false;
    const onExit = (code: number | null, error?: Error) => {
      if (exited) return;
      exited = true;
      untrackProcess(child.pid);
      void this.onAgentExit(rt, lr, code, error).catch((e) => {
        // Whatever went wrong while wrapping up, the lane must still reach an end state.
        if (!isTerminal(lr.lane.state)) this.finishLane(rt, lr, 'failed', `Internal error while finishing the lane: ${(e as Error).message}`);
      });
    };
    child.on('error', (e) => onExit(null, e));
    child.on('close', (code) => onExit(code));

    if (rt.race.setup.timeLimitSec) {
      lr.timeLimit = setTimeout(() => this.stopLaneInternal(rt, lr, 'timed_out'), rt.race.setup.timeLimitSec * 1000);
    }
  }

  // -------------------------------------------------------------------------
  // Output -> events -> feed and metrics
  // -------------------------------------------------------------------------

  private onLine(rt: RaceRuntime, lr: LaneRuntime, line: string, stream: 'stdout' | 'stderr'): void {
    if (!lr.parser) return;
    lr.lastActivity = Date.now();
    if (stream === 'stderr' && line.trim()) {
      lr.stderrTail.push(line.trim().slice(0, 300));
      if (lr.stderrTail.length > 5) lr.stderrTail.shift();
    }
    let events: AgentEvent[];
    try {
      events = lr.parser.parse(line, stream);
    } catch {
      events = [{ type: 'raw', text: line.slice(0, 2000) }];
    }
    for (const ev of events) this.onEvent(rt, lr, ev);
  }

  private elapsed(lr: LaneRuntime): number {
    return Date.now() - (lr.lane.startedAt ?? Date.now());
  }

  private pushFeed(lr: LaneRuntime, item: Omit<FeedItem, 'seq' | 't'>, id?: string): FeedItem {
    const full: FeedItem = { seq: lr.feed.length, t: this.elapsed(lr), ...item };
    lr.feed.push(full);
    lr.lane.feedCount = lr.feed.length;
    if (id) lr.byId.set(id, full);
    lr.dirty.add(full);
    return full;
  }

  private setNow(lr: LaneRuntime, now: NowStatus): void {
    lr.lane.now = now;
  }

  private onEvent(rt: RaceRuntime, lr: LaneRuntime, ev: AgentEvent): void {
    const t = this.elapsed(lr);
    lr.tracker?.onEvent(ev, t);
    switch (ev.type) {
      case 'init':
        if (ev.sessionId) lr.sessionId = ev.sessionId;
        if (ev.model && !lr.byId.has(`init:${ev.model}`)) {
          this.pushFeed(lr, { type: 'system', text: `Model: ${ev.model}` }, `init:${ev.model}`);
        }
        break;
      case 'thinking_active': {
        if (typeof ev.tokens === 'number' && ev.tokens > 0) {
          // No reasoning text to show, but the CLI says how far along the think is: make that visible.
          const amount = ev.tokens >= 1000 ? `${(ev.tokens / 1000).toFixed(1)}k` : String(ev.tokens);
          const key = `thinkmeter:${ev.id ?? 'current'}`;
          const text = `Thinking: about ${amount} tokens so far. The CLI does not show this model's reasoning text.`;
          const existing = lr.byId.get(key);
          if (existing) {
            existing.text = text;
            existing.streaming = true;
            lr.dirty.add(existing);
          } else if (!lr.byId.has(`thinking:${ev.id}`)) {
            this.pushFeed(lr, { type: 'thinking', text, streaming: true }, key);
          }
          if (lr.openTools.size === 0) this.setNow(lr, { kind: 'thinking', text: `Thinking (about ${amount} tokens so far)` });
        } else if (lr.openTools.size === 0 && lr.lane.now.kind !== 'thinking') {
          this.setNow(lr, { kind: 'thinking', text: 'Thinking' });
        }
        break;
      }
      case 'thinking':
      case 'message': {
        const type = ev.type;
        const key = ev.id ? `${type}:${ev.id}` : null;
        const existing = key ? lr.byId.get(key) : undefined;
        if (existing && ev.delta) {
          existing.text += ev.text;
          existing.streaming = true;
          lr.dirty.add(existing);
        } else if (existing) {
          existing.text = ev.text;
          lr.dirty.add(existing);
        } else {
          this.pushFeed(lr, { type, text: ev.text, ...(ev.delta ? { streaming: true } : {}) }, key ?? undefined);
        }
        if (type === 'message') lr.lane.finalMessage = (existing ?? lr.feed[lr.feed.length - 1]!).text;
        if (lr.openTools.size === 0) this.setNow(lr, type === 'thinking' ? { kind: 'thinking', text: 'Thinking' } : { kind: 'writing', text: 'Writing a reply' });
        break;
      }
      case 'tool_start': {
        const key = `tool:${ev.id}`;
        let item = lr.byId.get(key);
        if (!item) {
          item = this.pushFeed(
            lr,
            { type: 'tool', text: '', tool: { kind: ev.kind, name: ev.name, target: ev.target, status: 'running', durationMs: null, exitCode: null, output: null } },
            key,
          );
        } else if (item.tool) {
          item.tool.target = ev.target ?? item.tool.target;
          lr.dirty.add(item);
        }
        if (!ev.pending && !lr.toolStart.has(ev.id)) lr.toolStart.set(ev.id, t);
        lr.openTools.add(ev.id);
        this.closeStreaming(lr);
        this.setNow(lr, describeTool(ev.kind, ev.name, item.tool?.target ?? ev.target, Boolean(ev.pending)));
        break;
      }
      case 'tool_end': {
        const item = lr.byId.get(`tool:${ev.id}`);
        lr.openTools.delete(ev.id);
        if (item?.tool) {
          const started = lr.toolStart.get(ev.id);
          item.tool.status = ev.ok ? 'ok' : 'failed';
          item.tool.durationMs = started === undefined ? null : Math.max(0, t - started);
          item.tool.exitCode = ev.exitCode ?? null;
          item.tool.output = ev.output ? ev.output : null;
          lr.dirty.add(item);
        }
        if (lr.openTools.size === 0) this.setNow(lr, { kind: 'thinking', text: 'Thinking' });
        break;
      }
      case 'error':
        this.pushFeed(lr, { type: 'error', text: ev.message });
        lr.lastError = ev.message;
        if (ev.kind === 'auth' && !lr.authError) {
          lr.authError = ev.message;
          // Some CLIs retry for a long time when not signed in. There is nothing to wait for.
          const pid = lr.child?.pid;
          if (pid && lr.lane.state === 'running') setTimeout(() => lr.child?.pid === pid && void stopTree(pid, 500), 1500);
        }
        break;
      case 'result':
        lr.result = { ok: ev.ok, error: ev.error, text: ev.text };
        if (ev.text) lr.lane.finalMessage = ev.text;
        break;
      case 'system':
        this.pushFeed(lr, { type: 'system', text: ev.text });
        break;
      case 'raw':
        this.pushFeed(lr, { type: 'raw', text: ev.text.slice(0, 2000) });
        break;
    }
  }

  private closeStreaming(lr: LaneRuntime): void {
    for (let i = lr.feed.length - 1; i >= 0 && i >= lr.feed.length - 6; i--) {
      const item = lr.feed[i]!;
      if (item.streaming) {
        item.streaming = false;
        lr.dirty.add(item);
      }
    }
  }

  private flushFeeds(): void {
    for (const rt of this.races.values()) {
      for (const lr of rt.lanes.values()) {
        if (lr.dirty.size === 0) continue;
        const items = [...lr.dirty].sort((a, b) => a.seq - b.seq);
        lr.dirty.clear();
        this.send({ type: 'feed', raceId: rt.race.id, laneId: lr.lane.id, items });
      }
    }
  }

  private metrics(lr: LaneRuntime): LaneMetrics {
    if (!lr.tracker) return lr.lane.metrics;
    const m = lr.tracker.snapshot(this.elapsed(lr), lr.extra);
    m.cliVersion ??= lr.lane.metrics.cliVersion;
    return m;
  }

  private pushLane(rt: RaceRuntime, lr: LaneRuntime, keys: (keyof Lane)[] = ['state', 'stateReason', 'now', 'metrics', 'feedCount']): void {
    lr.lane.metrics = this.metrics(lr);
    const patch: Partial<Lane> = {};
    for (const k of keys) (patch as Record<string, unknown>)[k] = lr.lane[k];
    this.send({ type: 'lane', raceId: rt.race.id, laneId: lr.lane.id, patch });
  }

  /** Twice a second per race: push live numbers, enforce the cost limit, notice silence. */
  private tick(rt: RaceRuntime): void {
    let active = false;
    for (const lr of rt.lanes.values()) {
      if (lr.lane.state !== 'running') continue;
      active = true;
      const idle = Date.now() - lr.lastActivity;
      if (idle > 45_000 && lr.openTools.size === 0) {
        this.setNow(lr, { kind: 'waiting', text: `No output for ${Math.round(idle / 1000)}s` });
      }
      const limit = rt.race.setup.costLimitUsd;
      const cost = lr.tracker?.costNow() ?? null;
      if (limit && cost !== null && cost > limit && !lr.stopReason) this.stopLaneInternal(rt, lr, 'over_budget');
      this.pushLane(rt, lr, ['now', 'metrics', 'feedCount']);
      if (!lr.polling) {
        lr.polling = true;
        void liveChangedCount(lr.lane.workspace, this.baseRef(rt, lr.lane.id))
          .then((n) => (lr.extra.filesChangedLive = n))
          .catch(() => {})
          .finally(() => setTimeout(() => (lr.polling = false), 2000));
      }
      if (Date.now() - lr.feedSavedAt > 5000) this.saveFeed(rt, lr);
    }
    if (!active && rt.ticker && [...rt.lanes.values()].every((l) => l.lane.state !== 'verifying' && l.lane.state !== 'pending')) {
      clearInterval(rt.ticker);
      rt.ticker = null;
    }
    this.save(rt);
  }

  // -------------------------------------------------------------------------
  // Stopping and finishing
  // -------------------------------------------------------------------------

  private stopLaneInternal(rt: RaceRuntime, lr: LaneRuntime, reason: StopReason): void {
    if (lr.stopReason || isTerminal(lr.lane.state)) return;
    lr.stopReason = reason;
    const pid = lr.child?.pid;
    // The clock stops when the stop is decided, not when a stubborn process finally dies.
    if (lr.lane.state === 'running') lr.tracker?.end(this.elapsed(lr));
    if (lr.lane.state === 'running' && pid) {
      this.setNow(lr, { kind: 'waiting', text: 'Stopping' });
      this.pushLane(rt, lr, ['now']);
      if (lr.adapter?.stop) lr.adapter.stop(pid);
      void stopTree(pid, reason === 'stopped' ? 3000 : 1500);
    } else if (lr.lane.state === 'verifying' && pid) {
      killTree(pid, 'SIGKILL');
    } else if (lr.lane.state === 'pending') {
      this.finishLane(rt, lr, 'stopped', 'Stopped before it started');
    }
  }

  stopLane(raceId: string, laneId: string): void {
    const { rt, lr } = this.needLane(raceId, laneId);
    this.stopLaneInternal(rt, lr, 'stopped');
  }

  stopRace(raceId: string): void {
    const rt = this.need(raceId);
    for (const lr of rt.lanes.values()) this.stopLaneInternal(rt, lr, 'stopped');
  }

  private async onAgentExit(rt: RaceRuntime, lr: LaneRuntime, code: number | null, error?: Error): Promise<void> {
    const { lane } = lr;
    const t = this.elapsed(lr);
    if (lr.timeLimit) clearTimeout(lr.timeLimit);
    lr.tracker?.end(t);
    lr.child = null;
    lane.endedAt = Date.now();
    lane.exitCode = code;
    this.closeStreaming(lr);
    for (const id of lr.openTools) {
      const item = lr.byId.get(`tool:${id}`);
      if (item?.tool && item.tool.status === 'running') {
        item.tool.status = 'failed';
        item.tool.output = 'Interrupted: the agent exited before this finished';
        lr.dirty.add(item);
      }
    }
    lr.openTools.clear();

    // Record what is on disk, whatever happened, so partial work can still be inspected.
    const base = this.baseRef(rt, lane.id);
    try {
      const ref = await snapshot(lane.workspace);
      rt.internal.resultRefs[lane.id] = ref;
      lr.extra.code = await codeStats(lane.workspace, base, ref);
      lr.extra.filesChangedLive = lr.extra.code.filesCreated + lr.extra.code.filesModified + lr.extra.code.filesDeleted;
    } catch (e) {
      this.pushFeed(lr, { type: 'error', text: `Could not record the result: ${(e as Error).message}` });
    }

    if (lr.adapter?.readUsage && lr.ctx) {
      try {
        const report = await lr.adapter.readUsage({ ...lr.ctx, sessionId: lr.sessionId });
        if (report?.usage) lr.tracker?.onEvent({ type: 'usage', mode: 'total', usage: report.usage }, t);
        if (typeof report?.costUsd === 'number') lr.tracker?.onEvent({ type: 'cost', usd: report.costUsd }, t);
        if (report?.model) lr.tracker?.onEvent({ type: 'init', model: report.model }, t);
      } catch {
        /* usage stays "not reported" */
      }
    }

    // How did the agent itself end?
    if (lr.stopReason === 'stopped') return this.finishLane(rt, lr, 'stopped', 'Stopped by you');
    if (lr.stopReason === 'timed_out') {
      return this.finishLane(rt, lr, 'timed_out', `Still running after the ${formatLimit(rt.race.setup.timeLimitSec ?? 0)} time limit`);
    }
    if (lr.stopReason === 'over_budget' || lr.result?.error === 'Cost limit reached') {
      return this.finishLane(rt, lr, 'over_budget', `Went over the $${rt.race.setup.costLimitUsd} cost limit`);
    }
    if (error) return this.finishLane(rt, lr, 'failed', `Could not start ${lr.adapter?.name ?? 'the agent'}: ${error.message}`);
    if (lr.authError) {
      return this.finishLane(rt, lr, 'failed', `Not signed in. Use "Sign in" for ${lr.adapter?.name ?? 'this agent'} on the setup screen, then race again.`);
    }
    if (code !== 0 || lr.result?.ok === false) {
      const detail = lr.result?.error ?? lr.lastError ?? lr.stderrTail[lr.stderrTail.length - 1] ?? null;
      const quick = t < 3000 && lr.feed.filter((f) => f.type !== 'system').length <= 1 ? ' almost immediately' : '';
      const how = code === null ? 'was killed' : code !== 0 ? `exited${quick} with code ${code}` : 'reported a failure';
      return this.finishLane(rt, lr, 'failed', `The agent ${how}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const changed = lr.extra.code ? lr.extra.code.filesCreated + lr.extra.code.filesModified + lr.extra.code.filesDeleted : 0;
    if (changed === 0) return this.finishLane(rt, lr, 'failed', 'The agent exited cleanly but did not change any files');

    // The agent is done. Optional finish command decides success.
    const finish = rt.race.setup.finishCommand;
    if (finish) {
      lane.state = 'verifying';
      this.setNow(lr, { kind: 'verifying', text: `Checking: ${finish}` });
      this.pushLane(rt, lr);
      const outcome = await this.runFinishCommand(rt, lr, finish);
      if (lr.stopReason) return this.finishLane(rt, lr, 'stopped', 'Stopped by you during the finish command');
      lr.extra.outcome.finish = outcome.code === 0 ? 'passed' : 'failed';
      lr.extra.outcome.finishExitCode = outcome.code;
      lr.extra.outcome.tests = parseTestCounts(outcome.output);
      if (outcome.code !== 0) {
        this.finishLane(rt, lr, 'failed', outcome.timedOut ? 'The finish command timed out' : `The finish command failed (exit code ${outcome.code})`, true);
        return;
      }
    }
    this.finishLane(rt, lr, 'finished', null, true);
  }

  private runFinishCommand(rt: RaceRuntime, lr: LaneRuntime, commandLine: string): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const item = this.pushFeed(lr, {
        type: 'tool',
        text: 'Finish command',
        tool: { kind: 'command', name: 'finish command', target: commandLine, status: 'running', durationMs: null, exitCode: null, output: null },
      });
      const w = wrapShell(this.sandbox, commandLine, { workspace: lr.lane.workspace });
      const opts = { cwd: lr.lane.workspace, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], env: childEnv({ CI: '1', FORCE_COLOR: '0' }) };
      const child = isWindows ? spawnShell(commandLine, opts) : spawnGroup(w.command, w.args, opts);
      lr.child = child;
      trackProcess(child.pid, `finish ${rt.race.id}/${lr.lane.id}`);
      let output = '';
      let timedOut = false;
      const add = (b: Buffer) => {
        output += b.toString();
        if (output.length > 2_000_000) output = output.slice(-1_500_000);
      };
      child.stdout?.on('data', add);
      child.stderr?.on('data', add);
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid, 'SIGKILL');
      }, FINISH_TIMEOUT);
      let settled = false;
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        untrackProcess(child.pid);
        lr.child = null;
        if (item.tool) {
          item.tool.status = code === 0 ? 'ok' : 'failed';
          item.tool.exitCode = code;
          item.tool.durationMs = Date.now() - started;
          item.tool.output = output.slice(-6000) || null;
          lr.dirty.add(item);
        }
        resolve({ code, output, timedOut });
      };
      child.on('error', (e) => {
        output += `\n${e.message}`;
        done(127);
      });
      child.on('close', done);
    });
  }

  private finishLane(rt: RaceRuntime, lr: LaneRuntime, state: LaneState, reason: string | null, preview = false): void {
    const { lane } = lr;
    if (isTerminal(lane.state)) return;
    if (lr.timeLimit) clearTimeout(lr.timeLimit);
    lr.tracker?.end(this.elapsed(lr));
    lane.state = state;
    lane.stateReason = reason;
    lane.endedAt ??= Date.now();
    const words: Record<string, string> = { finished: 'Finished', failed: 'Failed', stopped: 'Stopped', timed_out: 'Timed out', over_budget: 'Over budget' };
    lane.now = { kind: 'done', text: words[state] ?? 'Done' };
    this.pushFeed(lr, { type: state === 'finished' ? 'system' : 'error', text: reason ? `${words[state]}: ${reason}` : `${words[state]}` });
    if (preview) lr.extra.outcome.preview = 'pending';
    this.pushLane(rt, lr, ['state', 'stateReason', 'now', 'metrics', 'endedAt', 'exitCode', 'finalMessage', 'commandLine', 'feedCount', 'startedAt']);
    this.saveFeed(rt, lr);

    if ([...rt.lanes.values()].every((l) => isTerminal(l.lane.state)) && rt.race.state !== 'finished') {
      rt.race.state = 'finished';
      rt.race.endedAt = Date.now();
      this.send({ type: 'race_patch', raceId: rt.race.id, patch: { state: rt.race.state, endedAt: rt.race.endedAt } });
    }
    this.save(rt, true);

    // The feature that matters most: run what the agent built, with no action from the user.
    if (preview) void this.previews.start(rt.race.id, lane.id, lane.workspace).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Previews
  // -------------------------------------------------------------------------

  private onPreview(key: string, info: PreviewInfo, build?: BuildOutcome): void {
    const [raceId, laneId] = key.split('/') as [string, string];
    const rt = this.races.get(raceId);
    const lr = rt?.lanes.get(laneId);
    if (!rt || !lr) return;
    lr.lane.preview = info;
    const o = lr.extra.outcome;
    if (build) o.build = build;
    if (info.status === 'ready') o.preview = 'started';
    else if (info.status === 'failed') o.preview = 'failed';
    else if (info.status === 'installing' || info.status === 'building' || info.status === 'starting') o.preview = 'pending';
    // A preview the user stopped after it had started still counts as having started.
    lr.lane.metrics = { ...lr.lane.metrics, outcome: { ...o } };
    this.send({ type: 'lane', raceId, laneId, patch: { preview: info, metrics: lr.tracker ? this.metrics(lr) : lr.lane.metrics } });
    this.save(rt);
  }

  async startPreview(raceId: string, laneId: string, manual?: ManualPreviewRequest): Promise<void> {
    const { lr } = this.needLane(raceId, laneId);
    if (!isTerminal(lr.lane.state)) throw new Error('The agent is still working');
    if (!fs.existsSync(lr.lane.workspace)) throw new Error('The workspace no longer exists');
    void this.previews.start(raceId, laneId, lr.lane.workspace, manual).catch(() => {});
  }

  async stopPreview(raceId: string, laneId: string): Promise<void> {
    await this.previews.stop(PreviewManager.key(raceId, laneId));
  }

  previewLogs(raceId: string, laneId: string): string {
    return this.previews.logs(PreviewManager.key(raceId, laneId));
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  async diff(raceId: string, laneId: string): Promise<LaneDiff> {
    const { rt, lr } = this.needLane(raceId, laneId);
    if (!fs.existsSync(lr.lane.workspace)) return { files: [], truncated: false };
    return laneDiff(lr.lane.workspace, this.baseRef(rt, laneId), rt.internal.resultRefs[laneId] ?? null);
  }

  async keep(raceId: string, laneId: string, req: KeepRequest): Promise<string> {
    const { rt, lr } = this.needLane(raceId, laneId);
    const ref = rt.internal.resultRefs[laneId];
    if (!ref) throw new Error('This lane has no recorded result yet');
    const detail = await keepResult(lr.lane.workspace, ref, rt.internal.repoRoot, req);
    lr.lane.kept = { mode: req.mode, target: req.target.trim(), at: Date.now() };
    this.send({ type: 'lane', raceId, laneId, patch: { kept: lr.lane.kept } });
    this.save(rt, true);
    return detail;
  }

  /** Leaving a race: stop its previews and free their ports. The race itself keeps running. */
  async closeRace(raceId: string): Promise<void> {
    await this.previews.stopRace(raceId);
  }

  async deleteRace(raceId: string): Promise<void> {
    const rt = this.need(raceId);
    this.stopRace(raceId);
    await this.previews.stopRace(raceId);
    for (const lr of rt.lanes.values()) if (lr.child?.pid) killTree(lr.child.pid, 'SIGKILL');
    if (rt.ticker) clearInterval(rt.ticker);
    if (rt.saveTimer) clearTimeout(rt.saveTimer);
    for (const lr of rt.lanes.values()) {
      await removeWorkspace(lr.lane.workspace, rt.internal.repoRoot, lr.lane.branch).catch(() => {});
    }
    this.previews.forget(raceId);
    this.races.delete(raceId);
    fs.rmSync(raceDir(raceId), { recursive: true, force: true });
  }

  exportRace(raceId: string): unknown {
    const rt = this.need(raceId);
    return {
      exportedBy: `agent-derby ${APP_VERSION}`,
      race: rt.race,
      feeds: Object.fromEntries([...rt.lanes.values()].map((lr) => [lr.lane.id, this.loadFeed(rt, lr)])),
    };
  }

  /** Races held in memory, for housekeeping. */
  liveRaces(): { id: string; running: boolean; hasPreviews: boolean }[] {
    return [...this.races.values()].map((rt) => ({
      id: rt.race.id,
      running: rt.race.lanes.some((l) => !isTerminal(l.state)),
      hasPreviews: rt.race.lanes.some((l) => ['installing', 'building', 'starting', 'ready'].includes(l.preview.status)),
    }));
  }

  /** True while any agent or finish command is running. */
  busy(): boolean {
    for (const rt of this.races.values()) for (const lr of rt.lanes.values()) if (!isTerminal(lr.lane.state)) return true;
    return false;
  }

  /**
   * The app is going away. Synchronous on purpose (it runs from exit handlers):
   * mark what was running, write it down, and kill every child process.
   */
  shutdownNow(): void {
    clearInterval(this.flushTimer);
    for (const rt of this.races.values()) {
      let touched = false;
      for (const lr of rt.lanes.values()) {
        if (lr.child?.pid) killTree(lr.child.pid, 'SIGKILL');
        if (!isTerminal(lr.lane.state)) {
          lr.lane.metrics = this.metrics(lr);
          lr.lane.state = 'stopped';
          lr.lane.stateReason = 'Agent Derby was shut down while this lane was running';
          lr.lane.endedAt = Date.now();
          lr.lane.now = { kind: 'done', text: 'Interrupted' };
          this.saveFeed(rt, lr);
          touched = true;
        }
        if (['installing', 'building', 'starting', 'ready'].includes(lr.lane.preview.status)) {
          lr.lane.preview = { ...lr.lane.preview, status: 'stopped', url: null, port: null };
          touched = true;
        }
      }
      if (touched || rt.saveTimer) {
        if (rt.race.state === 'running' || rt.race.state === 'preparing') {
          rt.race.state = 'interrupted';
          rt.race.endedAt = Date.now();
        }
        this.save(rt, true);
      }
      if (rt.ticker) clearInterval(rt.ticker);
    }
    this.previews.killAllNow();
  }
}

function formatLimit(sec: number): string {
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}-minute`;
  return `${sec}-second`;
}

/** A related but clearly different colour, for a second lane of the same agent. */
function shiftHue(hex: string, degrees: number): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => parseInt(x, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + degrees + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l - c / 2;
  const [r2, g2, b2] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r2, g2, b2].map((v) => Math.round((v + base) * 255).toString(16).padStart(2, '0')).join('')}`;
}
