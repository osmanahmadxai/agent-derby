import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { ESTIMATE_TOOLTIP, fmtDate, fmtDuration, fmtMoney, judgeScoreText, truncate, winnerName } from '../format';
import { raceHash } from '../router';
import type { SuiteRow, SuiteState, SuiteView } from '../types';
import { OpinionTag } from './Results';
import { ErrorNote, Icon, Modal, NotReported, Spinner, laneStyle } from './ui';

const POLL_MS = 2000;

export const SUITE_STATE_LABELS: Record<SuiteState, string> = {
  running: 'running',
  finished: 'finished',
  stopped: 'stopped',
};

const RACE_STATE: Record<string, string> = {
  preparing: 'preparing',
  running: 'running now',
  finished: 'finished',
  interrupted: 'interrupted',
};

/** Fills what an older or partial suite record may lack, so rendering never throws. */
export function normalizeSuite(s: SuiteView): SuiteView {
  const tasks = Array.isArray(s.tasks) ? s.tasks : [];
  return {
    ...s,
    name: s.name ?? '',
    tasks,
    raceIds: Array.isArray(s.raceIds) ? s.raceIds : [],
    races: Array.isArray(s.races) ? s.races : [],
    leaderboard: Array.isArray(s.leaderboard) ? s.leaderboard : [],
  };
}

export function suiteTitle(s: SuiteView): string {
  return s.name?.trim() || `Suite of ${s.tasks.length} tasks`;
}

function CostCell({ row }: { row: SuiteRow }) {
  if (row.costUsd === null || row.costUsd === undefined) return <NotReported />;
  return (
    <>
      <span className="val">{fmtMoney(row.costUsd)}</span>
      {row.costEstimated && (
        <span className="tag est" title={ESTIMATE_TOOLTIP}>
          est.
        </span>
      )}
      {row.costIncomplete && (
        <span className="tag partial" title="Some tasks did not report a cost, so this total is incomplete.">
          partial
        </span>
      )}
    </>
  );
}

function Leaderboard({ rows }: { rows: SuiteRow[] }) {
  if (rows.length === 0) return <p className="muted">No results yet. The leaderboard fills in as tasks end.</p>;
  return (
    <div className="table-scroll">
      <table className="board">
        <thead>
          <tr>
            <th scope="col" className="num">
              Place
            </th>
            <th scope="col">Agent</th>
            <th scope="col" className="num" title="Tasks finished successfully, out of the tasks that have ended so far">
              Finished
            </th>
            <th scope="col" className="num" title="Tasks where it finished successfully and fastest">
              Wins
            </th>
            <th scope="col" className="num" title="Total time across the tasks it finished">
              Time on finished tasks
            </th>
            <th scope="col" className="num" title="Average finishing place across the tasks that have ended">
              Average place
            </th>
            <th scope="col" className="num">
              Total cost
            </th>
            <th scope="col" className="num">
              AI judge average <OpinionTag />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key || i} className={i === 0 && row.finished > 0 ? 'lead' : ''} style={laneStyle(row.color || '#7a86a8')}>
              <td className="num board-place">{i + 1}</td>
              <th scope="row">
                <span className="board-agent">
                  <span className="board-bar" aria-hidden="true" />
                  {row.agentName}
                </span>
              </th>
              <td className="num">
                <span className="val">{row.finished}</span>
                <span className="muted"> / {row.attempted}</span>
              </td>
              <td className="num">
                <span className="val">{row.wins}</span>
              </td>
              <td className="num">{row.finished > 0 ? <span className="val">{fmtDuration(row.finishedMs)}</span> : <span className="muted">none finished</span>}</td>
              <td className="num">
                {row.avgPlace === null || row.avgPlace === undefined ? <span className="muted">no task ended yet</span> : <span className="val">{(Math.round(row.avgPlace * 10) / 10).toFixed(1)}</span>}
              </td>
              <td className="num">
                <CostCell row={row} />
              </td>
              <td className="num">
                {row.judgeAvg === null || row.judgeAvg === undefined ? (
                  <span className="muted">not judged</span>
                ) : (
                  <>
                    <span className="val">{judgeScoreText(row.judgeAvg)}</span>
                    <OpinionTag />
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SuiteDeleteDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="Delete this suite?"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger solid" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete suite'}
          </button>
        </>
      }
    >
      <p>This removes the suite, every race in it, and every agent's workspace folder from those races. It cannot be undone.</p>
      <p className="muted">Anything you saved with “Keep this one” under another branch name or folder stays.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

export function SuitePage({ suiteId }: { suiteId: string }) {
  const [suite, setSuite] = useState<SuiteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<SuiteView | null> => {
    const s = normalizeSuite(await api.suite(suiteId));
    setSuite(s);
    setError(null);
    return s;
  }, [suiteId]);

  // No socket for suites: poll while it runs, stop when it does not.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wasRunning = false;
    const tick = async () => {
      try {
        const s = await load();
        wasRunning = s?.state === 'running';
      } catch (err) {
        if (!alive) return;
        // A suite that was running is retried; one that never loaded is not polled forever.
        setError(errorText(err));
      }
      if (alive && wasRunning) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  if (!suite) {
    return (
      <div className="page narrow">
        {!error && (
          <p className="loading">
            <Spinner /> Loading the suite…
          </p>
        )}
        {error && (
          <div className="empty">
            <h1>This suite could not be opened</h1>
            <ErrorNote>{error}</ErrorNote>
            <p>
              It may have been deleted. <a href="#/history">See past races</a> or <a href="#/">start a new one</a>.
            </p>
          </div>
        )}
      </div>
    );
  }

  const running = suite.state === 'running';
  const started = suite.raceIds.filter(Boolean).length;
  const ended = suite.races.filter((r) => r && (r.state === 'finished' || r.state === 'interrupted')).length;

  const stop = async () => {
    setStopping(true);
    setActionError(null);
    try {
      await api.stopSuite(suite.id);
      await load();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="page suite">
      <div className="section-head">
        <h1>{suiteTitle(suite)}</h1>
        {running && (
          <button type="button" className="btn danger" onClick={stop} disabled={stopping}>
            <Icon name="stop" size={14} /> Stop suite
          </button>
        )}
      </div>
      <p className="suite-meta muted">
        <span className={`race-state rs-${suite.state}`}>{SUITE_STATE_LABELS[suite.state] ?? suite.state}</span>
        <span>
          {ended} of {suite.tasks.length} tasks done
        </span>
        <span>{suite.setup?.source?.type === 'repo' ? `from ${suite.setup.source.path}` : 'from an empty project'}</span>
        {suite.setup?.blind && <span>blind</span>}
        <span>{fmtDate(suite.createdAt)}</span>
      </p>
      {error && <ErrorNote>Could not refresh: {error}</ErrorNote>}
      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      <section aria-label="Leaderboard">
        <div className="section-head">
          <h2>Leaderboard</h2>
        </div>
        <p className="muted small">Ranked by tasks finished, then wins, then time.</p>
        <Leaderboard rows={suite.leaderboard} />
      </section>

      <section aria-label="Tasks">
        <div className="section-head">
          <h2>Tasks</h2>
          <span className="muted">
            {started} of {suite.tasks.length} started
          </span>
        </div>
        <ol className="suite-tasks">
          {suite.tasks.map((task, i) => {
            const raceId = suite.raceIds[i] ?? null;
            const race = suite.races[i] ?? null;
            const live = !!race && (race.state === 'running' || race.state === 'preparing');
            const winner = race ? winnerName(race) : null;
            const body = (
              <>
                <span className="suite-task-num">{i + 1}</span>
                <span className="suite-task-main">
                  <span className="suite-task-text">{truncate(task || '(no task text)', 160)}</span>
                  <span className="history-meta muted">
                    {!raceId ? (
                      <span>{running ? 'waiting' : 'not run'}</span>
                    ) : !race ? (
                      <span>started</span>
                    ) : (
                      <>
                        <span className={live ? 'suite-live' : undefined}>{RACE_STATE[race.state] ?? race.state}</span>
                        {winner ? (
                          <span className="won-mark">
                            <Icon name="flag" size={12} /> {winner} won
                          </span>
                        ) : race.state === 'finished' ? (
                          <span>no agent finished successfully</span>
                        ) : null}
                      </>
                    )}
                  </span>
                </span>
                {raceId && <span className="suite-task-go">open race →</span>}
              </>
            );
            return (
              <li key={i} className={`suite-task-row${live ? ' live' : ''}${raceId ? '' : ' waiting'}`}>
                {raceId ? (
                  <a className="suite-task-link" href={raceHash(raceId)}>
                    {body}
                  </a>
                ) : (
                  <div className="suite-task-link">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
