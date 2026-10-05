import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CopilotParser } from '../src/server/adapters/copilot.js';
import { OpenCodeParser } from '../src/server/adapters/opencode.js';
import type { AgentEvent, EventParser } from '../src/server/adapters/types.js';
import { MetricsTracker } from '../src/server/race/metrics.js';
import { emptyMetrics } from '../src/shared/types.js';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n');
const replay = (parser: EventParser, lines: string[]) => lines.flatMap((line) => parser.parse(line, 'stdout'));
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

describe('OpenCode parser (recorded output)', () => {
  const events = replay(new OpenCodeParser('/ws'), fixture('opencode.jsonl'));

  it('reads the session id, which follow-up rounds need', () => {
    expect(of(events, 'init')).toHaveLength(1);
    expect(of(events, 'init')[0]!.sessionId).toMatch(/^ses_/);
  });

  it('maps tool calls, with workspace-relative paths and the real exit code', () => {
    expect(of(events, 'tool_start').map((e) => [e.kind, e.name, e.target])).toEqual([
      ['edit', 'write', 'hello.txt'],
      ['command', 'bash', 'cat hello.txt; ls nonexistent-dir'],
    ]);
    const ends = of(events, 'tool_end');
    expect(ends[0]).toMatchObject({ ok: true });
    expect(ends[1]).toMatchObject({ ok: false, exitCode: 1 });
    expect(ends[1]!.output).toContain('No such file or directory');
  });

  it('uses the CLI\'s own timings for tools it only reports once they are done', () => {
    const starts = of(events, 'tool_start');
    expect(starts[0]!.agoMs).toBe(13);
    expect(starts[1]!.agoMs).toBe(53);
  });

  it('adds up tokens per step and reports the cost the CLI gives', () => {
    const usage = of(events, 'usage');
    expect(usage).toHaveLength(3);
    expect(usage.every((u) => u.mode === 'add')).toBe(true);
    // Feed it the way the engine does: every event from one line of output shares that line's time.
    const t = new MetricsTracker({}, '');
    const parser = new OpenCodeParser('/ws');
    fixture('opencode.jsonl').forEach((line, i) => parser.parse(line, 'stdout').forEach((ev) => t.onEvent(ev, (i + 1) * 500)));
    t.end(5000);
    const m = t.snapshot(5000, { filesChangedLive: 0, code: null, outcome: emptyMetrics().outcome });
    expect(m.tokens).toEqual({ input: 9202 + 9258 + 124, output: 93 + 96 + 24, cacheRead: 1939 + 1941 + 11199, cacheWrite: 0, reasoning: 0 });
    expect(m.cost).toEqual({ usd: 0, source: 'reported' }); // a free model: the CLI really did report $0
    expect(m.activity).toMatchObject({ turns: 3, toolCalls: 2, commands: 1, commandsFailed: 1 });
    expect(m.time.commandMs).toBe(53);
    expect(m.model).toBeNull(); // OpenCode does not name the model in its stream
  });

  it('ends with the final message and a successful result', () => {
    expect(of(events, 'message').at(-1)!.text).toContain('Created hello.txt');
    expect(of(events, 'result')).toEqual([{ type: 'result', ok: true }]);
  });

  it('turns an error event into a failed result', () => {
    const out = new OpenCodeParser('/ws').parse('{"type":"error","sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Unexpected server error."}}}', 'stdout');
    expect(of(out, 'error')[0]!.message).toBe('Unexpected server error.');
    expect(of(out, 'result')[0]).toMatchObject({ ok: false });
  });
});

describe('Copilot CLI parser (recorded output)', () => {
  const events = replay(new CopilotParser('/ws'), fixture('copilot.jsonl'));

  it('reads the model Copilot picked', () => {
    expect(of(events, 'init').find((e) => e.model)!.model).toBe('mai-code-1.1-flash');
  });

  it('announces a tool while its call is still being written, then starts it', () => {
    const starts = of(events, 'tool_start');
    expect(starts.filter((e) => e.pending).length).toBeGreaterThanOrEqual(1);
    const real = starts.filter((e) => !e.pending);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ kind: 'command', name: 'bash' });
    expect(real[0]!.target).toContain('cat hello.txt');
  });

  it('marks the command as failed with its exit code', () => {
    expect(of(events, 'tool_end')).toEqual([expect.objectContaining({ ok: false, exitCode: 1 })]);
  });

  it('streams the reply once, without repeating it', () => {
    expect(of(events, 'message').map((m) => m.text).join('')).toBe('Done.');
  });

  it('reports no tokens and no cost, because Copilot gives neither', () => {
    expect(of(events, 'usage')).toEqual([]);
    expect(of(events, 'cost')).toEqual([]);
    expect(of(events, 'system')[0]!.text).toMatch(/1 premium request/);
    expect(of(events, 'result')[0]).toMatchObject({ ok: true });
    expect(of(events, 'init').some((e) => e.sessionId)).toBe(true);
  });

  it('counts turns', () => {
    expect(of(events, 'turn')).toHaveLength(2);
  });
});
