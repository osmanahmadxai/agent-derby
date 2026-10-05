import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeParser } from '../src/server/adapters/claude.js';
import { CodexParser } from '../src/server/adapters/codex.js';
import { fillArgs, validateCustom } from '../src/server/adapters/custom.js';
import { GeminiParser } from '../src/server/adapters/gemini.js';
import type { AgentEvent, EventParser } from '../src/server/adapters/types.js';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n');

function replay(parser: EventParser, lines: string[], stream: 'stdout' | 'stderr' = 'stdout'): AgentEvent[] {
  return lines.flatMap((line) => parser.parse(line, stream));
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

describe('Claude Code parser (recorded output)', () => {
  const events = replay(new ClaudeParser('/ws'), fixture('claude-stream.jsonl'));

  it('reads the model and CLI version from init', () => {
    expect(of(events, 'init')[0]).toMatchObject({ model: 'claude-haiku-4-5-20251001', cliVersion: '2.1.288' });
  });

  it('reports each tool call once it is complete, with a workspace-relative target', () => {
    const real = of(events, 'tool_start').filter((e) => !e.pending);
    expect(real.map((e) => [e.kind, e.name, e.target])).toEqual([
      ['edit', 'Write', 'hello.txt'],
      ['command', 'Bash', 'cat hello.txt && ls nonexistent-dir'],
    ]);
  });

  it('announces a tool call as pending while the model is still writing it', () => {
    const pending = of(events, 'tool_start').filter((e) => e.pending);
    // announced once without a target, then again as soon as the file or command is known
    expect(pending.map((e) => [e.name, e.target])).toEqual([
      ['Write', null],
      ['Write', 'hello.txt'],
      ['Bash', null],
      ['Bash', 'cat hello.txt && ls nonexistent-dir'],
    ]);
    // pending always comes before the real start of the same call
    for (const p of pending) {
      const realIndex = events.findIndex((e) => e.type === 'tool_start' && !e.pending && e.id === p.id);
      expect(realIndex).toBeGreaterThan(events.indexOf(p));
    }
  });

  it('marks the failed command as failed with its exit code', () => {
    const ends = of(events, 'tool_end');
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ ok: true });
    expect(ends[1]).toMatchObject({ ok: false, exitCode: 1 });
    expect(ends[1]!.output).toContain('No such file or directory');
  });

  it('streams assistant text as deltas and does not repeat it', () => {
    const text = of(events, 'message').map((e) => e.text).join('');
    expect(text).toBe("The file was created and read successfully, while the ls command failed as expected because the directory doesn't exist.");
    expect(of(events, 'message').every((e) => e.delta)).toBe(true);
  });

  it('passes on the running thinking estimate when the reasoning text is hidden', () => {
    const meters = of(events, 'thinking_active').filter((e) => typeof e.tokens === 'number');
    expect(meters.map((e) => e.tokens)).toEqual([50, 144, 50, 135]);
    // two separate thinks, so two separate progress lines
    expect(new Set(meters.map((e) => e.id)).size).toBe(2);
    expect(of(events, 'thinking')).toEqual([]); // this recording exposes no reasoning text at all
  });

  it('counts one turn per model round-trip', () => {
    expect(of(events, 'turn')).toHaveLength(2);
  });

  it('takes final usage and cost from the result event', () => {
    const usage = of(events, 'usage').at(-1)!;
    expect(usage.mode).toBe('total');
    expect(usage.usage).toEqual({ input: 945, output: 392, cacheRead: 53016, cacheWrite: 8744, reasoning: 139 });
    expect(of(events, 'cost').at(-1)!.usd).toBeCloseTo(0.0256946, 7);
    expect(of(events, 'result')[0]).toMatchObject({ ok: true, turns: 3 });
  });

  it('reports live usage before the result arrives', () => {
    const firstResult = events.findIndex((e) => e.type === 'result');
    const live = events.slice(0, firstResult).filter((e) => e.type === 'usage');
    expect(live.length).toBeGreaterThan(2);
  });

  it('never throws on garbage and keeps unknown lines visible', () => {
    const p = new ClaudeParser('/ws');
    expect(p.parse('{not json', 'stdout')).toEqual([{ type: 'raw', text: '{not json' }]);
    expect(p.parse('', 'stdout')).toEqual([]);
    expect(p.parse('{"type":"assistant","message":null}', 'stdout')).toEqual([]);
    expect(p.parse('Not logged in · Please run /login', 'stderr')[0]).toMatchObject({ type: 'error', kind: 'auth' });
  });

  it('turns an error result into a failed result with an auth hint', () => {
    const p = new ClaudeParser('/ws');
    const out = p.parse(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }), 'stdout');
    expect(of(out, 'result')[0]).toMatchObject({ ok: false });
    expect(of(out, 'error')[0]).toMatchObject({ kind: 'auth' });
  });
});

describe('Codex CLI parser', () => {
  it('recorded: not signed in becomes retries, an auth error and a failed result', () => {
    const events = replay(new CodexParser('/ws'), fixture('codex-not-logged-in.jsonl'));
    expect(of(events, 'init')).toHaveLength(1);
    const errors = of(events, 'error');
    expect(errors.length).toBeGreaterThan(5);
    expect(errors.filter((e) => e.retry).length).toBeGreaterThan(4);
    expect(errors.every((e) => e.kind === 'auth')).toBe(true);
    expect(of(events, 'result')).toEqual([expect.objectContaining({ ok: false })]);
  });

  it('ignores the duplicate transport log lines on stderr', () => {
    const p = new CodexParser('/ws');
    expect(p.parse('2026-10-05T05:10:26.289960Z ERROR codex_api::endpoint: failed to connect', 'stderr')).toEqual([]);
  });

  const events = replay(new CodexParser('/ws'), fixture('codex-success.synthetic.jsonl'));

  it('synthetic: maps items to tool calls', () => {
    const starts = of(events, 'tool_start');
    expect(starts.map((e) => [e.kind, e.target])).toEqual([
      ['command', 'ls -la'],
      ['plan', '0/2 steps done'],
      ['edit', 'index.html, agent-derby.json'],
      ['command', 'npm test'],
      ['web', 'canvas snake game loop'],
    ]);
    const ends = of(events, 'tool_end');
    expect(ends.find((e) => e.id === 'item_4')).toMatchObject({ ok: false, exitCode: 1 });
    expect(ends.find((e) => e.id === 'item_1')).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('synthetic: separates cached from uncached input tokens', () => {
    expect(of(events, 'usage')[0]).toEqual({
      type: 'usage',
      mode: 'add',
      usage: { input: 315, cacheRead: 24448, cacheWrite: 0, output: 1220, reasoning: 640 },
    });
  });

  it('synthetic: reasoning and the final message come through', () => {
    expect(of(events, 'thinking')[0]!.text).toContain('Planning');
    expect(of(events, 'message')[0]!.text).toBe('Built a snake game in index.html.');
    expect(of(events, 'result')[0]).toMatchObject({ ok: true });
  });

  it('reports no cost: Codex does not print one', () => {
    expect(of(events, 'cost')).toEqual([]);
  });
});

describe('Gemini CLI parser', () => {
  it('recorded: the not-signed-in message on stderr is an auth error', () => {
    const events = replay(new GeminiParser('/ws'), fixture('gemini-not-logged-in.stderr.txt'), 'stderr');
    expect(events).toEqual([expect.objectContaining({ type: 'error', kind: 'auth' })]);
  });

  const events = replay(new GeminiParser('/ws'), fixture('gemini-success.synthetic.jsonl'));

  it('synthetic: init, tools and results', () => {
    expect(of(events, 'init')[0]).toMatchObject({ model: 'gemini-2.5-pro' });
    expect(of(events, 'tool_start').map((e) => [e.kind, e.name, e.target])).toEqual([
      ['edit', 'write_file', 'index.html'],
      ['command', 'run_shell_command', 'node --check game.js'],
    ]);
    expect(of(events, 'tool_end').map((e) => e.ok)).toEqual([true, false]);
    expect(of(events, 'tool_end')[1]).toMatchObject({ exitCode: 1 });
  });

  it('synthetic: assistant text is grouped into one item per stretch between tools', () => {
    const msgs = of(events, 'message');
    expect(msgs.map((m) => m.id)).toEqual(['m0', 'm0', 'm2']);
    expect(msgs.every((m) => m.delta)).toBe(true);
    // the user's own prompt is not echoed into the feed
    expect(msgs.some((m) => m.text.includes('build a playable'))).toBe(false);
  });

  it('synthetic: usage from result stats, with nothing invented', () => {
    const usage = of(events, 'usage')[0]!;
    expect(usage.usage).toEqual({ input: 5000, cacheRead: 9000, output: 1234 });
    expect(usage.usage).not.toHaveProperty('reasoning');
    expect(of(events, 'cost')).toEqual([]);
    expect(of(events, 'result')[0]).toMatchObject({ ok: true });
  });

  it('synthetic: warnings count as retries', () => {
    expect(of(events, 'error')[0]).toMatchObject({ retry: true });
  });
});

describe('custom agents', () => {
  it('fills placeholders and drops an empty model flag', () => {
    const args = ['run', '--model', '{model}', '--cwd', '{workspace}', '{prompt}'];
    expect(fillArgs(args, { prompt: 'do it', model: '', workspace: '/w' })).toEqual(['run', '--cwd', '/w', 'do it']);
    expect(fillArgs(args, { prompt: 'do it', model: 'x1', workspace: '/w' })).toEqual(['run', '--model', 'x1', '--cwd', '/w', 'do it']);
  });

  it('keeps the prompt byte-exact, including shell metacharacters', () => {
    const prompt = 'a "quoted" $HOME `tick`\nsecond line; rm -rf /';
    expect(fillArgs(['{prompt}'], { prompt, model: '', workspace: '/w' })).toEqual([prompt]);
  });

  it('validates configurations', () => {
    expect(validateCustom({ name: 'X', command: 'x', args: ['{prompt}'], promptVia: 'arg', format: 'text' })).toBeNull();
    expect(validateCustom({ name: 'X', command: 'x', args: [], promptVia: 'arg', format: 'text' })).toMatch(/\{prompt\}/);
    expect(validateCustom({ name: '', command: 'x', args: [], promptVia: 'stdin', format: 'text' })).toMatch(/name/);
  });
});
