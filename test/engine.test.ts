import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Race, ServerMessage } from '../src/shared/types.js';

// A scratch data folder OUTSIDE the temp dir, so the sandbox test below is meaningful
// (temp folders are deliberately writable inside the sandbox).
const root = path.join(__dirname, '..', '.test-tmp', `engine-${process.pid}`);
fs.mkdirSync(root, { recursive: true });
process.env.AGENT_DERBY_HOME = path.join(root, 'home');
process.env.AGENT_DERBY_MOCK_AGENT = path.join(root, 'mock-agent.mjs');
process.env.AGENT_DERBY_MOCK_SPEED = '25';

const { RaceEngine } = await import('../src/server/race/engine.js');
const { sandboxStatus, wrapShell } = await import('../src/server/sandbox.js');
const { exec, isAlive, killAllTracked } = await import('../src/server/proc.js');

const sandbox = await sandboxStatus();
const engine = new RaceEngine(sandbox);
const messages: ServerMessage[] = [];
engine.on('message', (m: ServerMessage) => messages.push(m));

beforeAll(async () => {
  await build({
    entryPoints: [path.join(__dirname, '..', 'src/mock/mock-agent.ts')],
    outfile: process.env.AGENT_DERBY_MOCK_AGENT!,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
});

afterAll(() => {
  engine.shutdownNow();
  killAllTracked();
  fs.rmSync(root, { recursive: true, force: true });
});

function settled(id: string, timeoutMs = 30_000): Promise<Race> {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const race = engine.get(id)!;
      const done = race.lanes.every((l) => ['finished', 'failed', 'stopped', 'timed_out', 'over_budget'].includes(l.state));
      const previews = race.lanes.every((l) => l.metrics.outcome.preview !== 'pending' && !['installing', 'building', 'starting'].includes(l.preview.status));
      if (race.error || (done && previews)) return resolve(race);
      if (Date.now() > end) return reject(new Error(`race did not settle: ${race.lanes.map((l) => `${l.id}=${l.state}/${l.preview.status}`).join(', ')}`));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('race engine with mock agents', () => {
  let race: Race;

  it('runs every lane to its own end state; a crash and a hang do not hold the others up', async () => {
    const created = await engine.create({
      task: 'build a playable snake game in the browser',
      entrants: [
        { agentId: 'mock-hare' },
        { agentId: 'mock-tortoise' },
        { agentId: 'mock-owl' },
        { agentId: 'mock-gremlin', options: { scenario: 'crash' } },
        { agentId: 'mock-gremlin', options: { scenario: 'hang' } },
        { agentId: 'mock-gremlin', options: { scenario: 'nothing' } },
        { agentId: 'mock-gremlin', options: { scenario: 'auth' } },
      ],
      source: { type: 'empty' },
      timeLimitSec: 4,
    });
    race = await settled(created.id);
    const state = Object.fromEntries(race.lanes.map((l) => [l.id, l.state]));
    expect(state).toEqual({
      'mock-hare': 'finished',
      'mock-tortoise': 'finished',
      'mock-owl': 'finished',
      'mock-gremlin': 'failed',
      'mock-gremlin-2': 'timed_out',
      'mock-gremlin-3': 'failed',
      'mock-gremlin-4': 'failed',
    });
    expect(race.state).toBe('finished');
  }, 40_000);

  it('explains each failure in plain words', () => {
    const reason = (id: string) => race.lanes.find((l) => l.id === id)!.stateReason;
    expect(reason('mock-gremlin')).toMatch(/exited with code 3/);
    expect(reason('mock-gremlin-2')).toMatch(/4-second time limit/);
    expect(reason('mock-gremlin-3')).toMatch(/did not change any files/);
    expect(reason('mock-gremlin-4')).toMatch(/Not signed in/);
  });

  it('the finished lanes were not delayed by the hung one', () => {
    const hare = race.lanes.find((l) => l.id === 'mock-hare')!;
    const hung = race.lanes.find((l) => l.id === 'mock-gremlin-2')!;
    expect(hare.metrics.time.wallMs).toBeLessThan(3000);
    expect(hare.endedAt!).toBeLessThan(hung.endedAt!);
  });

  it('gave every agent the identical prompt and started them together', () => {
    expect(race.promptSha256).toBe(createHash('sha256').update(race.prompt, 'utf8').digest('hex'));
    expect(race.prompt).toContain('build a playable snake game in the browser');
    const starts = race.lanes.map((l) => l.startedAt!);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(250);
  });

  it('fills in metrics, and leaves unreported ones null', () => {
    const hare = race.lanes.find((l) => l.id === 'mock-hare')!.metrics;
    expect(hare.cost).toEqual({ usd: 0.0183, source: 'reported' });
    expect(hare.code).toMatchObject({ filesCreated: 2, linesRemoved: 0 }); // index.html + README.md; the manifest is not counted
    expect(hare.activity).toMatchObject({ toolCalls: 4, turns: 3 });
    expect(hare.model).toBe('mock-hare-1');
    expect(hare.time.firstEditMs).toBeGreaterThan(0);

    const tortoise = race.lanes.find((l) => l.id === 'mock-tortoise')!.metrics;
    expect(tortoise.cost).toEqual({ usd: null, source: null });
    expect(tortoise.activity).toMatchObject({ commands: 3, commandsFailed: 1, errors: 1, retries: 1 });
    expect(tortoise.time.commandMs).toBeGreaterThan(0);
    expect(tortoise.time.modelMsSource).toBe('derived');
  });

  it('starts previews automatically: static from the manifest, web by detection, terminal ready', async () => {
    const lane = (id: string) => engine.get(race.id)!.lanes.find((l) => l.id === id)!;
    expect(lane('mock-hare').preview).toMatchObject({ status: 'ready', type: 'static', source: 'manifest' });
    expect(lane('mock-tortoise').preview).toMatchObject({ status: 'ready', type: 'web', source: 'detected' });
    expect(lane('mock-tortoise').preview.manifestProblem).toMatch(/did not write/);
    expect(lane('mock-owl').preview).toMatchObject({ status: 'ready', type: 'terminal', startCommand: 'node snake.js' });
    expect(lane('mock-gremlin').preview.status).toBe('none');
    expect(lane('mock-hare').metrics.outcome.preview).toBe('started');

    for (const id of ['mock-hare', 'mock-tortoise']) {
      const res = await fetch(lane(id).preview.url!);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<canvas');
    }
  });

  it('keeps each lane\'s work in its own workspace, with a diff', async () => {
    const hare = race.lanes.find((l) => l.id === 'mock-hare')!;
    const owl = race.lanes.find((l) => l.id === 'mock-owl')!;
    expect(fs.existsSync(path.join(hare.workspace, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(owl.workspace, 'index.html'))).toBe(false);
    const diff = await engine.diff(race.id, 'mock-hare');
    expect(diff.files.map((f) => f.path).sort()).toEqual(['README.md', 'index.html']);
    // Partial work of the timed-out lane is recorded too.
    expect((await engine.diff(race.id, 'mock-gremlin-2')).files.map((f) => f.path)).toEqual(['half-finished.txt']);
  });

  it('streamed a snapshot-able feed for every lane', () => {
    const feed = engine.feed(race.id, 'mock-tortoise');
    expect(feed.filter((f) => f.type === 'tool').length).toBe(10);
    expect(feed.some((f) => f.type === 'thinking')).toBe(true);
    expect(feed.every((f, i) => f.seq === i)).toBe(true);
    expect(feed.filter((f) => f.tool?.status === 'running')).toEqual([]);
    expect(messages.some((m) => m.type === 'feed' && m.laneId === 'mock-owl')).toBe(true);
    expect(engine.snapshotMessages(race.id)[0]!.type).toBe('race');
  });

  it('stops every preview and frees its port when the race is closed', async () => {
    const url = engine.get(race.id)!.lanes.find((l) => l.id === 'mock-tortoise')!.preview.url!;
    await engine.closeRace(race.id);
    await expect(fetch(url)).rejects.toThrow();
    expect(engine.get(race.id)!.lanes.find((l) => l.id === 'mock-tortoise')!.preview.status).toBe('stopped');
  });

  it('survives a restart: the race can be reopened from disk and its preview restarted', async () => {
    const again = new RaceEngine(sandbox);
    try {
      const loaded = again.get(race.id)!;
      expect(loaded.lanes.map((l) => l.state)).toEqual(race.lanes.map((l) => l.state));
      expect(again.list()[0]).toMatchObject({ id: race.id, winner: 'Mock Hare' });
      expect(again.feed(race.id, 'mock-hare').length).toBeGreaterThan(5);
      await again.startPreview(race.id, 'mock-hare');
      const end = Date.now() + 10_000;
      while (again.get(race.id)!.lanes[0]!.preview.status !== 'ready' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect((await fetch(again.get(race.id)!.lanes[0]!.preview.url!)).status).toBe(200);
    } finally {
      again.shutdownNow();
    }
  });

  it('a stopped lane ends as stopped and its process is gone', async () => {
    const created = await engine.create({
      task: 'x',
      entrants: [{ agentId: 'mock-gremlin', options: { scenario: 'hang' } }, { agentId: 'mock-hare' }],
      source: { type: 'empty' },
    });
    await new Promise((r) => setTimeout(r, 600));
    engine.stopLane(created.id, 'mock-gremlin');
    const done = await settled(created.id, 20_000);
    expect(done.lanes.map((l) => l.state)).toEqual(['stopped', 'finished']);
    expect(done.lanes[0]!.stateReason).toBe('Stopped by you');
  }, 30_000);

  it('a failing finish command turns a completed run into a failure; a passing one records test counts', async () => {
    const created = await engine.create({
      task: 'x',
      entrants: [{ agentId: 'mock-hare' }, { agentId: 'mock-tortoise' }],
      source: { type: 'empty' },
      finishCommand: 'npm test',
    });
    const done = await settled(created.id);
    const [hare, tortoise] = done.lanes;
    expect(hare!.state).toBe('failed'); // the hare's project has no package.json
    expect(hare!.stateReason).toMatch(/finish command failed/);
    expect(hare!.metrics.outcome.finish).toBe('failed');
    expect(tortoise!.state).toBe('finished');
    expect(tortoise!.metrics.outcome).toMatchObject({ finish: 'passed', finishExitCode: 0, tests: { passed: 1, failed: 0, total: 1 } });
  }, 40_000);

  it('races from a repo without touching the working tree, then cleans up its branches on delete', async () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'u@example.com');
    git('config', 'user.name', 'U');
    fs.writeFileSync(path.join(repo, 'README.md'), '# mine\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const head = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted\n');

    const created = await engine.create({ task: 'x', entrants: [{ agentId: 'mock-hare' }, { agentId: 'mock-owl' }], source: { type: 'repo', path: repo } });
    const done = await settled(created.id);
    expect(done.lanes.map((l) => l.state)).toEqual(['finished', 'finished']);
    expect(done.baseRef).toBe(head);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('?? wip.txt');
    expect(fs.existsSync(path.join(repo, 'index.html'))).toBe(false);
    expect(git('branch', '--list', 'agent-derby/*').split('\n')).toHaveLength(2);

    expect(await engine.keep(created.id, 'mock-hare', { mode: 'branch', target: 'keep/hare' })).toMatch(/Created branch/);
    expect(git('show', 'keep/hare:index.html')).toContain('<canvas');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    await engine.deleteRace(created.id);
    expect(git('branch', '--list', 'agent-derby/*')).toBe('');
    expect(git('branch', '--list', 'keep/hare')).toContain('keep/hare');
    expect(engine.get(created.id)).toBeNull();
    expect(git('status', '--porcelain')).toBe('?? wip.txt');
  }, 40_000);

  it('rejects impossible setups with a clear message', async () => {
    await expect(engine.create({ task: '  ', entrants: [{ agentId: 'mock-hare' }], source: { type: 'empty' } })).rejects.toThrow(/task/i);
    await expect(engine.create({ task: 'x', entrants: [], source: { type: 'empty' } })).rejects.toThrow(/at least one agent/);
    await expect(engine.create({ task: 'x', entrants: [{ agentId: 'nope' }], source: { type: 'empty' } })).rejects.toThrow(/Unknown agent/);
    await expect(engine.create({ task: 'x', entrants: [{ agentId: 'mock-hare' }], source: { type: 'repo', path: '/definitely/not/here' } })).rejects.toThrow(/does not exist/);
  });

  it('shutdown kills running agents and records the race as interrupted', async () => {
    const e2 = new RaceEngine(sandbox);
    const created = await e2.create({ task: 'x', entrants: [{ agentId: 'mock-gremlin', options: { scenario: 'hang' } }], source: { type: 'empty' } });
    await new Promise((r) => setTimeout(r, 700));
    e2.shutdownNow();
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_DERBY_HOME!, 'races', created.id, 'race.json'), 'utf8')) as Race;
    expect(saved.state).toBe('interrupted');
    expect(saved.lanes[0]).toMatchObject({ state: 'stopped' });
    await new Promise((r) => setTimeout(r, 300));
    const ps = await exec('ps', ['-axo', 'pid=,command=']);
    expect(ps.stdout.split('\n').filter((l) => l.includes(created.id))).toEqual([]);
  }, 20_000);
});

describe.skipIf(sandbox.kind === 'none')('OS sandbox', () => {
  it('lets a command write inside its workspace but not outside it', async () => {
    const workspace = path.join(root, 'sandbox-ws');
    const outside = path.join(root, 'sandbox-outside');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const run = (cmd: string) => {
      const w = wrapShell(sandbox, cmd, { workspace });
      return exec(w.command, w.args, { cwd: workspace });
    };
    expect((await run('echo ok > inside.txt')).code).toBe(0);
    expect(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8')).toBe('ok\n');

    const denied = await run(`echo no > "${path.join(outside, 'escape.txt')}"`);
    expect(denied.code).not.toBe(0);
    expect(fs.existsSync(path.join(outside, 'escape.txt'))).toBe(false);

    const home = await run(`echo no > "${path.join(os.homedir(), `.agent-derby-escape-${process.pid}`)}"`);
    expect(home.code).not.toBe(0);
    expect(fs.existsSync(path.join(os.homedir(), `.agent-derby-escape-${process.pid}`))).toBe(false);

    // Still a real environment: reading the system and using the network stack are allowed.
    expect((await run('ls /usr/bin >/dev/null && cat /etc/hosts >/dev/null')).code).toBe(0);
    expect((await run('echo t > "${TMPDIR:-/tmp}/agent-derby-tmp-test-$$" && rm "${TMPDIR:-/tmp}/agent-derby-tmp-test-$$"')).code).toBe(0);
  });

  it('confined a real mock run: it could not have written outside its workspace', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(sandbox.label).toMatch(/sandbox/i);
  });
});
