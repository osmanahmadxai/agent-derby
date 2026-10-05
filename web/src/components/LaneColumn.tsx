import { memo, useState } from 'react';
import { api, errorText } from '../api';
import { ESTIMATE_TOOLTIP, fmtCompact, fmtInt, fmtMoney, isLive, laneFilesChanged, ordinal } from '../format';
import { isTerminal, totalTokens } from '../types';
import type { FeedItem, Lane } from '../types';
import { Feed } from './Feed';
import { Preview, PreviewLogs } from './Preview';
import { Clock, Icon, NotReported, StateBadge, laneStyle, nowIcon } from './ui';

export type LaneTab = 'activity' | 'preview' | 'logs';

interface Props {
  raceId: string;
  lane: Lane;
  /** 1-based lane number. */
  number: number;
  /** Finishing position among successful lanes, when this lane finished. */
  position: number | undefined;
  feed: FeedItem[];
  fullLoaded: boolean;
  onLoadFull: (laneId: string) => Promise<void>;
  tab: LaneTab;
  onTab: (laneId: string, tab: LaneTab) => void;
}

const PREVIEW_DOT: Record<string, string> = {
  installing: 'busy',
  building: 'busy',
  starting: 'busy',
  ready: 'ready',
  failed: 'failed',
};

export const LaneColumn = memo(function LaneColumn({
  raceId,
  lane,
  number,
  position,
  feed,
  fullLoaded,
  onLoadFull,
  tab,
  onTab,
}: Props) {
  const m = lane.metrics;
  const live = isLive(lane.state);
  const ended = isTerminal(lane.state);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const tokens = totalTokens(m.tokens);
  const model = m.model || lane.requestedModel;
  const version = m.cliVersion;
  const nowText = lane.now.text || (lane.state === 'pending' ? 'Waiting for the start' : '');

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await api.stopLane(raceId, lane.id);
    } catch (err) {
      setStopError(errorText(err));
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className={`lane lane-${lane.state}${live ? ' is-live' : ''}`} style={laneStyle(lane.color)} aria-label={`Lane ${number}: ${lane.agentName}`}>
      <header className="lane-head">
        <div className="lane-plate" title={position ? `Finished ${ordinal(position)}` : `Lane ${number}`}>
          {position ? (
            <>
              <span className="plate-num">{position}</span>
              <span className="plate-sub">{ordinal(position).slice(-2)}</span>
            </>
          ) : (
            <span className="plate-num">{number}</span>
          )}
        </div>
        <div className="lane-id">
          <h2 title={lane.agentName}>{lane.agentName}</h2>
          <p className="lane-sub" title={[model || 'default model', version ? `CLI ${version}` : null].filter(Boolean).join(', ')}>
            <span>{model || 'default model'}</span>
            {version && <span className="lane-version">CLI {version}</span>}
          </p>
        </div>
        <div className="lane-state">
          <StateBadge state={lane.state} />
          {!ended && lane.state !== 'pending' && (
            <button type="button" className="btn small" onClick={stop} disabled={stopping} title="Stop only this agent">
              <Icon name="stop" size={12} /> Stop
            </button>
          )}
        </div>
      </header>
      <div className="lane-stripe" aria-hidden="true" />

      {(lane.stateReason || stopError) && <p className="lane-reason">{stopError ?? lane.stateReason}</p>}

      <div className={`now now-${lane.now.kind}`} aria-live="off">
        <span className="now-icon">
          <Icon name={nowIcon(lane.now.kind)} size={20} />
        </span>
        <span className="now-text" key={`${lane.now.kind}:${nowText}`} title={nowText}>
          {nowText || ' '}
        </span>
      </div>

      <dl className="counters">
        <div>
          <dd>
            <Clock running={live} startedAt={lane.startedAt} finalMs={m.time.wallMs} />
          </dd>
          <dt>time</dt>
        </div>
        <div>
          <dd title={tokens === null ? undefined : `${fmtInt(tokens)} tokens in total (input, output, cache read and write)`}>
            {tokens === null ? <NotReported /> : fmtCompact(tokens)}
          </dd>
          <dt>tokens</dt>
        </div>
        <div>
          <dd>
            {m.cost.usd === null ? (
              <NotReported />
            ) : (
              <>
                {fmtMoney(m.cost.usd)}
                {m.cost.source === 'estimated' && (
                  <span className="tag est" title={ESTIMATE_TOOLTIP}>
                    est.
                  </span>
                )}
              </>
            )}
          </dd>
          <dt>cost</dt>
        </div>
        <div>
          <dd>{fmtInt(m.activity.toolCalls)}</dd>
          <dt title="Tool calls">tools</dt>
        </div>
        <div>
          <dd>{fmtInt(laneFilesChanged(lane))}</dd>
          <dt title="Files changed">files</dt>
        </div>
      </dl>

      <div className="tabs" role="tablist">
        {(['activity', 'preview', 'logs'] as LaneTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`tab${tab === t ? ' active' : ''}`}
            onClick={() => onTab(lane.id, t)}
          >
            {t === 'activity' ? 'Activity' : t === 'preview' ? 'Preview' : 'Logs'}
            {t === 'preview' && PREVIEW_DOT[lane.preview.status] && (
              <span className={`tab-dot ${PREVIEW_DOT[lane.preview.status]}`} title={`Preview ${lane.preview.status}`} />
            )}
          </button>
        ))}
      </div>

      <div className="lane-body">
        {tab === 'activity' && (
          <Feed
            items={feed}
            feedCount={lane.feedCount}
            fullLoaded={fullLoaded}
            onLoadFull={() => onLoadFull(lane.id)}
            live={!ended}
          />
        )}
        {tab === 'preview' && <Preview raceId={raceId} lane={lane} />}
        {tab === 'logs' && <PreviewLogs raceId={raceId} laneId={lane.id} />}
      </div>
    </section>
  );
});
