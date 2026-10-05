import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { WebSocket } from 'ws';
import { isTerminal, rankLanes, totalTokens, type AgentInfo, type Entrant, type Race, type RaceSetup, type ServerMessage } from './shared/types.js';
import { describeAgents, getAdapter, installAgent, detectCached } from './server/adapters/index.js';
import { startApp, type App } from './server/http.js';
import { APP_VERSION, readJson, runDir } from './server/paths.js';
import { childEnv, isAlive, isWindows, killAllTracked } from './server/proc.js';
import { RaceEngine } from './server/race/engine.js';
import { sandboxStatus } from './server/sandbox.js';
import { fmtCost, fmtDuration, fmtTokens, plainReporter, Tui, type RaceSource } from './tui/tui.js';

const DEFAULT_PORT = 4747;

const HELP = `agent-derby ${APP_VERSION} — race AI coding agents on the same task

Usage
  agent-derby                         start the app and open it in the browser
  agent-derby run [task]              race in the terminal, one pane per agent
                                     (no task: asks you everything interactively)
  agent-derby agents                  list agents, versions and sign-in state
  agent-derby install <agent>         install an agent's official CLI for Agent Derby
  agent-derby login <agent>           run an agent's own sign-in
  agent-derby history                 list past races
  agent-derby show <race>             print a past race's results
  agent-derby watch <race>            attach the terminal view to a race in the running app
  agent-derby suite <file>           run every task in a file (one per line) and print a leaderboard
  agent-derby followup <race> <text> send the same follow-up to every agent in a finished race
  agent-derby judge <race> --with <agent[:model]>   ask an AI judge for its opinion of each result
  agent-derby replay <race> [-o file.html]          save the race as one shareable web page
  agent-derby keep <race> <lane> --branch <name> | --folder <path>
  agent-derby delete <race>           delete a race, its workspaces and its branches

Options for "run"
  -a, --agents <list>    comma-separated, with an optional model after a colon and an
                         optional thinking effort after an @:
                         claude:opus@high,claude:sonnet,codex,copilot,opencode,mock-hare
      --blind            blind race: the app hides who is in which lane until you vote
  -r, --repo <path>      start from an existing git repo (default: an empty project)
  -f, --finish <cmd>     a lane only finishes successfully if this passes, e.g. "npm test"
  -t, --time <limit>     per-agent time limit: 90s, 10m, 1h
  -c, --cost <usd>       per-agent cost limit in USD
      --plain            line-by-line output instead of panes (default when piped)
      --json             print the final race as JSON
      --open             also open the race in the browser
      --exit             exit when the race ends instead of keeping previews running

General options
  -p, --port <n>         port for the local server (default ${DEFAULT_PORT})
      --no-open          do not open the browser
  -h, --help             show this help
  -v, --version          show the version

Data lives in ~/.agent-derby (override with AGENT_DERBY_HOME).`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const ALIASES: Record<string, string> = { a: 'agents', r: 'repo', f: 'finish', t: 'time', c: 'cost', p: 'port', h: 'help', v: 'version', o: 'out' };
const BOOLEAN = new Set(['plain', 'json', 'open', 'no-open', 'help', 'version', 'dev', 'exit', 'blind']);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      let [name, value] = a.replace(/^-+/, '').split('=', 2) as [string, string | undefined];
      name = ALIASES[name] ?? name;
      if (BOOLEAN.has(name)) out.flags[name] = true;
      else out.flags[name] = value ?? argv[++i] ?? '';
    } else out._.push(a);
  }
  return out;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : isWindows ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

function parseDuration(text: string): number {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) throw new Error(`Cannot read time limit "${text}". Use for example 90s, 10m or 1h.`);
  const unit = (m[2] ?? 'm').toLowerCase();
  return Math.round(Number(m[1]) * (unit === 's' ? 1 : unit === 'm' ? 60 : 3600));
}

function parseEntrants(list: string): Entrant[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // agent[:model][@effort]
      const at = s.lastIndexOf('@');
      const effort = at > 0 ? s.slice(at + 1) : '';
      const [agentId, ...model] = (at > 0 ? s.slice(0, at) : s).split(':');
      const entrant: Entrant = { agentId: agentId!, model: model.join(':'), effort };
      // "mock-gremlin:hang" picks the failure scenario rather than a model.
      if (agentId === 'mock-gremlin' && entrant.model) {
        entrant.options = { scenario: entrant.model };
        entrant.model = '';
      }
      return entrant;
    });
}

let app: App | null = null;
let shuttingDown = false;

function shutdown(code = 0): never {
  if (!shuttingDown) {
    shuttingDown = true;
    app?.close();
    killAllTracked();
  }
  process.exit(code);
}

function installExitHandlers(): void {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', (e) => {
    process.stderr.write(`\nagent-derby crashed: ${e.stack ?? e}\n`);
    shutdown(1);
  });
  // Last line of defence: never leave agents or previews running after we are gone.
  process.on('exit', () => {
    app?.close();
    killAllTracked();
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function serve(args: Args): Promise<void> {
  installExitHandlers();
  app = await startApp({ port: Number(args.flags.port) || DEFAULT_PORT, dev: Boolean(args.flags.dev), fallbackPort: !args.flags.port, idlePreviewStopMs: 120_000 });
  const sandbox = await sandboxStatus();
  console.log(`\n  Agent Derby ${APP_VERSION}\n  ${app.url}\n`);
  console.log(`  ${sandbox.label}`);
  if (app.recovered.races) console.log(`  Marked ${app.recovered.races} race(s) from a previous run as interrupted.`);
  if (app.recovered.processes.length) console.log(`  Stopped ${app.recovered.processes.length} process(es) left behind by a previous run.`);
  console.log('\n  Press Ctrl+C to stop. Prefer the terminal? Try: agent-derby run\n');
  if (!args.flags['no-open']) openBrowser(app.url);
}

function agentLine(a: AgentInfo): string {
  const status = !a.installed ? 'not installed' : a.auth === 'missing' ? 'not signed in' : a.auth === 'ok' ? 'ready' : 'installed';
  return `${a.id.padEnd(14)} ${a.name.padEnd(15)} ${(a.version ?? '-').padEnd(12)} ${status.padEnd(14)} ${a.installed ? (a.authDetail ?? '') : (a.installCommand ?? '')}`;
}

async function agents(): Promise<void> {
  const list = await describeAgents();
  console.log(`${'ID'.padEnd(14)} ${'AGENT'.padEnd(15)} ${'VERSION'.padEnd(12)} ${'STATUS'.padEnd(14)} DETAIL`);
  for (const a of list) console.log(agentLine(a));
  console.log(`\nModels: add one after a colon, e.g. --agents claude:opus,claude:fable`);
  for (const a of list.filter((x) => x.kind !== 'mock' && x.models.length > 1)) console.log(`  ${a.id}: ${a.models.filter(Boolean).join(', ')} (or any other model name)`);
  console.log(`\n${(await sandboxStatus()).label}`);
}

async function install(id: string | undefined): Promise<void> {
  const adapter = id ? getAdapter(id) : null;
  if (!adapter) throw new Error(`Unknown agent "${id ?? ''}". See: agent-derby agents`);
  const ok = await installAgent(adapter, (line) => console.log(`  ${line}`));
  if (!ok) process.exitCode = 1;
  else console.log(`\nNext: agent-derby login ${adapter.id}`);
}

async function login(id: string | undefined): Promise<void> {
  const adapter = id ? getAdapter(id) : null;
  if (!adapter) throw new Error(`Unknown agent "${id ?? ''}". See: agent-derby agents`);
  const det = await detectCached(adapter);
  if (!det.path) throw new Error(`${adapter.name} is not installed. Run: agent-derby install ${adapter.id}`);
  if (!adapter.login) throw new Error(`${adapter.name} has no sign-in command that Agent Derby knows about`);
  const l = adapter.login(det.path);
  console.log(`${l.hint}\n`);
  const r = spawnSync(l.command, l.args, { stdio: 'inherit', env: childEnv(l.env ?? {}) });
  process.exitCode = r.status ?? 1;
}

async function wizard(): Promise<RaceSetup> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nAgent Derby — set up a race\n');
    let task = '';
    while (!task) task = (await rl.question('Task for the agents (e.g. "Build a playable snake game in the browser"):\n> ')).trim();

    const list = await describeAgents();
    console.log('\nAgents:');
    list.forEach((a, i) => console.log(`  ${String(i + 1).padStart(2)}. ${agentLine(a)}`));
    const usable = (a: AgentInfo) => a.installed;
    let chosen: AgentInfo[] = [];
    while (chosen.length === 0) {
      const answer = await rl.question('\nWhich agents race? Numbers separated by commas; repeat a number to race one agent against itself with different models:\n> ');
      chosen = answer
        .split(/[\s,]+/)
        .map((n) => list[Number(n) - 1])
        .filter((a): a is AgentInfo => Boolean(a));
      const missing = chosen.filter((a) => !usable(a));
      if (missing.length) {
        console.log(`Not installed: ${missing.map((a) => a.name).join(', ')}. Install with: agent-derby install <id>`);
        chosen = [];
      }
    }
    const entrants: Entrant[] = [];
    for (const a of chosen) {
      if (a.kind === 'mock') {
        entrants.push({ agentId: a.id });
        continue;
      }
      const models = a.models.filter(Boolean);
      console.log(`\nModel for ${a.name}:  0. default${models.map((m, i) => `   ${i + 1}. ${m}`).join('')}`);
      const answer = (await rl.question('Number, any model name, or Enter for the default:\n> ')).trim();
      const model = !answer || answer === '0' ? '' : (models[Number(answer) - 1] ?? answer);
      entrants.push({ agentId: a.id, model });
    }
    const repo = (await rl.question('\nStart from an existing git repo? Enter its path, or press Enter for an empty project:\n> ')).trim();
    const finish = (await rl.question('\nFinish command that must pass (e.g. npm test), or Enter for none:\n> ')).trim();
    const time = (await rl.question('\nTime limit per agent (e.g. 10m), or Enter for none:\n> ')).trim();
    const cost = (await rl.question('\nCost limit per agent in USD, or Enter for none:\n> ')).trim();
    return {
      task,
      entrants,
      source: repo ? { type: 'repo', path: repo } : { type: 'empty' },
      finishCommand: finish || undefined,
      timeLimitSec: time ? parseDuration(time) : undefined,
      costLimitUsd: cost ? Number(cost) || undefined : undefined,
    };
  } finally {
    rl.close();
  }
}

function printResults(race: Race): void {
  console.log(`\nResults — ${race.setup.task.replace(/\s+/g, ' ').slice(0, 100)}`);
  console.log(`Prompt sha256 ${race.promptSha256.slice(0, 12)} (identical for every agent)\n`);
  const rows = rankLanes(race.lanes).map((l, i) => [
    String(i + 1),
    l.agentName,
    l.state,
    fmtDuration(l.metrics.time.wallMs),
    fmtTokens(totalTokens(l.metrics.tokens)),
    fmtCost(l.metrics.cost),
    String(l.metrics.activity.toolCalls),
    l.metrics.code ? `+${l.metrics.code.linesAdded} -${l.metrics.code.linesRemoved}` : 'n/r',
    l.preview.status === 'ready' ? (l.preview.url ?? `${l.preview.startCommand} (terminal)`) : `preview ${l.preview.status}`,
  ]);
  const head = ['#', 'Agent', 'State', 'Time', 'Tokens', 'Cost', 'Tools', 'Lines', 'Try it'];
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  for (const l of race.lanes) if (l.stateReason) console.log(`\n${l.agentName}: ${l.stateReason}`);
  console.log('\nn/r = not reported by the CLI · est. = estimated from the price table');
}

function engineSource(engine: RaceEngine, raceId: string, url: string): RaceSource {
  return {
    browserUrl: url,
    subscribe(cb) {
      const listener = (msg: ServerMessage) => {
        const id = 'raceId' in msg ? msg.raceId : msg.type === 'race' ? msg.race.id : null;
        if (id === raceId) cb(msg);
      };
      engine.on('message', listener);
      for (const m of engine.snapshotMessages(raceId)) cb(m);
      return () => engine.off('message', listener);
    },
    stopRace: () => engine.stopRace(raceId),
    stopLane: (laneId) => engine.stopLane(raceId, laneId),
    openBrowser: () => openBrowser(url),
  };
}

/** Wait until every lane ended and every automatic preview settled. */
function waitForRace(engine: RaceEngine, raceId: string): Promise<Race> {
  return new Promise((resolve) => {
    const check = () => {
      const race = engine.get(raceId);
      if (!race) return;
      const lanesDone = race.lanes.every((l) => isTerminal(l.state));
      const previewsDone = race.lanes.every((l) => l.metrics.outcome.preview !== 'pending' && !['installing', 'building', 'starting'].includes(l.preview.status));
      if (race.error || (lanesDone && previewsDone)) {
        engine.off('message', check);
        resolve(race);
      }
    };
    engine.on('message', check);
    check();
  });
}

async function run(args: Args): Promise<void> {
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let setup: RaceSetup;
  const task = args._.slice(1).join(' ').trim();
  if (!task) {
    if (!interactive) throw new Error('Give a task: agent-derby run "build a snake game" --agents claude,codex');
    setup = await wizard();
  } else {
    const list = typeof args.flags.agents === 'string' ? args.flags.agents : '';
    let entrants = parseEntrants(list);
    if (entrants.length === 0) {
      // No --agents: race every real agent that is installed and signed in.
      const ready = (await describeAgents()).filter((a) => a.kind !== 'mock' && a.installed && a.auth !== 'missing');
      if (ready.length === 0) throw new Error('No agent CLI is ready. See "agent-derby agents", or try the demo: --agents mock-hare,mock-tortoise,mock-owl');
      entrants = ready.map((a) => ({ agentId: a.id }));
    }
    setup = {
      task,
      entrants,
      source: typeof args.flags.repo === 'string' ? { type: 'repo', path: args.flags.repo } : { type: 'empty' },
      finishCommand: typeof args.flags.finish === 'string' ? args.flags.finish : undefined,
      timeLimitSec: typeof args.flags.time === 'string' ? parseDuration(args.flags.time) : undefined,
      costLimitUsd: typeof args.flags.cost === 'string' ? Number(args.flags.cost) || undefined : undefined,
      blind: Boolean(args.flags.blind),
    };
  }

  installExitHandlers();
  app = await startApp({ port: Number(args.flags.port) || DEFAULT_PORT, fallbackPort: true });
  const race = await app.engine.create(setup);
  const url = `${app.url}/#/race/${race.id}`;
  if (args.flags.open) openBrowser(url);

  const plain = Boolean(args.flags.plain || args.flags.json || !interactive);
  if (plain) {
    if (!args.flags.json) console.log(`Race ${race.id} — watch it in the browser: ${url}\n`);
    const report = plainReporter((line) => !args.flags.json && console.log(line));
    engineSource(app.engine, race.id, url).subscribe(report);
    const final = await waitForRace(app.engine, race.id);
    if (args.flags.json) console.log(JSON.stringify(final, null, 2));
    else {
      printResults(final);
      if (final.error) console.log(`\n${final.error}`);
    }
    const live = final.lanes.some((l) => l.preview.status === 'ready');
    if (live && !args.flags.exit && !args.flags.json && interactive) {
      console.log('\nPreviews are running. Press Ctrl+C to stop them and exit.');
      return; // keep serving
    }
    shutdown(final.lanes.some((l) => l.state === 'finished') ? 0 : 1);
  }

  const final = await new Tui(engineSource(app.engine, race.id, url)).run();
  if (final) printResults(app.engine.get(race.id) ?? final);
  console.log(`\nReopen any time: agent-derby show ${race.id}   ·   in the app: ${url}`);
  shutdown(0);
}

async function entrantsOrReady(args: Args): Promise<Entrant[]> {
  const entrants = parseEntrants(typeof args.flags.agents === 'string' ? args.flags.agents : '');
  if (entrants.length) return entrants;
  const ready = (await describeAgents()).filter((a) => a.kind !== 'mock' && a.installed && a.auth !== 'missing');
  if (ready.length === 0) throw new Error('No agent CLI is ready. See "agent-derby agents", or try the demo: --agents mock-hare,mock-tortoise,mock-owl');
  return ready.map((a) => ({ agentId: a.id }));
}

async function suite(args: Args): Promise<void> {
  const file = args._[1];
  if (!file) throw new Error('Usage: agent-derby suite <file> --agents ...   (one task per line; lines starting with # are ignored)');
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const tasks = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (tasks.length === 0) throw new Error('That file has no tasks in it');

  installExitHandlers();
  app = await startApp({ port: Number(args.flags.port) || DEFAULT_PORT, fallbackPort: true });
  const created = await app.suites.create({
    name: path.basename(file === '-' ? 'stdin' : file),
    tasks,
    entrants: await entrantsOrReady(args),
    source: typeof args.flags.repo === 'string' ? { type: 'repo', path: args.flags.repo } : { type: 'empty' },
    finishCommand: typeof args.flags.finish === 'string' ? args.flags.finish : undefined,
    timeLimitSec: typeof args.flags.time === 'string' ? parseDuration(args.flags.time) : undefined,
    costLimitUsd: typeof args.flags.cost === 'string' ? Number(args.flags.cost) || undefined : undefined,
  });
  console.log(`Suite ${created.id}: ${tasks.length} tasks. Watch it in the browser: ${app.url}/#/suite/${created.id}\n`);
  let announced = 0;
  for (;;) {
    const view = app.suites.view(created.id)!;
    while (announced < view.races.length && view.races[announced] && view.races[announced]!.lanes.every((l) => isTerminal(l.state))) {
      const r = view.races[announced]!;
      console.log(`Task ${announced + 1}/${tasks.length}: ${r.task.replace(/\s+/g, ' ').slice(0, 80)}`);
      console.log(`  ${r.lanes.map((l) => `${l.agentName} ${l.state} ${fmtDuration(l.wallMs)}`).join(' | ')}${r.winner ? `   winner: ${r.winner}` : ''}`);
      announced++;
    }
    if (view.state !== 'running') {
      if (args.flags.json) console.log(JSON.stringify(view, null, 2));
      else {
        console.log(`\nLeaderboard (${view.state}) — ranked by tasks finished, then wins, then time\n`);
        const head = ['#', 'Agent', 'Finished', 'Wins', 'Time', 'Avg place', 'Cost'];
        const rows = view.leaderboard.map((r, i) => [
          String(i + 1),
          r.agentName,
          `${r.finished}/${r.attempted}`,
          String(r.wins),
          fmtDuration(r.finishedMs),
          r.avgPlace === null ? 'n/r' : r.avgPlace.toFixed(2),
          r.costUsd === null ? 'n/r' : `${r.costEstimated ? '~' : ''}$${r.costUsd.toFixed(r.costUsd < 1 ? 4 : 2)}${r.costEstimated ? ' est.' : ''}${r.costIncomplete ? ' (partial)' : ''}`,
        ]);
        const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
        const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
        console.log(line(head));
        for (const r of rows) console.log(line(r));
        console.log('\nn/r = not reported · est. = estimated from the price table · partial = some tasks reported no cost');
      }
      shutdown(view.leaderboard.some((r) => r.finished > 0) ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function followup(args: Args): Promise<void> {
  const raceId = args._[1];
  const prompt = args._.slice(2).join(' ').trim();
  if (!raceId || !prompt) throw new Error('Usage: agent-derby followup <race> "what to do next"');
  if (runningServer()) throw new Error('The Agent Derby app is running: send the follow-up from the race page there.');
  installExitHandlers();
  app = await startApp({ port: Number(args.flags.port) || DEFAULT_PORT, fallbackPort: true });
  const url = `${app.url}/#/race/${raceId}`;
  const r = await app.engine.followUp(raceId, prompt);
  console.log(`Follow-up sent to: ${r.continued.join(', ')}${r.skipped.length ? `\nCannot continue: ${r.skipped.join(', ')}` : ''}\n`);
  engineSource(app.engine, raceId, url).subscribe(plainReporter((line) => console.log(line)));
  printResults(await waitForRace(app.engine, raceId));
  shutdown(0);
}

async function judge(args: Args): Promise<void> {
  const raceId = args._[1];
  const withAgent = typeof args.flags.with === 'string' ? args.flags.with : '';
  if (!raceId || !withAgent) throw new Error('Usage: agent-derby judge <race> --with <agent[:model]>   e.g. --with claude:sonnet');
  const [agentId, ...model] = withAgent.split(':');
  const engine = await offlineEngine();
  await engine.judge(raceId, { agentId: agentId!, model: model.join(':') });
  process.stdout.write('Judging');
  while (engine.get(raceId)?.judging) {
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  const race = engine.get(raceId)!;
  console.log('\n\nAI judge verdicts. These are one model\'s opinion, not a measurement; the judge is not told which agent built what.\n');
  for (const lane of race.lanes) {
    if (!lane.judge) continue;
    console.log(`${lane.agentName}: ${lane.judge.score}/10  (judged by ${lane.judge.judgeAgent}${lane.judge.judgeModel ? `, ${lane.judge.judgeModel}` : ''})`);
    console.log(`  ${lane.judge.summary}`);
    for (const x of lane.judge.strengths) console.log(`  + ${x}`);
    for (const x of lane.judge.problems) console.log(`  - ${x}`);
    console.log('');
  }
  if (race.judgeError) console.log(race.judgeError);
  engine.shutdownNow();
  killAllTracked();
  process.exit(race.lanes.some((l) => l.judge) ? 0 : 1);
}

function runningServer(): { pid: number; port: number } | null {
  const info = readJson<{ pid: number; port: number } | null>(path.join(runDir(), 'server.json'), null);
  return info && isAlive(info.pid) ? info : null;
}

async function watch(raceId: string | undefined): Promise<void> {
  if (!raceId) throw new Error('Which race? See: agent-derby history');
  const server = runningServer();
  if (!server) throw new Error('The Agent Derby app is not running. Start it with "agent-derby", or view a past race with "agent-derby show".');
  const base = `http://127.0.0.1:${server.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const post = (p: string) => void fetch(`${base}${p}`, { method: 'POST' }).catch(() => {});
  const url = `http://localhost:${server.port}/#/race/${raceId}`;
  const source: RaceSource = {
    browserUrl: url,
    subscribe(cb) {
      ws.on('message', (raw) => cb(JSON.parse(String(raw))));
      ws.send(JSON.stringify({ type: 'subscribe', raceId }));
      return () => ws.close();
    },
    // Watching is a second view of a race owned by the app: quitting must not stop it.
    stopRace: () => {},
    stopLane: (laneId) => post(`/api/races/${raceId}/lanes/${laneId}/stop`),
    openBrowser: () => openBrowser(url),
  };
  await new Tui(source).run();
  process.exit(0);
}

async function offlineEngine(): Promise<RaceEngine> {
  return new RaceEngine(await sandboxStatus());
}

async function history(): Promise<void> {
  const list = (await offlineEngine()).list();
  if (list.length === 0) return console.log('No races yet. Start one with: agent-derby run');
  for (const r of list) {
    const when = new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`${r.id}  ${when}  ${r.state.padEnd(11)}  ${r.winner ? `winner: ${r.winner}` : 'no winner'}`);
    console.log(`    ${r.task.replace(/\s+/g, ' ').slice(0, 90)}`);
    console.log(`    ${r.lanes.map((l) => `${l.agentName} (${l.state})`).join(', ')}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help) return console.log(HELP);
  if (args.flags.version) return console.log(APP_VERSION);
  const command = args._[0];
  switch (command) {
    case undefined:
    case 'serve':
    case 'start':
      return serve(args);
    case 'run':
    case 'race':
      return run(args);
    case 'agents':
      return agents();
    case 'install':
      return install(args._[1]);
    case 'login':
      return login(args._[1]);
    case 'history':
      return history();
    case 'suite':
      return suite(args);
    case 'followup':
    case 'follow-up':
      return followup(args);
    case 'judge':
      return judge(args);
    case 'replay': {
      if (!args._[1]) throw new Error('Which race? See: agent-derby history');
      const html = (await offlineEngine()).replayHtml(args._[1]);
      const out = typeof args.flags.out === 'string' ? args.flags.out : `agent-derby-replay-${args._[1]}.html`;
      fs.writeFileSync(out, html);
      console.log(`Saved ${path.resolve(out)} (${Math.round(html.length / 1024)} KB). It is one self-contained page: open it or send it to anyone.`);
      return;
    }
    case 'watch':
      return watch(args._[1]);
    case 'show': {
      const race = (await offlineEngine()).get(args._[1] ?? '');
      if (!race) throw new Error('Race not found. See: agent-derby history');
      if (args.flags.json) console.log(JSON.stringify(race, null, 2));
      else printResults(race);
      return;
    }
    case 'keep': {
      const [, raceId, laneId] = args._;
      const branch = args.flags.branch;
      const folder = args.flags.folder;
      if (!raceId || !laneId || (typeof branch !== 'string' && typeof folder !== 'string')) {
        throw new Error('Usage: agent-derby keep <race> <lane> --branch <name> | --folder <path>');
      }
      const engine = await offlineEngine();
      console.log(await engine.keep(raceId, laneId, typeof branch === 'string' ? { mode: 'branch', target: branch } : { mode: 'folder', target: String(folder) }));
      return;
    }
    case 'delete': {
      if (!args._[1]) throw new Error('Which race? See: agent-derby history');
      if (runningServer()) {
        const r = await fetch(`http://127.0.0.1:${runningServer()!.port}/api/races/${args._[1]}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Delete failed');
      } else await (await offlineEngine()).deleteRace(args._[1]);
      console.log(`Deleted ${args._[1]}: its workspaces and any agent-derby/${args._[1]}/* branches are gone.`);
      return;
    }
    default:
      // `agent-derby "build a snake game"` is shorthand for `agent-derby run "..."`.
      if (command && !fs.existsSync(command) && command.includes(' ')) {
        args._.unshift('run');
        return run(args);
      }
      throw new Error(`Unknown command "${command}". Try: agent-derby --help`);
  }
}

main().catch((e) => {
  process.stderr.write(`agent-derby: ${(e as Error).message}\n`);
  shutdown(1);
});
