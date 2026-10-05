import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isTerminal, rankLanes, type Race, type ServerMessage, type Suite, type SuiteRequest, type SuiteRow, type SuiteView } from '../../shared/types.js';
import { ensureDir, homeDir, readJson, writeJsonAtomic } from '../paths.js';
import type { RaceEngine } from './engine.js';

/**
 * Suites: the same entrants on a list of tasks, one race after another, with a
 * combined leaderboard. One task is an anecdote; a suite is a small personal
 * benchmark. Races run one at a time so the agents are never competing with
 * their own other runs for the machine.
 */

const MAX_TASKS = 25;

function suitesDir(): string {
  return path.join(homeDir(), 'suites');
}

function suiteFile(id: string): string {
  return path.join(suitesDir(), `${id}.json`);
}

/** The combined table. Pure, so it can be tested on its own. */
export function leaderboard(races: (Race | null)[]): SuiteRow[] {
  const rows = new Map<string, SuiteRow & { places: number[]; judged: number[]; costKnown: number }>();
  for (const race of races) {
    if (!race || !race.lanes.every((l) => isTerminal(l.state))) continue; // only tasks that have ended count
    const ranked = rankLanes(race.lanes);
    race.lanes.forEach((lane, index) => {
      // Entrants keep their position from race to race, which identifies them even when two share an agent and model.
      const key = String(index);
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          agentName: lane.agentName,
          color: lane.color,
          finished: 0,
          attempted: 0,
          wins: 0,
          finishedMs: 0,
          avgPlace: null,
          costUsd: null,
          costIncomplete: false,
          costEstimated: false,
          judgeAvg: null,
          places: [],
          judged: [],
          costKnown: 0,
        };
        rows.set(key, row);
      }
      const place = ranked.indexOf(lane) + 1;
      row.attempted++;
      row.places.push(place);
      if (lane.state === 'finished') {
        row.finished++;
        row.finishedMs += lane.metrics.time.wallMs;
        if (place === 1) row.wins++;
      }
      const cost = lane.metrics.cost;
      if (cost.usd !== null) {
        row.costUsd = (row.costUsd ?? 0) + cost.usd;
        row.costKnown++;
        if (cost.source === 'estimated') row.costEstimated = true;
      }
      if (lane.judge) row.judged.push(lane.judge.score);
    });
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return [...rows.values()]
    .map(({ places, judged, costKnown, ...row }) => ({
      ...row,
      avgPlace: avg(places),
      judgeAvg: avg(judged),
      // Some tasks reported a cost and others did not: the total is a lower bound, and says so.
      costIncomplete: costKnown > 0 && costKnown < row.attempted,
    }))
    .sort((a, b) => b.finished - a.finished || b.wins - a.wins || a.finishedMs - b.finishedMs);
}

export class SuiteRunner {
  private stopping = new Set<string>();

  constructor(private engine: RaceEngine) {}

  private save(suite: Suite): void {
    writeJsonAtomic(suiteFile(suite.id), suite);
  }

  private read(id: string): Suite | null {
    if (!/^[\w-]+$/.test(id)) return null;
    return readJson<Suite | null>(suiteFile(id), null);
  }

  /** Suites that were mid-run when the app last stopped cannot continue on their own. */
  recoverInterrupted(): void {
    for (const suite of this.all()) {
      if (suite.state === 'running') {
        suite.state = 'stopped';
        this.save(suite);
      }
    }
  }

  private all(): Suite[] {
    try {
      return fs
        .readdirSync(ensureDir(suitesDir()))
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<Suite | null>(path.join(suitesDir(), f), null))
        .filter((s): s is Suite => Boolean(s?.id));
    } catch {
      return [];
    }
  }

  view(id: string): SuiteView | null {
    const suite = this.read(id);
    if (!suite) return null;
    const races = suite.raceIds.map((raceId) => (raceId ? this.engine.get(raceId) : null));
    return {
      ...suite,
      races: suite.raceIds.map((raceId) => (raceId ? this.engine.summary(raceId) : null)),
      leaderboard: leaderboard(races),
    };
  }

  list(): SuiteView[] {
    return this.all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => this.view(s.id))
      .filter((v): v is SuiteView => Boolean(v));
  }

  async create(req: SuiteRequest): Promise<Suite> {
    const tasks = (req.tasks ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
    if (tasks.length === 0) throw new Error('Add at least one task');
    if (tasks.length > MAX_TASKS) throw new Error(`At most ${MAX_TASKS} tasks per suite`);
    if (!Array.isArray(req.entrants) || req.entrants.length === 0) throw new Error('Pick at least one agent');
    const { name, tasks: _tasks, ...setup } = req;
    const suite: Suite = {
      id: `s${new Date().toISOString().slice(2, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`,
      name: name?.trim() || `${tasks.length} tasks`,
      createdAt: Date.now(),
      state: 'running',
      tasks,
      setup,
      raceIds: tasks.map(() => null),
    };
    // Start the first race now, so setup mistakes (unknown agent, not signed in, bad repo) are reported straight away.
    const first = await this.engine.create({ ...setup, task: tasks[0]! }, { suiteId: suite.id });
    suite.raceIds[0] = first.id;
    this.save(suite);
    void this.run(suite, 0);
    return suite;
  }

  private waitEnded(raceId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const race = this.engine.get(raceId);
        if (!race || race.error || race.lanes.every((l) => isTerminal(l.state))) {
          this.engine.off('message', listener);
          resolve();
        }
      };
      const listener = (msg: ServerMessage) => {
        if (('raceId' in msg && msg.raceId === raceId) || (msg.type === 'race' && msg.race.id === raceId)) check();
      };
      this.engine.on('message', listener);
      check();
    });
  }

  private async run(suite: Suite, from: number): Promise<void> {
    for (let i = from; i < suite.tasks.length; i++) {
      if (this.stopping.has(suite.id)) break;
      try {
        if (!suite.raceIds[i]) {
          const race = await this.engine.create({ ...suite.setup, task: suite.tasks[i]! }, { suiteId: suite.id });
          suite.raceIds[i] = race.id;
          this.save(suite);
        }
        await this.waitEnded(suite.raceIds[i]!);
        // Free the finished task's previews before the next task starts; they can be restarted from its race page.
        if (i < suite.tasks.length - 1) await this.engine.closeRace(suite.raceIds[i]!).catch(() => {});
      } catch {
        break; // the next race could not be created; what has run so far still stands
      }
    }
    suite.state = this.stopping.has(suite.id) || suite.raceIds.some((r) => r === null) ? 'stopped' : 'finished';
    this.stopping.delete(suite.id);
    this.save(suite);
  }

  stop(id: string): void {
    const suite = this.read(id);
    if (!suite) throw new Error('Suite not found');
    if (suite.state !== 'running') return;
    this.stopping.add(id);
    for (const raceId of suite.raceIds) {
      if (!raceId) continue;
      const race = this.engine.get(raceId);
      if (race && !race.lanes.every((l) => isTerminal(l.state))) this.engine.stopRace(raceId);
    }
  }

  async remove(id: string): Promise<void> {
    const suite = this.read(id);
    if (!suite) throw new Error('Suite not found');
    this.stop(id);
    for (const raceId of suite.raceIds) if (raceId) await this.engine.deleteRace(raceId).catch(() => {});
    fs.rmSync(suiteFile(id), { force: true });
  }
}
