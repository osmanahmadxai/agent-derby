import { isTerminal, rankLanes, totalTokens, type FeedItem, type Lane, type Race, type ServerMessage } from '../shared/types.js';

/**
 * The terminal view: the screen is split into one pane per agent, each showing
 * what that agent is doing now, its live counters and its activity feed.
 * It is fed the same ServerMessage stream as the web UI.
 */

export interface RaceSource {
  /** Deliver the snapshot, then every later message for this race. Returns an unsubscribe function. */
  subscribe(cb: (msg: ServerMessage) => void): () => void;
  stopRace(): void;
  stopLane(laneId: string): void;
  /** URL of the same race in the browser. */
  browserUrl: string;
  openBrowser(): void;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;

function fg(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return '';
  return `${ESC}38;2;${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}m`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return 'n/r';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}.${Math.floor((ms % 1000) / 100)}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtTokens(n: number | null): string {
  if (n === null) return 'n/r';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(cost: Lane['metrics']['cost']): string {
  if (cost.usd === null) return 'n/r';
  const v = cost.usd < 1 ? `$${cost.usd.toFixed(4)}` : `$${cost.usd.toFixed(2)}`;
  return cost.source === 'estimated' ? `~${v} est.` : v;
}

const STATE_LABEL: Record<string, string> = {
  pending: 'PENDING',
  running: 'RUNNING',
  verifying: 'CHECKING',
  finished: 'FINISHED',
  failed: 'FAILED',
  stopped: 'STOPPED',
  timed_out: 'TIMED OUT',
  over_budget: 'OVER BUDGET',
};

function stateColor(state: string): string {
  if (state === 'finished') return GREEN;
  if (state === 'running' || state === 'verifying') return YELLOW;
  if (state === 'pending') return DIM;
  return RED;
}

/** Cut or pad plain text to exactly `width` columns. */
function fit(text: string, width: number): string {
  const clean = text.replace(/[\x00-\x1f\x7f]/g, ' ');
  if (clean.length > width) return width > 1 ? `${clean.slice(0, width - 1)}…` : clean.slice(0, width);
  return clean + ' '.repeat(width - clean.length);
}

function wrapText(text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trimEnd();
    if (!line) continue;
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut < width * 0.5) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out.length > maxLines ? ['…', ...out.slice(-(maxLines - 1))] : out;
}

function elapsedOf(lane: Lane): number {
  if (lane.startedAt && (lane.state === 'running' || lane.state === 'pending')) return Date.now() - lane.startedAt;
  return lane.metrics.time.wallMs;
}

function feedLines(item: FeedItem, width: number): { text: string; style: string }[] {
  switch (item.type) {
    case 'thinking':
      return wrapText(item.text, width - 2, 3).map((t) => ({ text: `· ${t}`, style: DIM + ITALIC }));
    case 'message':
      return wrapText(item.text, width, 6).map((t) => ({ text: t, style: '' }));
    case 'error':
      return wrapText(item.text, width - 2, 3).map((t, i) => ({ text: `${i ? ' ' : '!'} ${t}`, style: RED }));
    case 'system':
      return wrapText(item.text, width - 2, 4).map((t) => ({ text: `# ${t}`, style: DIM }));
    case 'raw':
      return [{ text: item.text, style: DIM }];
    case 'tool': {
      const tool = item.tool!;
      const mark = tool.status === 'running' ? '…' : tool.status === 'ok' ? '✓' : '✗';
      const dur = tool.durationMs !== null ? ` ${fmtDuration(tool.durationMs)}` : '';
      const line = `${mark} ${tool.kind} ${tool.target ?? tool.name}`;
      return [{ text: fit(line, Math.max(1, width - dur.length)).trimEnd() + dur, style: tool.status === 'failed' ? RED : tool.status === 'running' ? YELLOW : '' }];
    }
  }
}

export class Tui {
  private race: Race | null = null;
  private feeds = new Map<string, Map<number, FeedItem>>();
  private view: 'lanes' | 'results' = 'lanes';
  private timer: NodeJS.Timeout | null = null;
  private dirty = true;
  private unsubscribe: (() => void) | null = null;
  private done: (() => void) | null = null;
  private autoSwitched = false;
  private notice = '';

  constructor(
    private source: RaceSource,
    private out: NodeJS.WriteStream = process.stdout,
  ) {}

  /** Runs until the user quits. Resolves with the final race. */
  run(): Promise<Race | null> {
    return new Promise((resolve) => {
      this.out.write(`${ESC}?1049h${ESC}?25l`);
      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const onKey = (key: string) => this.onKey(key);
      stdin.on('data', onKey);
      const onResize = () => (this.dirty = true);
      this.out.on('resize', onResize);
      this.unsubscribe = this.source.subscribe((msg) => this.onMessage(msg));
      this.timer = setInterval(() => this.render(), 100);
      this.done = () => {
        if (this.timer) clearInterval(this.timer);
        this.unsubscribe?.();
        stdin.off('data', onKey);
        this.out.off('resize', onResize);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        this.out.write(`${ESC}?25h${ESC}?1049l`);
        resolve(this.race);
      };
    });
  }

  private onKey(key: string): void {
    const running = this.race ? this.race.lanes.some((l) => !isTerminal(l.state)) : false;
    if (key === '\x03' || key === 'q') {
      if (running) this.source.stopRace();
      this.done?.();
    } else if (key === 's') {
      this.source.stopRace();
      this.notice = 'Stopping every lane…';
    } else if (key === 'r' || key === '\t') this.view = this.view === 'lanes' ? 'results' : 'lanes';
    else if (key === 'o') {
      this.source.openBrowser();
      this.notice = `Opened ${this.source.browserUrl}`;
    } else if (/^[1-9]$/.test(key) && this.race) {
      const lane = this.race.lanes[Number(key) - 1];
      if (lane && !isTerminal(lane.state)) {
        this.source.stopLane(lane.id);
        this.notice = `Stopping ${lane.agentName}…`;
      }
    }
    this.dirty = true;
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type === 'race') this.race = msg.race;
    else if (msg.type === 'race_patch' && this.race) Object.assign(this.race, msg.patch);
    else if (msg.type === 'lane' && this.race) {
      const lane = this.race.lanes.find((l) => l.id === msg.laneId);
      if (lane) Object.assign(lane, msg.patch);
    } else if (msg.type === 'feed') {
      let feed = this.feeds.get(msg.laneId);
      if (!feed) this.feeds.set(msg.laneId, (feed = new Map()));
      for (const item of msg.items) feed.set(item.seq, item);
    }
    if (this.race && !this.autoSwitched && this.race.lanes.every((l) => isTerminal(l.state))) {
      this.autoSwitched = true;
      this.view = 'results';
    }
    this.dirty = true;
  }

  private render(): void {
    const race = this.race;
    const cols = Math.max(40, this.out.columns ?? 100);
    const rows = Math.max(12, this.out.rows ?? 30);
    const anyRunning = race?.lanes.some((l) => l.state === 'running' || l.state === 'verifying') ?? false;
    if (!this.dirty && !anyRunning) return;
    this.dirty = false;

    const lines: string[] = [];
    const clock = race?.startedAt ? fmtDuration((race.endedAt ?? Date.now()) - race.startedAt) : '';
    const title = ` AGENT DERBY  ${race ? race.setup.task.replace(/\s+/g, ' ') : 'starting…'}`;
    lines.push(`${ESC}7m${BOLD}${fit(title, cols - clock.length - 2)}${clock}  ${RESET}`);

    if (!race) lines.push('', '  Preparing workspaces…');
    else if (race.error) lines.push('', `  ${RED}${race.error}${RESET}`);
    else if (this.view === 'results') lines.push(...this.resultsView(race, cols));
    else lines.push(...this.lanesView(race, cols, rows - 3));

    while (lines.length < rows - 1) lines.push('');
    const keys = this.view === 'lanes' ? ' r results · o open in browser · s stop race · 1-9 stop lane · q quit' : ' r lanes · o open in browser · q quit';
    lines[rows - 2] = `${DIM}${fit(this.notice ? ` ${this.notice}` : ' n/r = not reported by the CLI · est. = estimated from the price table', cols)}${RESET}`;
    lines[rows - 1] = `${ESC}7m${fit(keys, cols)}${RESET}`;
    this.out.write(`${ESC}H${lines.slice(0, rows).map((l) => `${l}${ESC}K`).join('\n')}`);
  }

  private lanesView(race: Race, cols: number, height: number): string[] {
    const n = race.lanes.length;
    const width = Math.max(18, Math.floor((cols - (n - 1)) / n));
    const panes = race.lanes.map((lane, i) => this.pane(lane, i, width, height));
    const out: string[] = [];
    for (let row = 0; row < height; row++) out.push(panes.map((p) => p[row] ?? ' '.repeat(width)).join(`${DIM}│${RESET}`));
    return out;
  }

  private pane(lane: Lane, index: number, width: number, height: number): string[] {
    const color = fg(lane.color);
    const m = lane.metrics;
    const state = STATE_LABEL[lane.state] ?? lane.state;
    const head = `${index + 1} ${lane.agentName}`;
    const rows: string[] = [];
    rows.push(`${color}${BOLD}${fit(head, Math.max(1, width - state.length - 1))}${RESET} ${stateColor(lane.state)}${BOLD}${state}${RESET}`);
    rows.push(`${DIM}${fit(`${m.model ?? 'model n/r'} · v${m.cliVersion ?? '?'}`, width)}${RESET}`);
    rows.push(`${BOLD}${fit(lane.stateReason && isTerminal(lane.state) ? lane.stateReason : lane.now.text, width)}${RESET}`);
    const files = m.code ? m.code.filesCreated + m.code.filesModified + m.code.filesDeleted : m.filesChangedLive;
    rows.push(fit(`${fmtDuration(elapsedOf(lane))}  tok ${fmtTokens(totalTokens(m.tokens))}  ${fmtCost(m.cost)}`, width));
    rows.push(fit(`tools ${m.activity.toolCalls}  files ${files}${m.code ? `  +${m.code.linesAdded} -${m.code.linesRemoved}` : ''}`, width));
    const preview = lane.preview;
    if (preview.status === 'ready') {
      rows.push(`${GREEN}${fit(preview.url ? `▶ ${preview.url}` : `▶ ${preview.startCommand ?? 'ready'} (terminal)`, width)}${RESET}`);
    } else if (preview.status !== 'none') {
      rows.push(`${preview.status === 'failed' ? RED : YELLOW}${fit(`preview: ${preview.status}`, width)}${RESET}`);
    }
    rows.push(`${color}${'─'.repeat(width)}${RESET}`);

    const space = height - rows.length;
    const feed = [...(this.feeds.get(lane.id)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
    const body: string[] = [];
    for (let i = feed.length - 1; i >= 0 && body.length < space; i--) {
      const rendered = feedLines(feed[i]!, width).map((l) => `${l.style}${fit(l.text, width)}${RESET}`);
      body.unshift(...rendered);
    }
    rows.push(...body.slice(-Math.max(0, space)));
    while (rows.length < height) rows.push(' '.repeat(width));
    return rows.slice(0, height);
  }

  private resultsView(race: Race, cols: number): string[] {
    const out: string[] = [''];
    const finished = race.lanes.every((l) => isTerminal(l.state));
    out.push(`  ${BOLD}${finished ? 'Results' : 'Results so far (race still running)'}${RESET}   ${DIM}ranked by: finished first, then time${RESET}`, '');
    const head = ['#', 'Agent', 'State', 'Time', 'Tokens', 'Cost', 'Tools', 'Files', '+/-'];
    const table = rankLanes(race.lanes).map((lane, i) => {
      const m = lane.metrics;
      return {
        lane,
        cells: [
          String(i + 1),
          lane.agentName,
          STATE_LABEL[lane.state] ?? lane.state,
          fmtDuration(elapsedOf(lane)),
          fmtTokens(totalTokens(m.tokens)),
          fmtCost(m.cost),
          String(m.activity.toolCalls),
          m.code ? String(m.code.filesCreated + m.code.filesModified + m.code.filesDeleted) : 'n/r',
          m.code ? `+${m.code.linesAdded} -${m.code.linesRemoved}` : 'n/r',
        ],
      };
    });
    const widths = head.map((h, c) => Math.max(h.length, ...table.map((r) => r.cells[c]!.length)));
    const line = (cells: string[]) => cells.map((c, i) => fit(c, widths[i]!)).join('  ');
    out.push(`  ${DIM}${line(head)}${RESET}`);
    for (const row of table) {
      const [rank, name, state, ...rest] = row.cells as [string, string, string, ...string[]];
      out.push(
        `  ${fit(rank, widths[0]!)}  ${fg(row.lane.color)}${BOLD}${fit(name, widths[1]!)}${RESET}  ${stateColor(row.lane.state)}${fit(state, widths[2]!)}${RESET}  ${rest.map((c, i) => fit(c, widths[i + 3]!)).join('  ')}`,
      );
    }
    out.push('');
    for (const lane of rankLanes(race.lanes)) {
      const p = lane.preview;
      const name = `${fg(lane.color)}${BOLD}${lane.agentName}${RESET}`;
      if (lane.stateReason) out.push(`  ${name}  ${DIM}${fit(lane.stateReason, cols - lane.agentName.length - 6)}${RESET}`);
      if (p.status === 'ready' && p.url) out.push(`  ${name}  ${GREEN}try it: ${p.url}${RESET}`);
      else if (p.status === 'ready') out.push(`  ${name}  ${GREEN}try it: cd ${lane.workspace} && ${p.startCommand}${RESET}`);
      else if (p.status === 'failed') out.push(`  ${name}  ${RED}preview failed: ${fit(p.error ?? '', cols - 30).trimEnd()}${RESET}`);
      else if (p.status !== 'none' && p.status !== 'stopped') out.push(`  ${name}  ${YELLOW}preview: ${p.status}…${RESET}`);
    }
    out.push('', `  ${DIM}Diffs, the comparison table, the result card and "keep this one": ${this.source.browserUrl}${RESET}`);
    out.push(`  ${DIM}Workspaces are kept until you delete the race: agent-derby delete ${race.id}${RESET}`);
    return out;
  }
}

/** Line-by-line output for pipes, CI and logs. */
export function plainReporter(write: (line: string) => void): (msg: ServerMessage) => void {
  const names = new Map<string, string>();
  const seen = new Map<string, number>();
  const states = new Map<string, string>();
  return (msg) => {
    if (msg.type === 'race') for (const l of msg.race.lanes) names.set(l.id, l.agentName);
    if (msg.type === 'lane' && msg.patch.state && states.get(msg.laneId) !== msg.patch.state) {
      states.set(msg.laneId, msg.patch.state);
      write(`[${names.get(msg.laneId) ?? msg.laneId}] state: ${msg.patch.state}${msg.patch.stateReason ? ` (${msg.patch.stateReason})` : ''}`);
    }
    if (msg.type === 'lane' && msg.patch.preview && ['ready', 'failed'].includes(msg.patch.preview.status)) {
      const p = msg.patch.preview;
      write(`[${names.get(msg.laneId) ?? msg.laneId}] preview ${p.status}: ${p.url ?? p.error ?? p.startCommand ?? ''}`);
    }
    if (msg.type !== 'feed') return;
    for (const item of msg.items) {
      // Streamed items are printed once, when they stop growing.
      if (item.streaming || (item.type === 'tool' && item.tool?.status === 'running')) continue;
      const key = `${msg.laneId}:${item.seq}`;
      if (seen.has(key)) continue;
      seen.set(key, 1);
      const who = `[${names.get(msg.laneId) ?? msg.laneId}]`;
      if (item.type === 'tool' && item.tool) {
        write(`${who} ${item.tool.status === 'ok' ? 'ok  ' : 'FAIL'} ${item.tool.kind} ${item.tool.target ?? item.tool.name}`);
      } else write(`${who} ${item.type}: ${item.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  };
}
