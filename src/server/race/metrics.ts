import { emptyMetrics, type LaneMetrics, type TokenUsage, type ToolKind } from '../../shared/types.js';
import type { AgentEvent } from '../adapters/types.js';
import { estimateCost, type PriceTable } from './pricing.js';

/**
 * Turns the stream of normalised agent events into the numbers shown in the
 * lane and the results table. Pure: time is always passed in (milliseconds
 * since the lane started), so it can be unit-tested with recorded output.
 *
 * Rule that runs through everything here: a value is `null` ("not reported")
 * until the CLI actually reports it. Nothing is guessed.
 */
export class MetricsTracker {
  private m: LaneMetrics = emptyMetrics();
  private openTools = new Map<string, { kind: ToolKind; start: number }>();
  /** Union-of-intervals accounting, so parallel tool calls are not double counted. */
  private toolBusySince: number | null = null;
  private commandBusySince: number | null = null;
  private toolMs = 0;
  private commandMs = 0;
  private sawTools = false;
  private turnEvents = 0;
  private reportedTurns: number | null = null;
  private reportedModelMs: number | null = null;
  private reportedCost: number | null = null;
  private endedAt: number | null = null;

  constructor(
    private prices: PriceTable,
    private requestedModel: string,
  ) {}

  private openCount(kind?: ToolKind): number {
    let n = 0;
    for (const t of this.openTools.values()) if (!kind || t.kind === kind) n++;
    return n;
  }

  onEvent(ev: AgentEvent, t: number): void {
    const a = this.m.activity;
    switch (ev.type) {
      case 'init':
        if (ev.model) this.m.model = ev.model;
        if (ev.cliVersion) this.m.cliVersion = ev.cliVersion;
        break;
      case 'turn':
        this.turnEvents++;
        break;
      case 'tool_start': {
        if (ev.pending) break; // the model is still writing the call: that is model time
        if (this.openTools.has(ev.id)) break;
        this.sawTools = true;
        a.toolCalls++;
        a.byKind[ev.kind]++;
        if (ev.kind === 'command') a.commands++;
        if (ev.kind === 'edit' && this.m.time.firstEditMs === null) this.m.time.firstEditMs = t;
        if (this.openCount() === 0) this.toolBusySince = t;
        if (ev.kind === 'command' && this.openCount('command') === 0) this.commandBusySince = t;
        this.openTools.set(ev.id, { kind: ev.kind, start: t });
        break;
      }
      case 'tool_end': {
        const open = this.openTools.get(ev.id);
        if (!open) break;
        this.openTools.delete(ev.id);
        if (open.kind === 'command' && !ev.ok) a.commandsFailed++;
        if (this.openCount() === 0 && this.toolBusySince !== null) {
          this.toolMs += Math.max(0, t - this.toolBusySince);
          this.toolBusySince = null;
        }
        if (open.kind === 'command' && this.openCount('command') === 0 && this.commandBusySince !== null) {
          this.commandMs += Math.max(0, t - this.commandBusySince);
          this.commandBusySince = null;
        }
        break;
      }
      case 'usage': {
        const tok = this.m.tokens;
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as (keyof TokenUsage)[]) {
          const v = ev.usage[key];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          tok[key] = ev.mode === 'add' ? (tok[key] ?? 0) + v : v;
        }
        break;
      }
      case 'cost':
        if (Number.isFinite(ev.usd)) this.reportedCost = ev.usd;
        break;
      case 'error':
        a.errors++;
        if (ev.retry) a.retries++;
        break;
      case 'result':
        if (typeof ev.turns === 'number') this.reportedTurns = ev.turns;
        if (typeof ev.modelMs === 'number') this.reportedModelMs = ev.modelMs;
        break;
    }
  }

  /** The agent process has exited: close anything still open and freeze the clock. */
  end(t: number): void {
    if (this.endedAt !== null) return;
    if (this.toolBusySince !== null) this.toolMs += Math.max(0, t - this.toolBusySince);
    if (this.commandBusySince !== null) this.commandMs += Math.max(0, t - this.commandBusySince);
    this.toolBusySince = null;
    this.commandBusySince = null;
    this.openTools.clear();
    this.endedAt = t;
  }

  /** Current cost in USD if known, for enforcing the cost limit. */
  costNow(): number | null {
    return this.cost().usd;
  }

  private cost(): LaneMetrics['cost'] {
    if (this.reportedCost !== null) return { usd: this.reportedCost, source: 'reported' };
    const est = estimateCost(this.prices, this.m.model ?? this.requestedModel, this.m.tokens);
    return est === null ? { usd: null, source: null } : { usd: est, source: 'estimated' };
  }

  /** Mutable outcome/code/live fields are owned by the engine and merged in here. */
  snapshot(t: number, extra: Pick<LaneMetrics, 'filesChangedLive' | 'code' | 'outcome'>): LaneMetrics {
    const now = this.endedAt ?? t;
    const toolMs = this.toolMs + (this.toolBusySince !== null ? Math.max(0, now - this.toolBusySince) : 0);
    const commandMs = this.commandMs + (this.commandBusySince !== null ? Math.max(0, now - this.commandBusySince) : 0);
    const time: LaneMetrics['time'] = {
      wallMs: now,
      firstEditMs: this.m.time.firstEditMs,
      modelMs: null,
      modelMsSource: null,
      commandMs: null,
      toolMs: null,
    };
    if (this.sawTools) {
      // Measured from event timestamps, the same way for every agent, so the split is comparable.
      time.toolMs = toolMs;
      time.commandMs = commandMs;
      time.modelMs = Math.max(0, now - toolMs);
      time.modelMsSource = 'derived';
    } else if (this.reportedModelMs !== null) {
      time.modelMs = this.reportedModelMs;
      time.modelMsSource = 'reported';
    }
    return {
      time,
      tokens: { ...this.m.tokens },
      cost: this.cost(),
      activity: {
        ...this.m.activity,
        byKind: { ...this.m.activity.byKind },
        turns: this.reportedTurns ?? (this.turnEvents > 0 ? this.turnEvents : null),
      },
      filesChangedLive: extra.filesChangedLive,
      code: extra.code,
      outcome: extra.outcome,
      // What we asked for is a fact too, but only when the CLI never says what it used.
      model: this.m.model ?? (this.requestedModel || null),
      cliVersion: this.m.cliVersion,
    };
  }
}

/**
 * Pull pass/fail counts out of test-runner output. Returns null unless a known
 * summary line is found — a missing count is "not reported", not zero.
 */
export function parseTestCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const num = (re: RegExp) => {
    const all = [...text.matchAll(re)];
    return all.length ? Number(all[all.length - 1]![1]) : null;
  };
  const make = (passed: number | null, failed: number | null, total?: number | null) => {
    if (passed === null && failed === null) return null;
    const p = passed ?? (total != null && failed != null ? total - failed : 0);
    const f = failed ?? 0;
    return { passed: p, failed: f, total: total ?? p + f };
  };

  // Jest / Vitest: "Tests:  1 failed, 4 passed, 5 total"  /  "Tests  4 passed | 1 failed (5)"
  const jestLine = [...text.matchAll(/^\s*Tests:?\s+(.+)$/gim)].pop()?.[1];
  if (jestLine) {
    const g = (w: string) => {
      const m = jestLine.match(new RegExp(`(\\d+)\\s+${w}`));
      return m ? Number(m[1]) : null;
    };
    const total = jestLine.match(/(\d+)\s+total/) ?? jestLine.match(/\((\d+)\)/);
    const r = make(g('passed'), g('failed'), total ? Number(total[1]) : null);
    if (r) return r;
  }
  // node:test / TAP: "# pass 4" "# fail 1"
  const tapPass = num(/^#\s*pass\s+(\d+)/gim);
  const tapFail = num(/^#\s*fail\s+(\d+)/gim);
  if (tapPass !== null || tapFail !== null) return make(tapPass, tapFail);
  // pytest: "== 3 passed, 1 failed in 0.12s =="
  const py = [...text.matchAll(/^=+ (.*?) in [\d.]+s.*=+$/gm)].pop()?.[1];
  if (py) {
    const g = (w: string) => {
      const m = py.match(new RegExp(`(\\d+) ${w}`));
      return m ? Number(m[1]) : null;
    };
    const r = make(g('passed'), (g('failed') ?? 0) + (g('error') ?? g('errors') ?? 0) || (g('passed') !== null ? 0 : null));
    if (r) return r;
  }
  // cargo: "test result: ok. 5 passed; 0 failed;"
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) {
    return make(
      cargo.reduce((a, m) => a + Number(m[1]), 0),
      cargo.reduce((a, m) => a + Number(m[2]), 0),
    );
  }
  // Mocha: "4 passing" "1 failing"
  const mPass = num(/^\s*(\d+) passing/gim);
  const mFail = num(/^\s*(\d+) failing/gim);
  if (mPass !== null || mFail !== null) return make(mPass, mFail);
  // go test -v: count "--- PASS" / "--- FAIL"
  const goPass = (text.match(/^\s*--- PASS/gm) ?? []).length;
  const goFail = (text.match(/^\s*--- FAIL/gm) ?? []).length;
  if (goPass + goFail > 0) return make(goPass, goFail);
  return null;
}
