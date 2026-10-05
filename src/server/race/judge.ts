import fs from 'node:fs';
import type { JudgeVerdict, LaneDiff, LaneState } from '../../shared/types.js';
import type { AgentAdapter } from '../adapters/types.js';
import { childEnv, killTree, spawnGroup, trackProcess, untrackProcess } from '../proc.js';
import { wrap, type SandboxStatus } from '../sandbox.js';

/**
 * The AI judge. One agent is asked for its opinion of a lane's result. It is
 * given the task and the changes, and never told which agent made them.
 *
 * A verdict is an opinion. It is stored and shown separately from the
 * measurements and never affects the default ranking.
 */

const JUDGE_TIMEOUT = 6 * 60_000;
const MAX_DIFF_CHARS = 60_000;

export interface JudgeInput {
  adapter: AgentAdapter;
  exe: string;
  model: string;
  sandbox: SandboxStatus;
  /** An empty folder the judge runs in; it gets nothing but the prompt. */
  scratch: string;
  task: string;
  rounds: string[];
  diff: LaneDiff;
  endedAs: LaneState;
}

export function judgePrompt(input: Pick<JudgeInput, 'task' | 'rounds' | 'diff' | 'endedAs'>): string {
  let budget = MAX_DIFF_CHARS;
  const files = input.diff.files.map((f) => {
    const head = `### ${f.path} (${f.status}, +${f.added} -${f.removed})`;
    if (f.binary) return `${head}\n(binary file)`;
    const patch = f.patch.length > budget ? `${f.patch.slice(0, Math.max(0, budget))}\n… (cut: too long to include in full)` : f.patch;
    budget = Math.max(0, budget - patch.length);
    return `${head}\n${patch}`;
  });
  const followUps = input.rounds.length ? `\n\nFollow-up requests given afterwards, in order:\n${input.rounds.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : '';
  const ended =
    input.endedAs === 'finished' ? 'The author reported that it finished.' : `Note: the author did not finish normally (it ended as "${input.endedAs.replace('_', ' ')}"), so the work may be incomplete.`;
  return `You are reviewing one solution to a coding task. Do not create, edit or run anything, and do not ask questions: read what is below and give your verdict.

## The task
${input.task}${followUps}

## What the author changed
${ended}
${files.length ? files.join('\n\n') : '(no files were changed)'}

## Your verdict
Judge how well this solves the task: does it do what was asked, would it work, how complete and how well made is it. Ignore how long it took or what it cost.

Reply with one JSON object and nothing else, in exactly this shape:
{"score": <whole number from 1 (poor) to 10 (excellent)>, "summary": "<one or two sentences>", "strengths": ["<short point>", ...], "problems": ["<short point>", ...]}`;
}

/** Find the verdict in whatever the judge wrote. Throws when there is none. */
export function parseVerdict(text: string): Pick<JudgeVerdict, 'score' | 'summary' | 'strengths' | 'problems'> {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!);
  // Every balanced {...} block, last first: the verdict is normally the final thing written.
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') starts.push(i);
    else if (text[i] === '}' && starts.length) {
      const start = starts.pop()!;
      if (starts.length === 0) candidates.push(text.slice(start, i + 1));
    }
  }
  for (const raw of candidates.reverse()) {
    let v: any;
    try {
      v = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const score = Number(v?.score);
    if (!v || typeof v !== 'object' || !Number.isFinite(score)) continue;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((i) => typeof i === 'string' && i.trim()).map((i) => String(i).trim().slice(0, 300)).slice(0, 8) : []);
    return {
      score: Math.min(10, Math.max(1, Math.round(score))),
      summary: typeof v.summary === 'string' ? v.summary.trim().slice(0, 800) : '',
      strengths: list(v.strengths),
      problems: list(v.problems),
    };
  }
  throw new Error('the judge did not return a verdict in the expected form');
}

/** Run the judge once for one lane and return its verdict. */
export function judgeLane(input: JudgeInput): Promise<JudgeVerdict> {
  return new Promise((resolve, reject) => {
    fs.rmSync(input.scratch, { recursive: true, force: true });
    fs.mkdirSync(input.scratch, { recursive: true });
    const ctx = {
      exe: input.exe,
      prompt: judgePrompt(input),
      workspace: input.scratch,
      model: input.model,
      // The mock agents use this to return their scripted verdict.
      options: { scenario: 'judge' },
      effort: '',
    };
    let spec;
    try {
      spec = input.adapter.start(ctx);
    } catch (e) {
      return reject(e);
    }
    const parser = input.adapter.createParser(ctx);
    const sandboxed = !input.adapter.ownSandbox && input.sandbox.kind !== 'none';
    const w = sandboxed
      ? wrap(input.sandbox, spec.command, spec.args, { workspace: input.scratch, writable: input.adapter.writablePaths?.() ?? [] })
      : { command: spec.command, args: spec.args };
    const child = spawnGroup(w.command, w.args, { cwd: input.scratch, env: childEnv(spec.env ?? {}), stdio: ['pipe', 'pipe', 'pipe'] });
    trackProcess(child.pid, `judge ${input.scratch}`);
    child.stdin?.on('error', () => {});
    child.stdin?.end(spec.stdin ?? '');

    // Streamed text arrives in pieces keyed by id; keep the pieces in order.
    const pieces = new Map<string, string>();
    let anonymous = 0;
    let resultText = '';
    let model: string | null = null;
    let lastError = '';
    const onLine = (line: string, stream: 'stdout' | 'stderr') => {
      let events;
      try {
        events = parser.parse(line, stream);
      } catch {
        return;
      }
      for (const ev of events) {
        if (ev.type === 'message') {
          const key = ev.id ?? `m${anonymous++}`;
          pieces.set(key, ev.delta ? (pieces.get(key) ?? '') + ev.text : ev.text);
        } else if (ev.type === 'result' && ev.text) resultText = ev.text;
        else if (ev.type === 'init' && ev.model) model = ev.model;
        else if (ev.type === 'error') lastError = ev.message;
        else if (ev.type === 'raw') pieces.set(`raw${anonymous++}`, `${ev.text}\n`);
      }
    };
    const reader = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          onLine(buffer.slice(0, nl).replace(/\r$/, ''), stream);
          buffer = buffer.slice(nl + 1);
        }
      };
    };
    child.stdout?.on('data', reader('stdout'));
    child.stderr?.on('data', reader('stderr'));

    const timer = setTimeout(() => {
      lastError = 'the judge took too long';
      if (child.pid) killTree(child.pid, 'SIGKILL');
    }, JUDGE_TIMEOUT);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackProcess(child.pid);
      fs.rmSync(input.scratch, { recursive: true, force: true });
      if (error) return reject(error);
      try {
        const verdict = parseVerdict(`${[...pieces.values()].join('\n')}\n${resultText}`);
        resolve({ ...verdict, judgeAgent: input.adapter.name, judgeModel: model ?? (input.model || null), at: Date.now() });
      } catch (e) {
        reject(new Error(lastError ? `${(e as Error).message} (${lastError.slice(0, 200)})` : (e as Error).message));
      }
    };
    child.on('error', (e) => finish(e));
    child.on('close', () => finish());
  });
}
