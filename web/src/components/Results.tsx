import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { HIDDEN_METRIC_ROWS, laneSecondary } from '../display';
import {
  ESTIMATE_TOOLTIP,
  HIDDEN_TEXT,
  OPINION_TOOLTIP,
  SORT_HIGHER,
  SORT_LABELS,
  allDone,
  bestIndexes,
  finishPositions,
  fmtCompact,
  fmtDuration,
  fmtInt,
  fmtMoney,
  judgeScoreText,
  metricRows,
  resultsMarkdown,
  slugify,
  sortLanes,
  sortValue,
  type SortKey,
} from '../format';
import { navigate, rememberSetup } from '../router';
import { CARD_H, CARD_W, canvasToBlob, drawShareCard } from '../shareCard';
import { isTerminal, totalTokens } from '../types';
import type { AgentInfo, Lane, Race } from '../types';
import { DiffViewer } from './DiffViewer';
import { CopyButton, ErrorNote, Icon, Modal, NotReported, Spinner, StateBadge, laneStyle } from './ui';

/** Goes next to every AI-judge score. */
export function OpinionTag() {
  return (
    <span className="tag opinion" title={OPINION_TOOLTIP}>
      opinion
    </span>
  );
}

function PickTag() {
  return (
    <span className="tag pick" title="You picked this one before the agents were revealed.">
      your pick
    </span>
  );
}

// ---------------------------------------------------------------------------
// Podium
// ---------------------------------------------------------------------------

function sortCell(lane: Lane, key: SortKey) {
  const v = sortValue(lane, key);
  if (key === 'judge' && v === null) return <span className="not-reported" title="No AI judge has looked at this result.">not judged</span>;
  if (v === null) return <NotReported />;
  switch (key) {
    case 'time':
      return fmtDuration(v);
    case 'cost':
      return (
        <>
          {fmtMoney(v)}
          {lane.metrics.cost.source === 'estimated' && (
            <span className="tag est" title={ESTIMATE_TOOLTIP}>
              est.
            </span>
          )}
        </>
      );
    case 'tokens':
      return fmtCompact(v);
    case 'lines':
      return `${fmtInt(v)} lines`;
    case 'judge':
      return (
        <>
          {judgeScoreText(v)}
          <OpinionTag />
        </>
      );
  }
}

function Podium({
  race,
  ranked,
  sort,
  onSort,
  hidden,
  pickedLaneId,
}: {
  race: Race;
  ranked: Lane[];
  sort: SortKey;
  onSort: (k: SortKey) => void;
  hidden: boolean;
  pickedLaneId: string | null;
}) {
  const done = allDone(race.lanes);
  const leader = ranked[0];
  const leaderTime = leader && leader.state === 'finished' ? leader.metrics.time.wallMs : null;
  let place = 0;
  return (
    <section className="podium" aria-label="Ranking">
      <div className="section-head">
        <h2>{done ? 'Finishing order' : 'Standings so far'}</h2>
        <label className="sort">
          <span>Rank by</span>
          <select value={sort} onChange={(ev) => onSort(ev.target.value as SortKey)}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        Agents that finished successfully come first, then {SORT_HIGHER[sort] ? 'highest' : 'lowest'}{' '}
        {sort === 'judge' ? SORT_LABELS[sort] : SORT_LABELS[sort].toLowerCase()}. An agent that did not finish is never ranked above
        one that did.
        {sort === 'judge' ? " The judge score is one AI model's opinion, not a measurement." : ''}
      </p>
      <ol className="podium-list">
        {ranked.map((lane, i) => {
          const finished = lane.state === 'finished';
          if (finished) place += 1;
          const top = i < 3;
          const gap = sort === 'time' && finished && leaderTime !== null && place > 1 ? lane.metrics.time.wallMs - leaderTime : null;
          return (
            <li key={lane.id} className={`podium-row${top ? ' top' : ''}${finished ? '' : ' dnf'}${finished && place === 1 && done ? ' winner' : ''}`} style={laneStyle(lane.color)}>
              <span className="podium-pos">{finished ? place : ''}</span>
              <span className="podium-bar" aria-hidden="true" />
              <span className="podium-name">
                <strong>
                  {lane.agentName}
                  {pickedLaneId === lane.id && <PickTag />}
                </strong>
                <span className="muted">{laneSecondary(lane, hidden)}</span>
                {lane.judge && sort !== 'judge' && (
                  <span className="podium-judge">
                    AI judge {judgeScoreText(lane.judge.score)}
                    <OpinionTag />
                  </span>
                )}
              </span>
              <StateBadge state={lane.state} />
              <span className="podium-value">
                {sortCell(lane, sort)}
                {gap !== null && gap > 0 && <span className="gap">+{fmtDuration(gap)}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Share card
// ---------------------------------------------------------------------------

function ShareCard({ race, ranked, hidden }: { race: Race; ranked: Lane[]; hidden: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!canvas.current) return;
    try {
      drawShareCard(canvas.current, race, ranked, (lane) => laneSecondary(lane, hidden));
      setFailed(null);
    } catch (err) {
      setFailed(errorText(err));
    }
  }, [race, ranked, hidden]);

  const say = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg((m) => (m === text ? null : m)), 2500);
  };

  const download = async () => {
    if (!canvas.current) return;
    try {
      const blob = await canvasToBlob(canvas.current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent-derby-${race.id}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      say('PNG downloaded');
    } catch (err) {
      say(`Download failed: ${errorText(err)}`);
    }
  };

  const copyImage = async () => {
    if (!canvas.current) return;
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('this browser cannot copy images; use Download PNG instead');
      }
      const blob = await canvasToBlob(canvas.current);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      say('Image copied');
    } catch (err) {
      say(`Copy failed: ${errorText(err)}`);
    }
  };

  return (
    <section className="share" aria-label="Result card">
      <div className="section-head">
        <h2>Result card</h2>
      </div>
      <canvas ref={canvas} className="share-canvas" width={CARD_W} height={CARD_H} role="img" aria-label="Result card image with the ranking, time, cost, tokens and lines changed per agent" />
      {failed && <ErrorNote>The card could not be drawn: {failed}</ErrorNote>}
      <div className="row wrap">
        <button type="button" className="btn" onClick={download}>
          <Icon name="download" size={14} /> Download PNG
        </button>
        <button type="button" className="btn" onClick={copyImage}>
          <Icon name="image" size={14} /> Copy image
        </button>
        <CopyButton text={() => resultsMarkdown(race, ranked, (lane) => laneSecondary(lane, hidden))} label="Copy as Markdown" className="btn" />
        {msg && (
          <span className="muted" role="status">
            {msg}
          </span>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

function ComparisonTable({ lanes, hidden, pickedLaneId }: { lanes: Lane[]; hidden: boolean; pickedLaneId: string | null }) {
  const rows = useMemo(() => metricRows(), []);
  const eligible = lanes.map((l) => l.state === 'finished');
  let lastGroup = '';
  return (
    <section className="compare" aria-label="Comparison">
      <div className="section-head">
        <h2>Every measurement</h2>
      </div>
      <p className="muted small">
        The best value in a row is marked, counting only agents that finished successfully. A value that was{' '}
        <NotReported /> is unknown, not zero, and never wins.
      </p>
      <div className="table-scroll">
        <table className="compare-table" style={{ minWidth: 230 + lanes.length * 190 }}>
          <thead>
            <tr>
              <th scope="col" />
              {lanes.map((l) => (
                <th key={l.id} scope="col" style={laneStyle(l.color)}>
                  <span className="th-lane">
                    <span className="swatch" />
                    <span className="th-name">{l.agentName}</span>
                    {pickedLaneId === l.id && <PickTag />}
                  </span>
                  <StateBadge state={l.state} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cells = lanes.map((l) => {
                if (hidden && HIDDEN_METRIC_ROWS.has(row.key)) return { value: null, text: HIDDEN_TEXT };
                try {
                  return row.cell(l);
                } catch {
                  return { value: null, text: null };
                }
              });
              const best = bestIndexes(
                cells.map((c) => c.value),
                row.better,
                eligible,
              );
              const head = row.group !== lastGroup;
              lastGroup = row.group;
              return (
                <Fragment key={row.key}>
                  {head && (
                    <tr className="group-row">
                      <th scope="colgroup" colSpan={lanes.length + 1}>
                        {row.group}
                      </th>
                    </tr>
                  )}
                  <tr>
                    <th scope="row">{row.label}</th>
                    {cells.map((c, i) => (
                      <td key={lanes[i]!.id} className={`${best.has(i) ? 'best' : ''}${c.mono ? ' mono' : ''}`}>
                        {c.text === null ? (
                          <NotReported />
                        ) : (
                          <>
                            <span className="val">{c.text}</span>
                            {c.badge && (
                              <span className={`tag${c.badge === 'est.' ? ' est' : c.badge === 'opinion' ? ' opinion' : ''}`} title={c.badgeTitle}>
                                {c.badge}
                              </span>
                            )}
                            {best.has(i) && <span className="best-mark">best</span>}
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Keep
// ---------------------------------------------------------------------------

function KeepDialog({ race, lane, onClose }: { race: Race; lane: Lane; onClose: () => void }) {
  const repo = race.setup.source.type === 'repo' ? race.setup.source.path : null;
  const [mode, setMode] = useState<'branch' | 'folder'>(repo ? 'branch' : 'folder');
  const [branch, setBranch] = useState(`keep/${slugify(lane.agentName)}-${slugify(race.id).slice(0, 8)}`);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const target = (mode === 'branch' ? branch : folder).trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.keep(race.id, lane.id, { mode, target });
      setDetail(res?.detail || 'Kept.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Keep ${lane.agentName}'s result`}
      onClose={onClose}
      footer={
        detail ? (
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={submit} disabled={busy || !target}>
              {busy ? 'Keeping…' : mode === 'branch' ? 'Create branch' : 'Copy to folder'}
            </button>
          </>
        )
      }
    >
      {detail ? (
        <p className="note ok" role="status">
          <Icon name="check" size={15} />
          <span>{detail}</span>
        </p>
      ) : (
        <form
          className="keep-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (target && !busy) submit();
          }}
        >
          <p>Nothing is kept unless you do this. Pick where this agent's work should go.</p>
          {repo && (
            <label className="radio">
              <input type="radio" name="keep-mode" checked={mode === 'branch'} onChange={() => setMode('branch')} />
              <span>
                <strong>As a branch in your repository</strong>
                <span className="muted">{repo}</span>
              </span>
            </label>
          )}
          <label className="radio">
            <input type="radio" name="keep-mode" checked={mode === 'folder'} onChange={() => setMode('folder')} />
            <span>
              <strong>As a folder</strong>
              <span className="muted">A copy of the workspace anywhere on this computer</span>
            </span>
          </label>
          {mode === 'branch' ? (
            <label className="field">
              <span>Branch name</span>
              <input type="text" className="mono" value={branch} onChange={(ev) => setBranch(ev.target.value)} spellCheck={false} autoFocus />
            </label>
          ) : (
            <label className="field">
              <span>Folder path (absolute)</span>
              <input
                type="text"
                className="mono"
                value={folder}
                onChange={(ev) => setFolder(ev.target.value)}
                placeholder="/path/to/new-folder"
                spellCheck={false}
                autoFocus
              />
            </label>
          )}
          <p className="note">
            {mode === 'branch' ? (
              <span>
                This creates the branch <code>{target || '…'}</code> in <code>{repo}</code> holding this agent's result. Nothing is
                checked out: your working tree and your current branch stay exactly as they are.
              </span>
            ) : (
              <span>
                This copies the agent's workspace from <code className="break">{lane.workspace}</code> to{' '}
                <code className="break">{target || '…'}</code>. The original workspace stays until you delete the race.
              </span>
            )}
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Per-lane detail
// ---------------------------------------------------------------------------

function LaneDetail({
  race,
  lane,
  hidden,
  picked,
  onPick,
  voting,
}: {
  race: Race;
  lane: Lane;
  hidden: boolean;
  picked: boolean;
  onPick?: (laneId: string) => void;
  voting: boolean;
}) {
  const [keepOpen, setKeepOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ended = isTerminal(lane.state);
  const tokens = totalTokens(lane.metrics.tokens);

  const openFolder = async () => {
    setError(null);
    setMsg(null);
    try {
      await api.openWorkspace(race.id, lane.id);
      setMsg('Opened in your file manager.');
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="lane-detail" style={laneStyle(lane.color)}>
      <div className="detail-head">
        <div>
          <h3>
            <span className="swatch" /> {lane.agentName} <span className="muted">{laneSecondary(lane, hidden)}</span>
            {lane.round > 1 && <span className="tag round" title={`Follow-up round ${lane.round}`}>round {lane.round}</span>}
            {picked && <PickTag />}
          </h3>
          <p className="muted small">
            {fmtDuration(lane.metrics.time.wallMs)}, {tokens === null ? 'tokens not reported' : `${fmtInt(tokens)} tokens`}
            {lane.stateReason ? `. ${lane.stateReason}` : ''}
          </p>
        </div>
        <div className="row wrap">
          {onPick && (
            <button type="button" className="btn pick" onClick={() => onPick(lane.id)} disabled={voting}>
              Pick this one
            </button>
          )}
          {!hidden && (
            <>
              <button type="button" className="btn primary" onClick={() => setKeepOpen(true)} disabled={!ended} title={ended ? undefined : 'Available when this agent has ended'}>
                Keep this one
              </button>
              <button type="button" className="btn" onClick={openFolder}>
                <Icon name="folder" size={14} /> Open workspace folder
              </button>
            </>
          )}
        </div>
      </div>
      {lane.kept && (
        <p className="note ok">
          <Icon name="check" size={15} />
          <span>
            Kept as {lane.kept.mode} <code className="break">{lane.kept.target}</code>
          </span>
        </p>
      )}
      {msg && <p className="muted small">{msg}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {hidden ? (
        <p className="note">
          <span>
            The final message, the code changes, the workspace folder and “Keep this one” are {HIDDEN_TEXT}, because they would give
            the agent away. Try the result in the Previews view, then pick.
          </span>
        </p>
      ) : (
        <>
          <p className="muted small">
            Workspace <code className="break">{lane.workspace}</code>
            {lane.branch ? (
              <>
                {' '}
                on branch <code>{lane.branch}</code>
              </>
            ) : null}
          </p>

          <h4>Final message from the agent</h4>
          {lane.finalMessage ? <pre className="final-message">{lane.finalMessage}</pre> : <p className="muted">This agent left no final message.</p>}

          <h4>Changes</h4>
          <DiffViewer raceId={race.id} laneId={lane.id} ended={ended} />
        </>
      )}

      {keepOpen && <KeepDialog race={race} lane={lane} onClose={() => setKeepOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI judge
// ---------------------------------------------------------------------------

function JudgePanel({ race, agents }: { race: Race; agents: AgentInfo[] | null }) {
  // Mock agents only judge when nothing real can.
  const judges = useMemo(() => {
    const can = (agents ?? []).filter((a) => a.canJudge);
    const real = can.filter((a) => a.kind !== 'mock');
    return real.length > 0 ? real : can;
  }, [agents]);
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const judge = judges.find((a) => a.id === agentId) ?? judges[0] ?? null;
  const models = useMemo(() => {
    const list = Array.isArray(judge?.models) ? judge.models.slice() : [];
    if (!list.includes('')) list.unshift('');
    return list;
  }, [judge]);
  const isCustom = custom || !models.includes(model);
  const done = allDone(race.lanes);
  const judged = race.lanes.filter((l) => l.judge);
  const working = race.judging || busy;

  const ask = async () => {
    if (!judge) return;
    setBusy(true);
    setError(null);
    try {
      const m = model.trim();
      await api.judge(race.id, m ? { agentId: judge.id, model: m } : { agentId: judge.id });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="judge" aria-label="AI judge">
      <div className="section-head">
        <h2>
          AI judge <OpinionTag />
        </h2>
      </div>
      <p className="muted small">
        Ask one of your agents to read each result and score it out of 10. This is one AI model's opinion, not a measurement. The
        judge is not told which agent built what, and its score never changes the finishing order unless you choose to rank by it.
      </p>

      {agents === null ? (
        <p className="loading">
          <Spinner /> Looking for agents that can judge…
        </p>
      ) : !judge ? (
        <p className="muted">No agent can judge right now. A judge has to be installed and signed in.</p>
      ) : (
        <form
          className="judge-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!working && done) void ask();
          }}
        >
          <label className="field">
            <span>Judge</span>
            <select
              value={judge.id}
              onChange={(ev) => {
                setAgentId(ev.target.value);
                setModel('');
                setCustom(false);
              }}
            >
              {judges.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <select
              value={isCustom ? '__custom' : model}
              onChange={(ev) => {
                const v = ev.target.value;
                if (v === '__custom') {
                  setCustom(true);
                  setModel('');
                } else {
                  setCustom(false);
                  setModel(v);
                }
              }}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m === '' ? 'Default model' : m}
                </option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
          </label>
          {isCustom && (
            <label className="field">
              <span>Model name</span>
              <input type="text" className="mono" value={model} onChange={(ev) => setModel(ev.target.value)} placeholder="model name" spellCheck={false} />
            </label>
          )}
          <button type="submit" className="btn primary" disabled={working || !done} title={done ? undefined : 'Available when every agent has ended'}>
            {judged.length > 0 ? 'Ask the judge again' : 'Ask the judge'}
          </button>
        </form>
      )}

      {race.judging && (
        <p className="loading" role="status">
          <Spinner /> The judge is reading each result. This can take a few minutes; scores appear here as they arrive.
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {race.judgeError && !race.judging && <ErrorNote>The judge did not finish: {race.judgeError}</ErrorNote>}

      {judged.length > 0 && (
        <div className="verdicts">
          {judged.map((lane) => {
            const v = lane.judge!;
            return (
              <article key={lane.id} className="verdict" style={laneStyle(lane.color)}>
                <header className="verdict-head">
                  <h3>{lane.agentName}</h3>
                  <span className="verdict-score" title={OPINION_TOOLTIP}>
                    {judgeScoreText(v.score).replace('/10', '')}
                    <small>/10</small>
                  </span>
                  <OpinionTag />
                </header>
                {v.summary && <p>{v.summary}</p>}
                {v.strengths.length > 0 && (
                  <>
                    <h4>Strengths</h4>
                    <ul>
                      {v.strengths.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {v.problems.length > 0 && (
                  <>
                    <h4>Problems</h4>
                    <ul>
                      {v.problems.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="muted small verdict-by">
                  Judged by {v.judgeAgent} ({v.judgeModel || 'default model'})
                </p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Results view
// ---------------------------------------------------------------------------

interface ResultsProps {
  /** The race as shown: already anonymised while `hidden`. */
  race: Race;
  hidden?: boolean;
  pickedLaneId?: string | null;
  /** null while the agent list is loading. */
  agents?: AgentInfo[] | null;
  /** Present once a blind race is ready for its vote. */
  onPick?: (laneId: string) => void;
  voting?: boolean;
}

export function Results({ race, hidden = false, pickedLaneId = null, agents = null, onPick, voting = false }: ResultsProps) {
  const [sort, setSort] = useState<SortKey>('time');
  const [laneId, setLaneId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lanes = race.lanes;
  const done = allDone(lanes);
  const ranked = useMemo(() => sortLanes(lanes, sort), [lanes, sort]);
  const positions = useMemo(() => finishPositions(lanes), [lanes]);
  const current = lanes.find((l) => l.id === laneId) ?? ranked[0] ?? null;
  const repoMode = race.setup.source.type === 'repo';

  const raceAgain = () => {
    rememberSetup(race.setup);
    navigate('#/');
  };

  const deleteRace = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteRace(race.id);
      navigate('#/history');
    } catch (err) {
      setError(errorText(err));
      setDeleting(false);
    }
  };

  if (lanes.length === 0) {
    return (
      <div className="results">
        <p className="muted">This race has no lanes, so there is nothing to compare.</p>
        <div className="row">
          <button type="button" className="btn" onClick={raceAgain}>
            Race again
          </button>
          <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
            Delete race
          </button>
        </div>
        {confirmDelete && (
          <DeleteDialog repoMode={repoMode} raceId={race.id} busy={deleting} error={error} onCancel={() => setConfirmDelete(false)} onConfirm={deleteRace} />
        )}
      </div>
    );
  }

  return (
    <div className="results">
      {!done && (
        <p className="note warn" role="status">
          <Icon name="clock" size={15} />
          <span>
            <strong>Race still running.</strong> These results are partial and will change.
          </span>
        </p>
      )}

      <div className="results-top">
        <Podium race={race} ranked={ranked} sort={sort} onSort={setSort} hidden={hidden} pickedLaneId={pickedLaneId} />
        <ShareCard race={race} ranked={ranked} hidden={hidden} />
      </div>

      <JudgePanel race={race} agents={agents} />

      <ComparisonTable lanes={lanes} hidden={hidden} pickedLaneId={pickedLaneId} />

      <section className="details" aria-label="Each agent's work">
        <div className="section-head">
          <h2>What each agent built</h2>
        </div>
        <div className="detail-tabs" role="tablist">
          {lanes.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={current?.id === l.id}
              className={`detail-tab${current?.id === l.id ? ' active' : ''}`}
              style={laneStyle(l.color)}
              onClick={() => setLaneId(l.id)}
            >
              <span className="swatch" />
              {l.agentName}
              {positions.get(l.id) ? <span className="muted"> #{positions.get(l.id)}</span> : null}
              {pickedLaneId === l.id && <PickTag />}
            </button>
          ))}
        </div>
        {current && (
          <LaneDetail key={current.id} race={race} lane={current} hidden={hidden} picked={pickedLaneId === current.id} onPick={onPick} voting={voting} />
        )}
      </section>

      <section className="race-tools" aria-label="Race actions">
        <a className="btn" href={api.exportUrl(race.id)} download={`agent-derby-${race.id}.json`}>
          <Icon name="download" size={14} /> Export JSON
        </a>
        <a
          className="btn"
          href={api.replayUrl(race.id)}
          download={`agent-derby-${race.id}.html`}
          title="A single web page that replays this race. Anyone can open it; nothing is uploaded."
        >
          <Icon name="download" size={14} /> Download replay (HTML)
        </a>
        <button type="button" className="btn" onClick={raceAgain}>
          <Icon name="reload" size={14} /> Race again
        </button>
        <span className="grow" />
        <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" size={14} /> Delete race
        </button>
      </section>

      {confirmDelete && (
        <DeleteDialog repoMode={repoMode} raceId={race.id} busy={deleting} error={error} onCancel={() => setConfirmDelete(false)} onConfirm={deleteRace} />
      )}
    </div>
  );
}

export function DeleteDialog({
  repoMode,
  raceId,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  repoMode: boolean;
  raceId: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="Delete this race?"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger solid" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete race'}
          </button>
        </>
      }
    >
      <p>This removes the race record and every agent's workspace folder. It cannot be undone.</p>
      {repoMode && (
        <p>
          It also deletes this race's branches in your repository, <code>agent-derby/{raceId}/*</code>. Your other branches and
          your working tree are not touched.
        </p>
      )}
      <p className="muted">Anything you saved with “Keep this one” under another branch name or folder stays.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
