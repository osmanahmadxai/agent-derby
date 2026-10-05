/**
 * Pure helpers: formatting, ranking, the comparison table model, feed merging and diff parsing.
 * No React and no DOM in here, so everything can be unit-tested.
 */
import type { FeedItem, Lane, LaneMetrics, LaneState, Maybe, NowStatus, PreviewInfo, Race, ToolKind } from './types';
import { TOOL_KINDS, emptyMetrics, emptyPreview, isTerminal, rankLanes, totalTokens } from './types';

/** The one and only rendering of a null metric. */
export const NOT_REPORTED = 'not reported';

export const ESTIMATE_TOOLTIP =
  'Estimated: computed from the token counts and the price table in config/pricing.json. It is not a measurement from the CLI.';
export const DERIVED_TOOLTIP =
  'Derived from event timings: wall time minus the time spent inside tools. The CLI did not report it.';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Stopwatch style: 0:07.3, 12:03.4, 1:02:03. */
export function fmtClock(ms: number, tenths = true): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalTenths = Math.floor(ms / 100);
  const t = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return tenths ? `${m}:${pad2(s)}.${t}` : `${m}:${pad2(s)}`;
}

/** Prose style: 850ms, 12.3s, 2m 05s, 1h 02m. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  return `${m}m ${pad2(s)}s`;
}

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.round(n).toLocaleString('en-US');
}

/** 950, 12.3k, 1.24M */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 10_000) return `${(n / 1000).toFixed(2)}k`;
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (abs < 10_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtMoney(usd: number): string {
  if (!Number.isFinite(usd)) return String(usd);
  if (usd === 0) return '$0.00';
  const abs = Math.abs(usd);
  if (abs < 0.01) return `$${usd.toFixed(4)}`;
  if (abs < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function shortSha(sha: string | null | undefined, len = 10): string {
  return (sha ?? '').slice(0, len);
}

export function fmtDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '';
  try {
    return new Date(epochMs).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(epochMs).toISOString();
  }
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

/** "a  b c" -> ["a","b","c"] */
export function splitArgs(text: string): string[] {
  return text.split(' ').filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<LaneState, string> = {
  pending: 'pending',
  running: 'running',
  verifying: 'verifying',
  finished: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  timed_out: 'timed out',
  over_budget: 'over budget',
};

export function stateLabel(state: LaneState): string {
  return STATE_LABELS[state] ?? String(state);
}

export function isLive(state: LaneState): boolean {
  return state === 'running' || state === 'verifying';
}

/** Fills every nested object the UI reads, so a partial or older race record can never crash a render. */
export function normalizeMetrics(m: Partial<LaneMetrics> | null | undefined): LaneMetrics {
  const base = emptyMetrics();
  if (!m) return base;
  return {
    ...base,
    ...m,
    time: { ...base.time, ...(m.time ?? {}) },
    tokens: { ...base.tokens, ...(m.tokens ?? {}) },
    cost: { ...base.cost, ...(m.cost ?? {}) },
    activity: {
      ...base.activity,
      ...(m.activity ?? {}),
      byKind: { ...base.activity.byKind, ...(m.activity?.byKind ?? {}) },
    },
    outcome: { ...base.outcome, ...(m.outcome ?? {}) },
    code: m.code ? { ...m.code, newDependencies: m.code.newDependencies ?? [] } : null,
  };
}

export function normalizeLane(l: Lane): Lane {
  const now: NowStatus = l.now && typeof l.now.text === 'string' ? l.now : { kind: 'waiting', text: '' };
  const preview: PreviewInfo = { ...emptyPreview(), ...(l.preview ?? {}) };
  return {
    ...l,
    agentName: l.agentName ?? l.agentId ?? 'agent',
    color: l.color || '#7a86a8',
    requestedModel: l.requestedModel ?? '',
    state: l.state ?? 'pending',
    stateReason: l.stateReason ?? null,
    now,
    preview,
    metrics: normalizeMetrics(l.metrics),
    feedCount: l.feedCount ?? 0,
    kept: l.kept ?? null,
    finalMessage: l.finalMessage ?? null,
    commandLine: l.commandLine ?? null,
  };
}

export function normalizeRace(r: Race): Race {
  return {
    ...r,
    lanes: Array.isArray(r.lanes) ? r.lanes.map(normalizeLane) : [],
    setup: {
      ...(r.setup ?? { task: '', entrants: [], source: { type: 'empty' } }),
      source: r.setup?.source ?? { type: 'empty' },
      entrants: r.setup?.entrants ?? [],
      task: r.setup?.task ?? '',
    },
    prompt: r.prompt ?? '',
    promptSha256: r.promptSha256 ?? '',
  };
}

/** Elapsed ms for a lane: ticks from startedAt while live, otherwise the measured wall time. */
export function laneElapsedMs(lane: Lane, nowMs: number): number {
  if (isLive(lane.state) && lane.startedAt) return Math.max(0, nowMs - lane.startedAt);
  return lane.metrics.time.wallMs;
}

export function laneFilesChanged(lane: Lane): number {
  const c = lane.metrics.code;
  if (c) return c.filesCreated + c.filesModified + c.filesDeleted;
  return lane.metrics.filesChangedLive;
}

export function laneLinesChanged(lane: Lane): Maybe<number> {
  const c = lane.metrics.code;
  return c ? c.linesAdded + c.linesRemoved : null;
}

export function laneModel(lane: Lane): string {
  return lane.metrics.model || lane.requestedModel || 'default model';
}

export function allDone(lanes: Lane[]): boolean {
  return lanes.length > 0 && lanes.every((l) => isTerminal(l.state));
}

export type SortKey = 'time' | 'cost' | 'tokens' | 'lines';

export const SORT_LABELS: Record<SortKey, string> = {
  time: 'Time',
  cost: 'Cost',
  tokens: 'Tokens',
  lines: 'Lines changed',
};

export function sortValue(lane: Lane, key: SortKey): Maybe<number> {
  switch (key) {
    case 'time':
      return lane.metrics.time.wallMs;
    case 'cost':
      return lane.metrics.cost.usd;
    case 'tokens':
      return totalTokens(lane.metrics.tokens);
    case 'lines':
      return laneLinesChanged(lane);
  }
}

/**
 * Successful finishes first, then ascending by the chosen metric.
 * A lane that did not report the metric sorts after those that did; ties fall back to time.
 */
export function sortLanes(lanes: Lane[], key: SortKey): Lane[] {
  if (key === 'time') return rankLanes(lanes);
  const byTime = rankLanes(lanes);
  const order = new Map(byTime.map((l, i) => [l.id, i]));
  return [...lanes].sort((a, b) => {
    const af = a.state === 'finished' ? 0 : 1;
    const bf = b.state === 'finished' ? 0 : 1;
    if (af !== bf) return af - bf;
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    if (av !== null && bv !== null && av !== bv) return av - bv;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

/** Finishing position (1-based) for lanes that finished successfully; others are absent. */
export function finishPositions(lanes: Lane[]): Map<string, number> {
  const out = new Map<string, number>();
  rankLanes(lanes)
    .filter((l) => l.state === 'finished')
    .forEach((l, i) => out.set(l.id, i + 1));
  return out;
}

// ---------------------------------------------------------------------------
// "Best value per row"
// ---------------------------------------------------------------------------

export type Better = 'lower' | 'higher' | null;

/**
 * Indexes holding the best value. Rules:
 *  - null never wins;
 *  - ineligible entries (e.g. lanes that did not finish) never win;
 *  - at least two comparable values are needed, and they must not all be equal,
 *    otherwise nothing is highlighted.
 */
export function bestIndexes(values: Maybe<number>[], better: Better, eligible?: boolean[]): Set<number> {
  const out = new Set<number>();
  if (!better) return out;
  const candidates: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    if (eligible && !eligible[i]) return;
    candidates.push({ i, v });
  });
  if (candidates.length < 2) return out;
  const vals = candidates.map((c) => c.v);
  const best = better === 'lower' ? Math.min(...vals) : Math.max(...vals);
  const worst = better === 'lower' ? Math.max(...vals) : Math.min(...vals);
  if (best === worst) return out;
  for (const c of candidates) if (c.v === best) out.add(c.i);
  return out;
}

export interface Cell {
  /** Used for "best" comparison; null = not comparable or not reported. */
  value: Maybe<number>;
  /** null = render as "not reported". */
  text: string | null;
  badge?: string;
  badgeTitle?: string;
  mono?: boolean;
}

export interface MetricRow {
  key: string;
  group: string;
  label: string;
  better: Better;
  cell: (lane: Lane) => Cell;
}

function num(v: Maybe<number> | undefined, fmt: (n: number) => string): Cell {
  if (v === null || v === undefined || !Number.isFinite(v)) return { value: null, text: null };
  return { value: v, text: fmt(v) };
}

function text(t: Maybe<string> | undefined, mono = false): Cell {
  return { value: null, text: t ? t : null, mono };
}

const KIND_LABELS: Record<ToolKind, string> = {
  read: 'File reads',
  edit: 'File edits',
  command: 'Shell commands (tool)',
  search: 'Searches',
  web: 'Web requests',
  plan: 'Plan updates',
  agent: 'Sub-agents',
  other: 'Other tools',
};

const FINISH_LABELS = { not_set: 'no finish command', not_run: 'not run', passed: 'passed', failed: 'failed' } as const;
const BUILD_LABELS = {
  not_run: 'not run',
  no_build_script: 'no build script',
  passed: 'passed',
  failed: 'failed',
} as const;
const PREVIEW_LABELS = { not_run: 'not run', pending: 'pending', started: 'started', failed: 'failed' } as const;

/** Every field of LaneMetrics, one row each. */
export function metricRows(): MetricRow[] {
  const rows: MetricRow[] = [
    { key: 'wall', group: 'Time', label: 'Wall time', better: 'lower', cell: (l) => num(l.metrics.time.wallMs, fmtDuration) },
    {
      key: 'firstEdit',
      group: 'Time',
      label: 'Time to first edit',
      better: 'lower',
      cell: (l) => num(l.metrics.time.firstEditMs, fmtDuration),
    },
    {
      key: 'model',
      group: 'Time',
      label: 'Model time',
      better: 'lower',
      cell: (l) => {
        const c = num(l.metrics.time.modelMs, fmtDuration);
        if (c.text === null) return c;
        const src = l.metrics.time.modelMsSource;
        if (src === 'derived') return { ...c, badge: 'from event timings', badgeTitle: DERIVED_TOOLTIP };
        if (src === 'reported') return { ...c, badge: 'reported', badgeTitle: 'Reported by the CLI itself.' };
        return c;
      },
    },
    {
      key: 'command',
      group: 'Time',
      label: 'Command time',
      better: 'lower',
      cell: (l) => num(l.metrics.time.commandMs, fmtDuration),
    },
    { key: 'tool', group: 'Time', label: 'Tool time', better: 'lower', cell: (l) => num(l.metrics.time.toolMs, fmtDuration) },

    { key: 'tokIn', group: 'Tokens', label: 'Input (not cached)', better: 'lower', cell: (l) => num(l.metrics.tokens.input, fmtInt) },
    { key: 'tokOut', group: 'Tokens', label: 'Output', better: 'lower', cell: (l) => num(l.metrics.tokens.output, fmtInt) },
    { key: 'tokCr', group: 'Tokens', label: 'Cache read', better: null, cell: (l) => num(l.metrics.tokens.cacheRead, fmtInt) },
    { key: 'tokCw', group: 'Tokens', label: 'Cache write', better: null, cell: (l) => num(l.metrics.tokens.cacheWrite, fmtInt) },
    {
      key: 'tokReason',
      group: 'Tokens',
      label: 'Reasoning (part of output)',
      better: null,
      cell: (l) => num(l.metrics.tokens.reasoning, fmtInt),
    },
    { key: 'tokTotal', group: 'Tokens', label: 'Total', better: 'lower', cell: (l) => num(totalTokens(l.metrics.tokens), fmtInt) },

    {
      key: 'cost',
      group: 'Cost',
      label: 'Cost',
      better: 'lower',
      cell: (l) => {
        const c = num(l.metrics.cost.usd, fmtMoney);
        if (c.text === null) return c;
        if (l.metrics.cost.source === 'estimated') return { ...c, badge: 'est.', badgeTitle: ESTIMATE_TOOLTIP };
        if (l.metrics.cost.source === 'reported') return { ...c, badge: 'reported', badgeTitle: 'Reported by the CLI itself.' };
        return c;
      },
    },

    { key: 'turns', group: 'Activity', label: 'Turns', better: null, cell: (l) => num(l.metrics.activity.turns, fmtInt) },
    { key: 'toolCalls', group: 'Activity', label: 'Tool calls', better: null, cell: (l) => num(l.metrics.activity.toolCalls, fmtInt) },
    ...TOOL_KINDS.map<MetricRow>((k) => ({
      key: `kind-${k}`,
      group: 'Activity',
      label: KIND_LABELS[k],
      better: null,
      cell: (l) => num(l.metrics.activity.byKind[k] ?? 0, fmtInt),
    })),
    { key: 'commands', group: 'Activity', label: 'Commands run', better: null, cell: (l) => num(l.metrics.activity.commands, fmtInt) },
    {
      key: 'commandsFailed',
      group: 'Activity',
      label: 'Failed commands',
      better: 'lower',
      cell: (l) => num(l.metrics.activity.commandsFailed, fmtInt),
    },
    { key: 'errors', group: 'Activity', label: 'Errors', better: 'lower', cell: (l) => num(l.metrics.activity.errors, fmtInt) },
    { key: 'retries', group: 'Activity', label: 'Retries', better: 'lower', cell: (l) => num(l.metrics.activity.retries, fmtInt) },

    { key: 'filesCreated', group: 'Code', label: 'Files created', better: null, cell: (l) => num(l.metrics.code?.filesCreated, fmtInt) },
    { key: 'filesModified', group: 'Code', label: 'Files modified', better: null, cell: (l) => num(l.metrics.code?.filesModified, fmtInt) },
    { key: 'filesDeleted', group: 'Code', label: 'Files deleted', better: null, cell: (l) => num(l.metrics.code?.filesDeleted, fmtInt) },
    { key: 'linesAdded', group: 'Code', label: 'Lines added', better: null, cell: (l) => num(l.metrics.code?.linesAdded, (n) => (n === 0 ? '0' : `+${fmtInt(n)}`)) },
    {
      key: 'linesRemoved',
      group: 'Code',
      label: 'Lines removed',
      better: null,
      cell: (l) => num(l.metrics.code?.linesRemoved, (n) => (n === 0 ? '0' : `-${fmtInt(n)}`)),
    },
    {
      key: 'deps',
      group: 'Code',
      label: 'New dependencies',
      better: null,
      cell: (l) => {
        const c = l.metrics.code;
        if (!c) return { value: null, text: null };
        const deps = c.newDependencies ?? [];
        return { value: deps.length, text: deps.length ? deps.join(', ') : 'none' };
      },
    },

    {
      key: 'finish',
      group: 'Outcome',
      label: 'Finish command',
      better: null,
      cell: (l) => {
        const o = l.metrics.outcome;
        const label = FINISH_LABELS[o.finish] ?? String(o.finish);
        const code = o.finishExitCode;
        return text(o.finish === 'failed' && code !== null ? `${label} (exit ${code})` : label);
      },
    },
    { key: 'testsPassed', group: 'Outcome', label: 'Tests passed', better: 'higher', cell: (l) => num(l.metrics.outcome.tests?.passed, fmtInt) },
    { key: 'testsFailed', group: 'Outcome', label: 'Tests failed', better: 'lower', cell: (l) => num(l.metrics.outcome.tests?.failed, fmtInt) },
    { key: 'testsTotal', group: 'Outcome', label: 'Tests total', better: null, cell: (l) => num(l.metrics.outcome.tests?.total, fmtInt) },
    { key: 'build', group: 'Outcome', label: 'Build', better: null, cell: (l) => text(BUILD_LABELS[l.metrics.outcome.build] ?? String(l.metrics.outcome.build)) },
    {
      key: 'preview',
      group: 'Outcome',
      label: 'Preview',
      better: null,
      cell: (l) => text(PREVIEW_LABELS[l.metrics.outcome.preview] ?? String(l.metrics.outcome.preview)),
    },

    { key: 'modelName', group: 'Run', label: 'Model (reported by CLI)', better: null, cell: (l) => text(l.metrics.model) },
    {
      key: 'modelRequested',
      group: 'Run',
      label: 'Model (requested)',
      better: null,
      cell: (l) => text(l.requestedModel ? l.requestedModel : 'CLI default'),
    },
    { key: 'cli', group: 'Run', label: 'CLI version', better: null, cell: (l) => text(l.metrics.cliVersion) },
    { key: 'cmd', group: 'Run', label: 'Command line', better: null, cell: (l) => text(l.commandLine, true) },
  ];
  return rows;
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function costText(lane: Lane): string {
  const usd = lane.metrics.cost.usd;
  if (usd === null || usd === undefined) return NOT_REPORTED;
  return lane.metrics.cost.source === 'estimated' ? `${fmtMoney(usd)} (est.)` : fmtMoney(usd);
}

export function resultsMarkdown(race: Race, ranked: Lane[]): string {
  const positions = finishPositions(race.lanes);
  const lines: string[] = [];
  lines.push(`**Agent Derby**: ${mdEscape(truncate(race.setup.task, 200))}`);
  lines.push('');
  lines.push('| # | Agent | Model | State | Time | Cost | Tokens | Lines changed |');
  lines.push('|---|-------|-------|-------|------|------|--------|---------------|');
  for (const l of ranked) {
    const pos = positions.get(l.id);
    const tokens = totalTokens(l.metrics.tokens);
    const c = l.metrics.code;
    lines.push(
      `| ${pos ?? ''} | ${mdEscape(l.agentName)} | ${mdEscape(laneModel(l))} | ${stateLabel(l.state)} | ${fmtDuration(
        l.metrics.time.wallMs,
      )} | ${costText(l)} | ${tokens === null ? NOT_REPORTED : fmtInt(tokens)} | ${
        c ? `+${fmtInt(c.linesAdded)} / -${fmtInt(c.linesRemoved)}` : NOT_REPORTED
      } |`,
    );
  }
  lines.push('');
  const notes = [`Every agent received the identical prompt (sha256 \`${shortSha(race.promptSha256, 12)}\`).`];
  if (ranked.some((l) => l.metrics.cost.source === 'estimated' && l.metrics.cost.usd !== null)) {
    notes.push('Costs marked est. are computed from a price table, not measured.');
  }
  if (!allDone(race.lanes)) notes.push('Race still running: these results are partial.');
  lines.push(notes.join(' '));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/** Upsert by seq into an array kept sorted by seq. Returns the same array when nothing changes. */
export function upsertFeed(items: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  if (!incoming || incoming.length === 0) return items;
  let out = items;
  let copied = false;
  const own = () => {
    if (!copied) {
      out = items.slice();
      copied = true;
    }
  };
  for (const item of incoming) {
    if (!item || typeof item.seq !== 'number') continue;
    const last = out[out.length - 1];
    if (!last || item.seq > last.seq) {
      own();
      out.push(item);
      continue;
    }
    // binary search for the position of seq
    let lo = 0;
    let hi = out.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = out[mid]!.seq;
      if (s === item.seq) {
        found = mid;
        break;
      }
      if (s < item.seq) lo = mid + 1;
      else hi = mid - 1;
    }
    own();
    if (found >= 0) out[found] = item;
    else out.splice(lo, 0, item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

export interface DiffRow {
  type: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  if (!patch) return rows;
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = parseInt(hunk[1]!, 10);
      newNo = parseInt(hunk[2]!, 10);
      inHunk = true;
      rows.push({ type: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (!inHunk) continue; // file header lines (diff --git, index, ---, +++)
    const ch = line[0];
    if (ch === '+') {
      rows.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (ch === '-') {
      rows.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (ch === '\\') {
      rows.push({ type: 'meta', oldNo: null, newNo: null, text: line.slice(2) });
    } else {
      rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
  }
  return rows;
}
