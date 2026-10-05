import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { laneSecondary, useRaceDisplay } from '../display';
import { allDone, finishPositions, fmtDate, isLive, shortSha } from '../format';
import { suiteHash } from '../router';
import { isTerminal } from '../types';
import type { AgentInfo, FeedItem, Lane, Race } from '../types';
import { useRace } from '../useRace';
import { LaneColumn, type LaneTab } from './LaneColumn';
import { Preview } from './Preview';
import { Results } from './Results';
import { Clock, CopyButton, ErrorNote, Icon, Modal, Spinner, StateBadge, laneStyle } from './ui';

type View = 'lanes' | 'previews' | 'results';

const NO_FEED: FeedItem[] = [];

const RACE_STATE_LABELS: Record<string, string> = {
  preparing: 'preparing workspaces',
  running: 'racing',
  finished: 'finished',
  interrupted: 'interrupted',
};

function raceEndedMs(race: Race): number {
  if (!race.startedAt) return 0;
  const end = race.endedAt ?? Math.max(0, ...race.lanes.map((l) => l.endedAt ?? 0));
  if (end > race.startedAt) return end - race.startedAt;
  return Math.max(0, ...race.lanes.map((l) => l.metrics.time.wallMs));
}

export function RacePage({ raceId }: { raceId: string }) {
  const { race: realRace, feeds, fullFeeds, loading, error, status, loadFullFeed } = useRace(raceId);
  // Everything below renders from `race`, which is the anonymised copy while a blind race awaits its vote.
  const display = useRaceDisplay(realRace);
  const race = display?.race ?? null;
  const hidden = display?.hidden ?? false;
  const pickedLaneId = display?.pickedLaneId ?? null;
  const [view, setView] = useState<View>('lanes');
  const [tabs, setTabs] = useState<Record<string, LaneTab>>({});
  const [taskOpen, setTaskOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [voting, setVoting] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [sending, setSending] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  // The agent list says which agents can take a follow-up and which can judge. Fetched once.
  useEffect(() => {
    let alive = true;
    api
      .agents()
      .then((list) => alive && setAgents(Array.isArray(list) ? list : []))
      .catch(() => alive && setAgents([]));
    return () => {
      alive = false;
    };
  }, []);

  // A race that is already over when opened (from history, or a reload) lands on Results.
  const decided = useRef<string | null>(null);
  useEffect(() => {
    if (!race || decided.current === race.id) return;
    decided.current = race.id;
    setView(allDone(race.lanes) || race.state === 'finished' || race.state === 'interrupted' ? 'results' : 'lanes');
  }, [race]);

  // Leaving the race page stops this race's previews on the server.
  useEffect(() => {
    const onHide = () => {
      try {
        navigator.sendBeacon(api.closeUrl(raceId));
      } catch {
        /* nothing more can be done while the page goes away */
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      api.closeRace(raceId).catch(() => undefined);
    };
  }, [raceId]);

  const onTab = useCallback((laneId: string, tab: LaneTab) => {
    setTabs((t) => (t[laneId] === tab ? t : { ...t, [laneId]: tab }));
  }, []);

  // The first time a lane's preview becomes ready, show it. Once per lane and round, so the user's own
  // choice sticks afterwards, and a follow-up round shows its new result again.
  const autoShown = useRef(new Set<string>());
  const seenRound = useRef(new Map<string, number>());
  useEffect(() => {
    if (!race) return;
    for (const lane of race.lanes) {
      // A follow-up started: go back to the activity, once, so the new round can be watched.
      const before = seenRound.current.get(lane.id);
      seenRound.current.set(lane.id, lane.round);
      if (before !== undefined && lane.round > before) onTab(lane.id, 'activity');

      // In a later round the previous preview may still be up while the agent works; wait for the lane to end.
      const key = `${lane.id}:${lane.round}`;
      const resultReady = lane.preview.status === 'ready' && (lane.round <= 1 || isTerminal(lane.state));
      if (resultReady && !autoShown.current.has(key)) {
        autoShown.current.add(key);
        onTab(lane.id, 'preview');
      }
    }
  }, [race, onTab]);

  const vote = useCallback(
    async (laneId: string | null) => {
      setVoting(true);
      setActionError(null);
      try {
        await api.vote(raceId, { laneId });
      } catch (err) {
        setActionError(errorText(err));
      } finally {
        setVoting(false);
      }
    },
    [raceId],
  );

  const positions = useMemo(() => (race ? finishPositions(race.lanes) : new Map<string, number>()), [race]);

  if (!race) {
    return (
      <div className="page narrow">
        {loading && !error && (
          <p className="loading">
            <Spinner /> Loading the race…
          </p>
        )}
        {error && (
          <div className="empty">
            <h1>This race could not be opened</h1>
            <ErrorNote>{error}</ErrorNote>
            <p>
              It may have been deleted. <a href="#/history">See past races</a> or <a href="#/">start a new one</a>.
            </p>
          </div>
        )}
      </div>
    );
  }

  const lanes = race.lanes;
  const anyActive = lanes.some((l) => !isTerminal(l.state));
  const done = allDone(lanes);
  const racing = anyActive && (race.state === 'running' || race.state === 'preparing');
  const task = race.setup.task || '(no task text)';
  const readyPreviews = lanes.filter((l) => l.preview.status === 'ready').length;
  const rounds = race.rounds;
  const canPick = hidden && done;
  const pickedLane = pickedLaneId ? lanes.find((l) => l.id === pickedLaneId) : undefined;

  const resumable = new Set((agents ?? []).filter((a) => a.canResume).map((a) => a.id));
  const continuing = lanes.filter((l) => resumable.has(l.agentId)).length;
  const canFollowUp = done && continuing > 0 && race.state !== 'preparing';

  const sendFollowUp = async () => {
    const prompt = followUp.trim();
    if (!prompt || sending) return;
    setSending(true);
    setFollowError(null);
    try {
      await api.followUp(race.id, { prompt });
      setFollowUp('');
      setView('lanes');
    } catch (err) {
      setFollowError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const stopRace = async () => {
    setStopping(true);
    setActionError(null);
    try {
      await api.stopRace(race.id);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className={`race${racing ? ' is-racing' : ''}`}>
      <header className="race-head">
        <div className="race-task">
          <button
            type="button"
            className={`task-text${taskOpen ? ' open' : ''}`}
            onClick={() => setTaskOpen((o) => !o)}
            aria-expanded={taskOpen}
            title={taskOpen ? 'Collapse' : 'Show the whole task'}
          >
            {task}
          </button>
          <div className="race-meta">
            <span className={`race-state rs-${race.state}`}>{RACE_STATE_LABELS[race.state] ?? race.state}</span>
            <span>{race.setup.source.type === 'repo' ? `from ${race.setup.source.path}` : 'from an empty project'}</span>
            {race.promptSha256 && (
              <button
                type="button"
                className="sha"
                onClick={() => setPromptOpen(true)}
                title="Every agent received the identical prompt, byte for byte. Click to read it."
              >
                prompt sha256 <code>{shortSha(race.promptSha256)}</code>
              </button>
            )}
            {rounds.length > 0 && (
              <button type="button" className="sha" onClick={() => setPromptOpen(true)} title="Read the follow-up prompts">
                {rounds.length === 1 ? '1 follow-up' : `${rounds.length} follow-ups`}, round {rounds.length + 1}
              </button>
            )}
            {race.blind && hidden && <span>blind race</span>}
            {race.blind && !hidden && (
              <span className="race-vote" title="This was a blind race. The agents were hidden until this point.">
                {pickedLane ? (
                  <>
                    You picked: <strong>{pickedLane.agentName}</strong>
                  </>
                ) : (
                  'Revealed without a vote'
                )}
              </span>
            )}
            {race.suiteId && (
              <a className="suite-link" href={suiteHash(race.suiteId)}>
                part of suite →
              </a>
            )}
            {status !== 'open' && (
              <span className="reconnecting" role="status">
                <Spinner /> reconnecting…
              </span>
            )}
          </div>
        </div>

        <div className="race-clock" title="Race clock">
          <Clock running={racing} startedAt={race.startedAt} finalMs={raceEndedMs(race)} />
        </div>

        <div className="race-actions">
          <div className="segmented" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'lanes'} className={view === 'lanes' ? 'active' : ''} onClick={() => setView('lanes')}>
              Lanes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'previews'}
              className={view === 'previews' ? 'active' : ''}
              onClick={() => setView('previews')}
            >
              Previews{readyPreviews > 0 ? ` (${readyPreviews})` : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'results'}
              className={`${view === 'results' ? 'active' : ''}${done && view !== 'results' ? ' nudge' : ''}`}
              onClick={() => setView('results')}
            >
              Results
            </button>
          </div>
          {anyActive && (
            <button type="button" className="btn danger" onClick={stopRace} disabled={stopping}>
              <Icon name="stop" size={14} /> Stop race
            </button>
          )}
        </div>
      </header>

      {race.error && <ErrorNote>The race could not be prepared: {race.error}</ErrorNote>}
      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      {hidden && (
        <div className="blind-banner" role="status">
          <span className="blind-mark" aria-hidden="true">
            ?
          </span>
          <span className="blind-text">
            <strong>Blind race: agents are hidden.</strong> Try the results, then pick the one you like best.
          </span>
          {canPick && (
            <button type="button" className="link" onClick={() => void vote(null)} disabled={voting}>
              Reveal without voting
            </button>
          )}
        </div>
      )}

      {canFollowUp && (
        <form
          className="followup"
          onSubmit={(ev) => {
            ev.preventDefault();
            void sendFollowUp();
          }}
        >
          <div className="followup-head">
            <label className="followup-label" htmlFor="followup">
              Send a follow-up to every agent
            </label>
            <span className="muted small">
              Every agent that can continue gets this same prompt and carries on in its own workspace.
              {!hidden && continuing < lanes.length ? ` ${continuing} of ${lanes.length} agents here can continue; the others stay as they are.` : ''}
            </span>
          </div>
          <textarea
            id="followup"
            rows={1}
            value={followUp}
            onChange={(ev) => setFollowUp(ev.target.value)}
            placeholder="Ask for a change, a fix or the next step."
            onKeyDown={(ev) => {
              if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') void sendFollowUp();
            }}
          />
          <button type="submit" className="btn primary" disabled={sending || !followUp.trim()}>
            {sending ? 'Sending…' : `Send, round ${rounds.length + 2}`}
          </button>
          {followError && <ErrorNote>{followError}</ErrorNote>}
        </form>
      )}

      {lanes.length === 0 && !race.error && (
        <p className="loading">
          <Spinner /> Preparing the workspaces…
        </p>
      )}

      {view === 'lanes' && lanes.length > 0 && (
        <div className="lanes" style={{ ['--lane-count' as string]: lanes.length }}>
          {lanes.map((lane, i) => (
            <LaneColumn
              key={lane.id}
              raceId={race.id}
              lane={lane}
              number={i + 1}
              position={positions.get(lane.id)}
              feed={feeds[lane.id] ?? NO_FEED}
              fullLoaded={!!fullFeeds[lane.id]}
              onLoadFull={loadFullFeed}
              tab={tabs[lane.id] ?? 'activity'}
              onTab={onTab}
              hidden={hidden}
              picked={pickedLaneId === lane.id}
              onPick={canPick ? vote : undefined}
              voting={voting}
            />
          ))}
        </div>
      )}

      {view === 'previews' && lanes.length > 0 && (
        <div className="previews" style={{ ['--lane-count' as string]: lanes.length }}>
          {lanes.map((lane, i) => (
            <PreviewCell
              key={lane.id}
              raceId={race.id}
              lane={lane}
              number={i + 1}
              hidden={hidden}
              picked={pickedLaneId === lane.id}
              onPick={canPick ? vote : undefined}
              voting={voting}
            />
          ))}
        </div>
      )}

      {view === 'results' && (
        <Results race={race} hidden={hidden} pickedLaneId={pickedLaneId} agents={agents} onPick={canPick ? vote : undefined} voting={voting} />
      )}

      {promptOpen && (
        <Modal
          title="The prompt every agent received"
          onClose={() => setPromptOpen(false)}
          wide
          footer={
            <>
              <span className="muted grow">
                sha256 <code className="break">{race.promptSha256}</code>
              </span>
              <CopyButton text={race.prompt} label="Copy prompt" className="btn" />
            </>
          }
        >
          <p className="muted">Identical for every lane, byte for byte. The hash lets anyone check that.</p>
          <pre className="prompt-pre">{race.prompt || '(the server did not send the prompt text)'}</pre>
          {rounds.length > 0 && (
            <p className="muted rounds-note">
              Follow-ups, each sent to every agent that could continue. The hash above covers the first prompt only.
            </p>
          )}
          {rounds.map((r, i) => (
            <div className="round" key={i}>
              <h4>
                Round {i + 2}: <span className="muted">{r.at ? fmtDate(r.at) : ''}</span>
              </h4>
              <pre className="prompt-pre">{r.prompt}</pre>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}

function PreviewCell({
  raceId,
  lane,
  number,
  hidden,
  picked,
  onPick,
  voting,
}: {
  raceId: string;
  lane: Lane;
  number: number;
  hidden: boolean;
  picked: boolean;
  /** Present once a blind race is ready for its vote. */
  onPick?: (laneId: string) => void;
  voting: boolean;
}) {
  return (
    <section className="preview-cell" style={laneStyle(lane.color)} aria-label={`Preview of ${lane.agentName}`}>
      <header className="preview-cell-head">
        <span className="chip-num">{number}</span>
        <strong title={lane.agentName}>{lane.agentName}</strong>
        {!hidden && <span className="muted ellipsis">{laneSecondary(lane, hidden)}</span>}
        {picked && <span className="tag pick">your pick</span>}
        <span className="grow" />
        {onPick && (
          <button type="button" className="btn pick small" onClick={() => onPick(lane.id)} disabled={voting}>
            Pick this one
          </button>
        )}
        {isLive(lane.state) && <Clock running startedAt={lane.startedAt} finalMs={lane.metrics.time.wallMs} />}
        <StateBadge state={lane.state} />
      </header>
      <div className="preview-cell-body">
        <Preview raceId={raceId} lane={lane} />
      </div>
    </section>
  );
}
