import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { fmtDate, fmtDuration, stateLabel, truncate, winnerName } from '../format';
import { raceHash, suiteHash } from '../router';
import type { RaceSummary, SuiteView } from '../types';
import { DeleteDialog } from './Results';
import { SUITE_STATE_LABELS, SuiteDeleteDialog, normalizeSuite, suiteTitle } from './SuitePage';
import { ErrorNote, Icon, Spinner, laneStyle } from './ui';

const RACE_STATE: Record<string, string> = {
  preparing: 'preparing',
  running: 'still running',
  finished: 'finished',
  interrupted: 'interrupted',
};

export function History() {
  const [races, setRaces] = useState<RaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<RaceSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [suites, setSuites] = useState<SuiteView[]>([]);
  const [pendingSuite, setPendingSuite] = useState<SuiteView | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.races();
      setRaces(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
    // Suites are an extra: a server without them must not break the race list.
    try {
      const list = await api.suites();
      setSuites(Array.isArray(list) ? list.filter(Boolean).map(normalizeSuite) : []);
    } catch {
      setSuites([]);
    }
  }, []);

  const confirmDeleteSuite = async () => {
    if (!pendingSuite) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSuite(pendingSuite.id);
      setPendingSuite(null);
      await load();
    } catch (err) {
      setDeleteError(errorText(err));
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = async () => {
    if (!pending) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteRace(pending.id);
      setPending(null);
      await load();
    } catch (err) {
      setDeleteError(errorText(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page history">
      <div className="section-head">
        <h1>Past races</h1>
        <a className="btn" href="#/">
          New race
        </a>
      </div>
      {error && (
        <div>
          <ErrorNote>{error}</ErrorNote>
          <button type="button" className="btn small" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {!races && !error && (
        <p className="loading">
          <Spinner /> Loading…
        </p>
      )}
      {suites.length > 0 && (
        <section className="history-suites" aria-label="Suites">
          <h2>Suites</h2>
          <ul className="history-list">
            {suites.map((s) => {
              const done = s.races.filter((r) => r && (r.state === 'finished' || r.state === 'interrupted')).length;
              const leader = s.leaderboard[0];
              return (
                <li key={s.id} className="history-row">
                  <a className="history-main" href={suiteHash(s.id)}>
                    <span className="history-task">{truncate(suiteTitle(s), 140)}</span>
                    <span className="history-meta muted">
                      <span>{fmtDate(s.createdAt)}</span>
                      <span>{s.state === 'running' ? 'still running' : (SUITE_STATE_LABELS[s.state] ?? s.state)}</span>
                      <span>
                        {done} of {s.tasks.length} tasks done
                      </span>
                    </span>
                    {leader && leader.finished > 0 && (
                      <span className="history-lanes">
                        <span className="history-lane" style={laneStyle(leader.color || '#7a86a8')}>
                          <span className="swatch" />
                          <span className="hl-name">{leader.agentName}</span>
                          <span className="muted">
                            leads, {leader.finished} of {leader.attempted} finished
                          </span>
                        </span>
                      </span>
                    )}
                  </a>
                  <button
                    type="button"
                    className="btn ghost icon-only"
                    onClick={() => {
                      setDeleteError(null);
                      setPendingSuite(s);
                    }}
                    title="Delete this suite, its races and their workspaces"
                    aria-label="Delete this suite"
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
          <h2 className="history-races-title">Races</h2>
        </section>
      )}
      {races && races.length === 0 && (
        <div className="empty">
          <p>No races yet. The first one takes a task and two agents.</p>
          <a className="btn primary" href="#/">
            Set up a race
          </a>
        </div>
      )}
      {races && races.length > 0 && (
        <ul className="history-list">
          {races.map((r) => {
            const lanes = Array.isArray(r.lanes) ? r.lanes : [];
            const winner = winnerName(r);
            return (
              <li key={r.id} className="history-row">
                <a className="history-main" href={raceHash(r.id)}>
                  <span className="history-task">{truncate(r.task || '(no task text)', 140)}</span>
                  <span className="history-meta muted">
                    <span>{fmtDate(r.createdAt)}</span>
                    <span>{RACE_STATE[r.state] ?? r.state}</span>
                    <span>{r.source?.type === 'repo' ? `repo ${r.source.path}` : 'empty project'}</span>
                  </span>
                  <span className="history-lanes">
                    {lanes.map((l) => {
                      const won = winner !== null && (r.winner === l.id || r.winner === l.agentName);
                      return (
                        <span key={l.id} className={`history-lane${won ? ' won' : ''}`} style={laneStyle(l.color || '#7a86a8')} title={l.model ?? undefined}>
                          <span className="swatch" />
                          <span className="hl-name">{l.agentName}</span>
                          <span className={`hl-state state-text-${l.state}`}>{stateLabel(l.state)}</span>
                          {l.state !== 'running' && l.state !== 'verifying' && l.state !== 'pending' && <span className="muted">{fmtDuration(l.wallMs ?? 0)}</span>}
                          {won && (
                            <span className="won-mark">
                              <Icon name="flag" size={12} /> winner
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </span>
                  {!winner && r.state === 'finished' && <span className="muted small">No agent finished successfully.</span>}
                </a>
                <button
                  type="button"
                  className="btn ghost icon-only"
                  onClick={() => {
                    setDeleteError(null);
                    setPending(r);
                  }}
                  title="Delete this race"
                  aria-label="Delete this race"
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {pendingSuite && (
        <SuiteDeleteDialog busy={deleting} error={deleteError} onCancel={() => setPendingSuite(null)} onConfirm={confirmDeleteSuite} />
      )}
      {pending && (
        <DeleteDialog
          repoMode={pending.source?.type === 'repo'}
          raceId={pending.id}
          busy={deleting}
          error={deleteError}
          onCancel={() => setPending(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
