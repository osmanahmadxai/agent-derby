import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { allDone, finishPositions, isLive, laneModel, shortSha } from '../format';
import { isTerminal } from '../types';
import type { FeedItem, Lane, Race } from '../types';
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
  const { race, feeds, fullFeeds, loading, error, status, loadFullFeed } = useRace(raceId);
  const [view, setView] = useState<View>('lanes');
  const [tabs, setTabs] = useState<Record<string, LaneTab>>({});
  const [taskOpen, setTaskOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  // The first time a lane's preview becomes ready, show it. Once per lane, so the user's own choice sticks afterwards.
  const autoShown = useRef(new Set<string>());
  useEffect(() => {
    if (!race) return;
    for (const lane of race.lanes) {
      if (lane.preview.status === 'ready' && !autoShown.current.has(lane.id)) {
        autoShown.current.add(lane.id);
        onTab(lane.id, 'preview');
      }
    }
  }, [race, onTab]);

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
            />
          ))}
        </div>
      )}

      {view === 'previews' && lanes.length > 0 && (
        <div className="previews" style={{ ['--lane-count' as string]: lanes.length }}>
          {lanes.map((lane, i) => (
            <PreviewCell key={lane.id} raceId={race.id} lane={lane} number={i + 1} />
          ))}
        </div>
      )}

      {view === 'results' && <Results race={race} />}

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
        </Modal>
      )}
    </div>
  );
}

function PreviewCell({ raceId, lane, number }: { raceId: string; lane: Lane; number: number }) {
  return (
    <section className="preview-cell" style={laneStyle(lane.color)} aria-label={`Preview of ${lane.agentName}`}>
      <header className="preview-cell-head">
        <span className="chip-num">{number}</span>
        <strong title={lane.agentName}>{lane.agentName}</strong>
        <span className="muted ellipsis">{laneModel(lane)}</span>
        <span className="grow" />
        {isLive(lane.state) && <Clock running startedAt={lane.startedAt} finalMs={lane.metrics.time.wallMs} />}
        <StateBadge state={lane.state} />
      </header>
      <div className="preview-cell-body">
        <Preview raceId={raceId} lane={lane} />
      </div>
    </section>
  );
}
