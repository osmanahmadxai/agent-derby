import { describe, expect, it } from 'vitest';
import { judgePrompt, parseVerdict } from '../src/server/race/judge.js';
import { MetricsTracker } from '../src/server/race/metrics.js';
import { buildReplay } from '../src/server/race/replay.js';
import { leaderboard } from '../src/server/race/suites.js';
import { emptyMetrics, emptyPreview, type Lane, type LaneState, type Race } from '../src/shared/types.js';

function lane(id: string, state: LaneState, wallMs: number, extra: Partial<Lane> = {}): Lane {
  return {
    id,
    agentId: id,
    agentName: `Agent ${id}`,
    kind: 'mock',
    color: '#123456',
    requestedModel: '',
    effort: '',
    round: 1,
    judge: null,
    state,
    stateReason: null,
    startedAt: 0,
    endedAt: wallMs,
    exitCode: 0,
    now: { kind: 'done', text: '' },
    metrics: { ...emptyMetrics(), time: { ...emptyMetrics().time, wallMs } },
    preview: emptyPreview(),
    workspace: '/w',
    branch: null,
    commandLine: null,
    finalMessage: null,
    kept: null,
    feedCount: 0,
    ...extra,
  };
}

function race(lanes: Lane[], extra: Partial<Race> = {}): Race {
  return {
    id: 'r1',
    createdAt: 0,
    startedAt: 0,
    endedAt: 1,
    state: 'finished',
    setup: { task: 'build a thing', entrants: [], source: { type: 'empty' } },
    prompt: 'p',
    promptSha256: 'abcdef0123456789',
    baseRef: null,
    lanes,
    error: null,
    appVersion: 'test',
    rounds: [],
    blind: false,
    vote: null,
    judging: false,
    judgeError: null,
    suiteId: null,
    ...extra,
  };
}

const cost = (usd: number | null, source: 'reported' | 'estimated' | null = usd === null ? null : 'reported') => ({ usd, source });

describe('judge', () => {
  it('finds the verdict in fenced, bare or chatty output', () => {
    const want = { score: 8, summary: 'Good.', strengths: ['works'], problems: ['no tests'] };
    const body = '{"score": 8, "summary": "Good.", "strengths": ["works"], "problems": ["no tests"]}';
    expect(parseVerdict(body)).toEqual(want);
    expect(parseVerdict(`Here you go:\n\`\`\`json\n${body}\n\`\`\`\nHope that helps.`)).toEqual(want);
    expect(parseVerdict(`I considered {"a": 1} first.\nFinal: ${body}`)).toEqual(want);
  });

  it('clamps the score to 1..10 and tolerates missing lists', () => {
    expect(parseVerdict('{"score": 42, "summary": "x"}')).toEqual({ score: 10, summary: 'x', strengths: [], problems: [] });
    expect(parseVerdict('{"score": -3}').score).toBe(1);
    expect(parseVerdict('{"score": "7"}').score).toBe(7);
  });

  it('refuses output with no verdict rather than inventing one', () => {
    expect(() => parseVerdict('Looks great to me!')).toThrow(/did not return a verdict/);
    expect(() => parseVerdict('{"summary": "no score"}')).toThrow();
  });

  it('gives the judge the task and the changes, and nothing that identifies the author', () => {
    const prompt = judgePrompt({
      task: 'Build a snake game',
      rounds: ['Add a pause key'],
      endedAs: 'finished',
      diff: { truncated: false, files: [{ path: 'index.html', status: 'added', added: 2, removed: 0, binary: false, truncated: false, patch: '@@ -0,0 +1,2 @@\n+<canvas>\n+</canvas>' }] },
    });
    expect(prompt).toContain('Build a snake game');
    expect(prompt).toContain('1. Add a pause key');
    expect(prompt).toContain('+<canvas>');
    expect(prompt).toMatch(/Ignore how long it took or what it cost/);
    expect(prompt).not.toMatch(/claude|codex|gemini|copilot|opencode|agent derby/i);
  });

  it('tells the judge when the work was cut short, and cuts an oversized diff', () => {
    const big = { path: 'big.js', status: 'added' as const, added: 1, removed: 0, binary: false, truncated: false, patch: 'x'.repeat(200_000) };
    const prompt = judgePrompt({ task: 't', rounds: [], endedAs: 'timed_out', diff: { truncated: false, files: [big] } });
    expect(prompt).toContain('did not finish normally (it ended as "timed out")');
    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).toContain('cut: too long');
  });
});

describe('suite leaderboard', () => {
  const a = (state: LaneState, ms: number, extra: Partial<Lane> = {}) => lane('a', state, ms, extra);
  const b = (state: LaneState, ms: number, extra: Partial<Lane> = {}) => lane('b', state, ms, extra);

  it('ranks by tasks finished, then wins, then time', () => {
    const rows = leaderboard([race([a('finished', 5000), b('finished', 3000)]), race([a('finished', 4000), b('failed', 1000)])]);
    expect(rows.map((r) => r.agentName)).toEqual(['Agent a', 'Agent b']);
    expect(rows[0]).toMatchObject({ finished: 2, attempted: 2, wins: 1, finishedMs: 9000, avgPlace: 1.5 });
    expect(rows[1]).toMatchObject({ finished: 1, attempted: 2, wins: 1, finishedMs: 3000, avgPlace: 1.5 });
  });

  it('ignores tasks that have not ended and tasks not started', () => {
    const rows = leaderboard([race([a('finished', 5000), b('finished', 3000)]), race([a('running', 100), b('finished', 50)]), null]);
    expect(rows.every((r) => r.attempted === 1)).toBe(true);
  });

  it('is honest about cost: missing stays missing, partial is flagged, estimates are flagged', () => {
    const m = (usd: number | null, source?: 'reported' | 'estimated') => ({ metrics: { ...emptyMetrics(), time: { ...emptyMetrics().time, wallMs: 1000 }, cost: cost(usd, source ?? (usd === null ? null : 'reported')) } });
    const rows = leaderboard([
      race([a('finished', 1000, m(0.1)), b('finished', 1000, m(null))]),
      race([a('finished', 1000, m(null)), b('finished', 1000, m(null))]),
      race([a('finished', 1000, m(0.2, 'estimated')), b('finished', 1000, m(null))]),
    ]);
    const ra = rows.find((r) => r.agentName === 'Agent a')!;
    const rb = rows.find((r) => r.agentName === 'Agent b')!;
    expect(ra.costUsd).toBeCloseTo(0.3);
    expect(ra).toMatchObject({ costIncomplete: true, costEstimated: true });
    expect(rb).toMatchObject({ costUsd: null, costIncomplete: false, costEstimated: false });
  });

  it('averages judge scores only over judged tasks', () => {
    const j = (score: number) => ({ judge: { score, summary: '', strengths: [], problems: [], judgeAgent: 'J', judgeModel: null, at: 0 } });
    const rows = leaderboard([race([a('finished', 1, j(8)), b('finished', 2)]), race([a('finished', 1, j(6)), b('finished', 2)])]);
    expect(rows.find((r) => r.agentName === 'Agent a')!.judgeAvg).toBe(7);
    expect(rows.find((r) => r.agentName === 'Agent b')!.judgeAvg).toBeNull();
  });
});

describe('replay export', () => {
  const feeds = {
    a: [
      { seq: 0, t: 0, type: 'system' as const, text: 'Model: secret-model-9' },
      { seq: 1, t: 500, type: 'message' as const, text: 'Writing </script><script>alert(1)</script> now' },
      { seq: 2, t: 900, type: 'tool' as const, text: '', tool: { kind: 'edit' as const, name: 'write', target: 'index.html', status: 'ok' as const, durationMs: 120, exitCode: null, output: 'x'.repeat(5000) } },
    ],
  };

  it('is one self-contained page with the race inside it', () => {
    const html = buildReplay(race([lane('a', 'finished', 2000)]), feeds);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('build a thing');
    expect(html).toContain('Agent a');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/); // nothing loaded from anywhere
    expect(html).not.toContain('x'.repeat(1000)); // tool output is left out
  });

  it('cannot be broken out of by text an agent wrote', () => {
    const html = buildReplay(race([lane('a', 'finished', 2000)]), feeds);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<script>alert(1)');
  });

  it('keeps a blind race blind until it has been voted on', () => {
    const blind = buildReplay(race([lane('a', 'finished', 2000)], { blind: true }), feeds);
    expect(blind).toContain('Agent A');
    expect(blind).not.toContain('Agent a');
    expect(blind).not.toContain('secret-model-9');
    const revealed = buildReplay(race([lane('a', 'finished', 2000)], { blind: true, vote: { laneId: 'a', at: 1 } }), feeds);
    expect(revealed).toContain('Agent a');
  });
});

describe('metrics across follow-up rounds', () => {
  const extra = () => ({ filesChangedLive: 0, code: null, outcome: emptyMetrics().outcome });

  it('adds a second run\'s totals to the first, though each CLI run reports from zero', () => {
    const t = new MetricsTracker({}, '');
    t.onEvent({ type: 'turn' }, 0);
    t.onEvent({ type: 'usage', mode: 'total', usage: { input: 100, output: 50 } }, 100);
    t.onEvent({ type: 'cost', usd: 0.1 }, 100);
    t.onEvent({ type: 'result', ok: true, turns: 3 }, 100);
    t.end(1000);
    t.resume();
    t.onEvent({ type: 'usage', mode: 'total', usage: { input: 10, output: 5 } }, 1500);
    t.onEvent({ type: 'cost', usd: 0.02 }, 1500);
    t.onEvent({ type: 'result', ok: true, turns: 2 }, 1500);
    t.end(2500);
    const m = t.snapshot(9999, extra());
    expect(m.tokens).toMatchObject({ input: 110, output: 55 });
    expect(m.cost.usd).toBeCloseTo(0.12);
    expect(m.activity.turns).toBe(5);
    expect(m.time.wallMs).toBe(2500);
  });

  it('can be rebuilt from saved metrics after a restart and carry on', () => {
    const first = new MetricsTracker({}, 'm');
    first.onEvent({ type: 'tool_start', id: 'a', kind: 'command', name: 'sh', target: 'x' }, 100);
    first.onEvent({ type: 'tool_end', id: 'a', ok: false }, 600);
    first.onEvent({ type: 'usage', mode: 'total', usage: { input: 100, output: 50 } }, 700);
    first.onEvent({ type: 'cost', usd: 0.1 }, 700);
    first.end(1000);
    const saved = first.snapshot(1000, extra());

    const t = MetricsTracker.restore({}, 'm', saved);
    t.resume();
    t.onEvent({ type: 'tool_start', id: 'a', kind: 'edit', name: 'w', target: 'y' }, 1200);
    t.onEvent({ type: 'tool_end', id: 'a', ok: true }, 1300);
    t.onEvent({ type: 'usage', mode: 'total', usage: { input: 10, output: 5 } }, 1400);
    t.onEvent({ type: 'cost', usd: 0.05 }, 1400);
    t.end(2000);
    const m = t.snapshot(2000, extra());
    expect(m.tokens).toMatchObject({ input: 110, output: 55 });
    expect(m.cost.usd).toBeCloseTo(0.15);
    expect(m.activity).toMatchObject({ toolCalls: 2, commands: 1, commandsFailed: 1 });
    expect(m.time).toMatchObject({ wallMs: 2000, toolMs: 600, commandMs: 500 });
  });
});
