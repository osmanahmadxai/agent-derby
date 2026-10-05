import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NOT_REPORTED, fmtClock, stateLabel } from '../format';
import type { LaneState, NowKind, ToolKind } from '../types';

// ---------------------------------------------------------------------------
// Icons (hand-drawn, 24px grid, stroke only)
// ---------------------------------------------------------------------------

export type IconName =
  | 'clock'
  | 'play'
  | 'dots'
  | 'pen'
  | 'file'
  | 'terminal'
  | 'search'
  | 'globe'
  | 'list'
  | 'branch'
  | 'wrench'
  | 'check'
  | 'flag'
  | 'x'
  | 'copy'
  | 'reload'
  | 'external'
  | 'stop'
  | 'folder'
  | 'download'
  | 'trash'
  | 'chevron'
  | 'plus'
  | 'alert'
  | 'image';

const ICONS: Record<IconName, ReactNode> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5z" />,
  dots: (
    <>
      <circle className="dot d1" cx="5.5" cy="12" r="1.6" />
      <circle className="dot d2" cx="12" cy="12" r="1.6" />
      <circle className="dot d3" cx="18.5" cy="12" r="1.6" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20h4L19.5 8.5l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13.5 3.5v4h4M9.5 12.5h5M9.5 16h5" />
    </>
  ),
  terminal: <path d="M4.5 6.5l5.5 5.5-5.5 5.5M12.5 18h7" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c3.2 3 3.2 14 0 17M12 3.5c-3.2 3-3.2 14 0 17" />
    </>
  ),
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.5M4.5 12h.5M4.5 17.5h.5" />,
  branch: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="7.5" r="2" />
      <path d="M6.5 7.5v9M17.5 9.5c0 4-11 2-11 7" />
    </>
  ),
  wrench: <path d="M14.5 5a4.5 4.5 0 0 0-4.2 6.1L4.5 17l2.5 2.5 5.9-5.8A4.5 4.5 0 0 0 19 9.5l-2.7 2.2-2.5-2.5L16 6.5A4.5 4.5 0 0 0 14.5 5z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  flag: <path d="M5.5 21V4M5.5 4.5h12.5l-2.5 4 2.5 4H5.5" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
    </>
  ),
  reload: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  external: <path d="M13.5 4.5h6v6M19.5 4.5l-8.5 8.5M17.5 13.5v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1" />,
  folder: <path d="M3.5 6.5a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />,
  download: <path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14" />,
  trash: <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  alert: (
    <>
      <path d="M12 4l9 15.5H3z" />
      <path d="M12 10v4.5M12 17v.5" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="M3.5 16l5-5 4 4 3-3 5 5" />
      <circle cx="15.5" cy="9.5" r="1.2" />
    </>
  ),
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon icon-${name}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name] ?? ICONS.wrench}
    </svg>
  );
}

const NOW_ICONS: Record<NowKind, IconName> = {
  waiting: 'clock',
  starting: 'play',
  thinking: 'dots',
  writing: 'pen',
  reading: 'file',
  editing: 'pen',
  running: 'terminal',
  searching: 'search',
  browsing: 'globe',
  planning: 'list',
  delegating: 'branch',
  tool: 'wrench',
  verifying: 'check',
  done: 'flag',
};

export function nowIcon(kind: NowKind): IconName {
  return NOW_ICONS[kind] ?? 'wrench';
}

const TOOL_ICONS: Record<ToolKind, IconName> = {
  read: 'file',
  edit: 'pen',
  command: 'terminal',
  search: 'search',
  web: 'globe',
  plan: 'list',
  agent: 'branch',
  other: 'wrench',
};

export function toolIcon(kind: ToolKind): IconName {
  return TOOL_ICONS[kind] ?? 'wrench';
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export function laneStyle(color: string): CSSProperties {
  return { ['--lane' as string]: color } as CSSProperties;
}

export function StateBadge({ state }: { state: LaneState }) {
  return <span className={`badge state-${state}`}>{stateLabel(state)}</span>;
}

export function NotReported({ title }: { title?: string }) {
  return (
    <span className="not-reported" title={title ?? 'The CLI did not report this value. It is unknown, not zero.'}>
      {NOT_REPORTED}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label ?? 'Working'} />;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  label = 'Copy',
  className = 'btn small',
  icon = true,
}: {
  text: string | (() => string);
  label?: string;
  className?: string;
  icon?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className={className}
      onClick={async (ev) => {
        ev.stopPropagation();
        const ok = await copyText(typeof text === 'function' ? text() : text);
        setState(ok ? 'ok' : 'fail');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), 1600);
      }}
    >
      {icon && <Icon name={state === 'ok' ? 'check' : 'copy'} size={14} />}
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

/** Ticks while `active`; returns the current epoch ms. */
export function useTick(active: boolean, intervalMs = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

/** A stopwatch that ticks client-side from `startedAt` while running, and shows `finalMs` otherwise. */
export function Clock({
  running,
  startedAt,
  finalMs,
  className,
}: {
  running: boolean;
  startedAt: number | null;
  finalMs: number;
  className?: string;
}) {
  const live = running && !!startedAt;
  const now = useTick(live);
  const ms = live ? Math.max(0, now - (startedAt as number)) : finalMs;
  return <span className={`clock${className ? ` ${className}` : ''}`}>{fmtClock(ms)}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
  dismissOnBackdrop = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && dismissOnBackdrop) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [dismissOnBackdrop]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget && dismissOnBackdrop) onClose();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn ghost icon-only" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="note error" role="alert">
      <Icon name="alert" size={15} />
      <span>{children}</span>
    </p>
  );
}
