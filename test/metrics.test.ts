import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeParser } from '../src/server/adapters/claude.js';
import { MetricsTracker, parseTestCounts } from '../src/server/race/metrics.js';
import { estimateCost, findPrice, type PriceTable } from '../src/server/race/pricing.js';
import { emptyMetrics, rankLanes, totalTokens, type Lane, type LaneMetrics } from '../src/shared/types.js';

const extra = (): Pick<LaneMetrics, 'filesChangedLive' | 'code' | 'outcome'> => ({
  filesChangedLive: 0,
  code: null,
  outcome: emptyMetrics().outcome,
});

const prices: PriceTable = { 'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 } };

describe('MetricsTracker', () => {
  it('reports nothing it was not told', () => {
    const m = new MetricsTracker({}, '').snapshot(5000, extra());
    expect(m.tokens).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null });
    expect(m.cost).toEqual({ usd: null, source: null });
    expect(m.activity.turns).toBeNull();
    expect(m.time).toMatchObject({ wallMs: 5000, firstEditMs: null, modelMs: null, modelMsSource: null, toolMs: null, commandMs: null });
    expect(m.model).toBeNull();
    expect(totalTokens(m.tokens)).toBeNull();
  });

  it('splits model time from tool time using event timestamps', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'turn' }, 0);
    t.onEvent({ type: 'tool_start', id: 'a', kind: 'read', name: 'Read', target: 'x' }, 1000);
    t.onEvent({ type: 'tool_end', id: 'a', ok: true }, 1500);
    t.onEvent({ type: 'tool_start', id: 'b', kind: 'command', name: 'Bash', target: 'npm test' }, 3000);
    t.onEvent({ type: 'tool_end', id: 'b', ok: false, exitCode: 1 }, 7000);
    t.onEvent({ type: 'tool_start', id: 'c', kind: 'edit', name: 'Edit', target: 'y' }, 8000);
    t.onEvent({ type: 'tool_end', id: 'c', ok: true }, 8200);
    t.end(10_000);
    const m = t.snapshot(99_999, extra());
    expect(m.time).toEqual({ wallMs: 10_000, firstEditMs: 8000, toolMs: 4700, commandMs: 4000, modelMs: 5300, modelMsSource: 'derived' });
    expect(m.activity).toMatchObject({ toolCalls: 3, commands: 1, commandsFailed: 1, turns: 1 });
    expect(m.activity.byKind).toMatchObject({ read: 1, command: 1, edit: 1, search: 0 });
  });

  it('does not double count tools that run in parallel', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'tool_start', id: 'a', kind: 'command', name: 'Bash', target: 'a' }, 1000);
    t.onEvent({ type: 'tool_start', id: 'b', kind: 'command', name: 'Bash', target: 'b' }, 2000);
    t.onEvent({ type: 'tool_end', id: 'a', ok: true }, 3000);
    t.onEvent({ type: 'tool_end', id: 'b', ok: true }, 5000);
    t.end(6000);
    const m = t.snapshot(6000, extra());
    expect(m.time.toolMs).toBe(4000);
    expect(m.time.commandMs).toBe(4000);
    expect(m.time.modelMs).toBe(2000);
  });

  it('counts a pending tool call as model time, not tool time', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'tool_start', id: 'a', kind: 'edit', name: 'Write', target: null, pending: true }, 1000);
    t.onEvent({ type: 'tool_start', id: 'a', kind: 'edit', name: 'Write', target: 'big.js' }, 9000);
    t.onEvent({ type: 'tool_end', id: 'a', ok: true }, 9100);
    t.end(10_000);
    const m = t.snapshot(10_000, extra());
    expect(m.activity.toolCalls).toBe(1);
    expect(m.time.firstEditMs).toBe(9000);
    expect(m.time.toolMs).toBe(100);
  });

  it('includes a still-running tool in live figures and closes it at the end', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'tool_start', id: 'a', kind: 'command', name: 'Bash', target: 'sleep' }, 1000);
    expect(t.snapshot(4000, extra()).time.commandMs).toBe(3000);
    t.end(5000);
    expect(t.snapshot(9000, extra()).time.commandMs).toBe(4000);
    expect(t.snapshot(9000, extra()).time.wallMs).toBe(5000);
  });

  it('falls back to the reported model time only when there are no tool events', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'result', ok: true, modelMs: 4200, turns: 7 }, 5000);
    const m = t.snapshot(5000, extra());
    expect(m.time).toMatchObject({ modelMs: 4200, modelMsSource: 'reported', toolMs: null });
    expect(m.activity.turns).toBe(7);
  });

  it('accumulates usage in add mode and replaces it in total mode', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'usage', mode: 'add', usage: { input: 10, output: 5 } }, 0);
    t.onEvent({ type: 'usage', mode: 'add', usage: { input: 1, output: 2, reasoning: 1 } }, 0);
    expect(t.snapshot(0, extra()).tokens).toEqual({ input: 11, output: 7, cacheRead: null, cacheWrite: null, reasoning: 1 });
    t.onEvent({ type: 'usage', mode: 'total', usage: { input: 100, output: 50, cacheRead: 9 } }, 0);
    expect(t.snapshot(0, extra()).tokens).toEqual({ input: 100, output: 50, cacheRead: 9, cacheWrite: null, reasoning: 1 });
  });

  it('labels cost as estimated until the CLI reports one', () => {
    const t = new MetricsTracker(prices, '');
    t.onEvent({ type: 'init', model: 'claude-haiku-4-5-20251001' }, 0);
    t.onEvent({ type: 'usage', mode: 'total', usage: { input: 945, output: 392, cacheRead: 53016, cacheWrite: 8744 } }, 0);
    const est = t.snapshot(0, extra()).cost;
    expect(est.source).toBe('estimated');
    expect(est.usd).toBeCloseTo(0.0256946, 7); // matches what Claude Code itself reported for this run
    t.onEvent({ type: 'cost', usd: 0.03 }, 0);
    expect(t.snapshot(0, extra()).cost).toEqual({ usd: 0.03, source: 'reported' });
  });

  it('shows no cost at all for a model without a price', () => {
    const t = new MetricsTracker(prices, 'mystery-model');
    t.onEvent({ type: 'usage', mode: 'total', usage: { input: 1000, output: 1000 } }, 0);
    expect(t.snapshot(0, extra()).cost).toEqual({ usd: null, source: null });
    expect(t.snapshot(0, extra()).model).toBe('mystery-model');
  });

  it('counts errors and retries', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'error', message: 'Reconnecting 1/5', retry: true }, 0);
    t.onEvent({ type: 'error', message: 'boom' }, 0);
    expect(t.snapshot(0, extra()).activity).toMatchObject({ errors: 2, retries: 1 });
  });

  it('end to end on the recorded Claude run', () => {
    const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8').split('\n');
    const parser = new ClaudeParser('/ws');
    const t = new MetricsTracker(prices, 'haiku');
    lines.forEach((line, i) => parser.parse(line, 'stdout').forEach((ev) => t.onEvent(ev, i * 50)));
    t.end(lines.length * 50);
    const m = t.snapshot(0, extra());
    expect(m.model).toBe('claude-haiku-4-5-20251001');
    expect(m.cliVersion).toBe('2.1.288');
    expect(m.activity).toMatchObject({ toolCalls: 2, commands: 1, commandsFailed: 1, turns: 3 });
    expect(m.cost.source).toBe('reported');
    expect(totalTokens(m.tokens)).toBe(945 + 392 + 53016 + 8744);
    expect(m.time.firstEditMs).not.toBeNull();
    expect(m.time.modelMs! + m.time.toolMs!).toBe(m.time.wallMs);
  });
});

describe('pricing', () => {
  it('matches by longest prefix', () => {
    const table: PriceTable = { 'gpt-6': { input: 1, output: 2 }, 'gpt-6-luna': { input: 0.1, output: 0.2 } };
    expect(findPrice(table, 'gpt-6-luna-2026')).toBe(table['gpt-6-luna']);
    expect(findPrice(table, 'gpt-6-sol')).toBe(table['gpt-6']);
    expect(findPrice(table, 'other')).toBeNull();
    expect(findPrice(table, null)).toBeNull();
  });

  it('returns null rather than zero when no tokens were reported', () => {
    expect(estimateCost(prices, 'claude-haiku-4-5', { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null })).toBeNull();
  });
});

describe('parseTestCounts', () => {
  it.each([
    ['Tests:       1 failed, 4 passed, 5 total', { passed: 4, failed: 1, total: 5 }],
    [' Tests  12 passed (12)', { passed: 12, failed: 0, total: 12 }],
    [' Tests  2 failed | 10 passed (12)', { passed: 10, failed: 2, total: 12 }],
    ['# tests 5\n# pass 4\n# fail 1', { passed: 4, failed: 1, total: 5 }],
    ['======= 3 passed, 1 failed in 0.12s =======', { passed: 3, failed: 1, total: 4 }],
    ['============ 7 passed in 1.02s ============', { passed: 7, failed: 0, total: 7 }],
    ['test result: ok. 5 passed; 0 failed; 0 ignored', { passed: 5, failed: 0, total: 5 }],
    ['  4 passing (12ms)\n  1 failing', { passed: 4, failed: 1, total: 5 }],
    ['--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- PASS: TestC', { passed: 2, failed: 1, total: 3 }],
  ])('%s', (output, expected) => {
    expect(parseTestCounts(output)).toEqual(expected);
  });

  it('returns null when there is no recognisable summary', () => {
    expect(parseTestCounts('all good\nexit 0')).toBeNull();
    expect(parseTestCounts('')).toBeNull();
  });
});

describe('rankLanes', () => {
  const lane = (id: string, state: Lane['state'], wallMs: number) => ({ id, state, metrics: { ...emptyMetrics(), time: { ...emptyMetrics().time, wallMs } } }) as Lane;

  it('puts successful finishes first, then orders by time', () => {
    const ranked = rankLanes([lane('crashed-fast', 'failed', 100), lane('slow', 'finished', 9000), lane('fast', 'finished', 3000), lane('timeout', 'timed_out', 5000)]);
    expect(ranked.map((l) => l.id)).toEqual(['fast', 'slow', 'crashed-fast', 'timeout']);
  });
});
