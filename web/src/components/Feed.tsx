import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorText } from '../api';
import { fmtClock, fmtDuration } from '../format';
import type { FeedItem } from '../types';
import { Icon, Spinner, toolIcon } from './ui';

const PAGE = 400;

const FeedRow = memo(function FeedRow({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const at = `at ${fmtClock(item.t ?? 0)}`;

  if (item.type === 'tool' && item.tool) {
    const tool = item.tool;
    const hasOutput = !!tool.output;
    const label = tool.target || item.text || tool.name;
    return (
      <div className={`feed-item tool status-${tool.status}${open ? ' open' : ''}`} title={at}>
        <button
          type="button"
          className="tool-row"
          onClick={() => hasOutput && setOpen((o) => !o)}
          aria-expanded={hasOutput ? open : undefined}
          disabled={!hasOutput}
          title={hasOutput ? 'Show output' : undefined}
        >
          <Icon name={toolIcon(tool.kind)} size={14} />
          <span className="tool-name">{tool.name}</span>
          <span className="tool-target">{label !== tool.name ? label : ''}</span>
          <span className="tool-meta">
            {tool.durationMs !== null && tool.durationMs !== undefined && <span>{fmtDuration(tool.durationMs)}</span>}
            {tool.status === 'running' && <Spinner label="Running" />}
            {tool.status === 'ok' && <Icon name="check" size={13} className="ok" />}
            {tool.status === 'failed' && (
              <span className="fail">
                <Icon name="x" size={13} />
                {tool.exitCode !== null && tool.exitCode !== undefined ? `exit ${tool.exitCode}` : 'failed'}
              </span>
            )}
          </span>
        </button>
        {open && hasOutput && <pre className="tool-output">{tool.output}</pre>}
      </div>
    );
  }

  const text = item.text ?? '';
  return (
    <div className={`feed-item ${item.type}${item.streaming ? ' streaming' : ''}`} title={at}>
      {text}
      {item.streaming && <span className="caret" aria-hidden="true" />}
    </div>
  );
});

interface Props {
  items: FeedItem[];
  /** Total items the server has for this lane. */
  feedCount: number;
  fullLoaded: boolean;
  onLoadFull: () => Promise<void>;
  live: boolean;
}

/** Scrolling activity feed. Renders at most the last N items; sticks to the bottom unless the user scrolled up. */
export function Feed({ items, feedCount, fullLoaded, onLoadFull, live }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [away, setAway] = useState(false);

  const hiddenLocal = Math.max(0, items.length - limit);
  const missingOnServer = !fullLoaded && feedCount > items.length;
  const visible = hiddenLocal > 0 ? items.slice(items.length - limit) : items;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) {
      // Earlier items were added on top: keep what the user was reading in place.
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  // Becoming visible again (tab switch) should land on the latest activity.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const loadEarlier = async () => {
    const el = scroller.current;
    const keep = el ? el.scrollHeight - el.scrollTop : null;
    setError(null);
    if (hiddenLocal > 0) {
      anchor.current = keep;
      stick.current = false;
      setLimit((n) => n + PAGE);
      return;
    }
    setLoading(true);
    try {
      await onLoadFull();
      anchor.current = keep;
      stick.current = false;
      setLimit((n) => n + PAGE);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="feed-wrap">
      <div
        className="feed"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          stick.current = atBottom;
          setAway(!atBottom);
        }}
      >
        {(hiddenLocal > 0 || missingOnServer) && (
          <div className="feed-earlier">
            <button type="button" className="btn small" onClick={loadEarlier} disabled={loading}>
              {loading
                ? 'Loading…'
                : hiddenLocal > 0
                  ? `Load earlier (${hiddenLocal} more)`
                  : `Load full history (${Math.max(0, feedCount - items.length)} earlier)`}
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        )}
        {visible.length === 0 && !missingOnServer && (
          <p className="feed-empty">{live ? 'Waiting for the first activity…' : 'This lane recorded no activity.'}</p>
        )}
        {visible.map((item) => (
          <FeedRow key={item.seq} item={item} />
        ))}
      </div>
      {away && (
        <button
          type="button"
          className="feed-jump"
          onClick={() => {
            const el = scroller.current;
            if (!el) return;
            stick.current = true;
            el.scrollTop = el.scrollHeight;
            setAway(false);
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
