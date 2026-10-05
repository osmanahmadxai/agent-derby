import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { isTerminal } from '../types';
import type { Lane, PreviewType } from '../types';
import { TermView, type TermHandle } from './Terminal';
import { ErrorNote, Icon, Spinner } from './ui';

const SOURCE_LABELS = {
  manifest: "run instructions from the agent's manifest",
  detected: 'run instructions detected from the project',
  manual: 'command entered by you',
} as const;

/** Polls the preview log while mounted. */
export function PreviewLogs({ raceId, laneId, pollMs = 2000 }: { raceId: string; laneId: string; pollMs?: number }) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await api.previewLogs(raceId, laneId);
        if (!alive) return;
        setLog(typeof res?.log === 'string' ? res.log : '');
        setError(null);
      } catch (err) {
        if (alive) setError(errorText(err));
      }
      if (alive) timer = setTimeout(load, pollMs);
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [raceId, laneId, pollMs]);

  useEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <div className="logs">
      {error && <ErrorNote>{error}</ErrorNote>}
      <pre
        ref={pre}
        className="logs-pre"
        onScroll={() => {
          const el = pre.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {log === null ? 'Loading logs…' : log === '' ? 'No preview output yet.' : log}
      </pre>
    </div>
  );
}

function ManualBox({
  busy,
  onRun,
  initialCommand,
}: {
  busy: boolean;
  onRun: (command: string, type: PreviewType) => void;
  initialCommand?: string | null;
}) {
  const [command, setCommand] = useState(initialCommand ?? '');
  const [type, setType] = useState<PreviewType>('web');
  return (
    <form
      className="manual-box"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (command.trim()) onRun(command.trim(), type);
      }}
    >
      <label className="field">
        <span>Run it yourself</span>
        <input
          type="text"
          className="mono"
          value={command}
          onChange={(ev) => setCommand(ev.target.value)}
          placeholder="npm run dev"
          spellCheck={false}
        />
      </label>
      <label className="field narrow">
        <span>Shown as</span>
        <select value={type} onChange={(ev) => setType(ev.target.value as PreviewType)}>
          <option value="web">web (a server with a URL)</option>
          <option value="static">static (plain files)</option>
          <option value="terminal">terminal (a program you type into)</option>
        </select>
      </label>
      <button type="submit" className="btn" disabled={busy || !command.trim()}>
        Run command
      </button>
    </form>
  );
}

/**
 * Runs and shows one lane's finished result: an iframe for web/static, an xterm for terminal programs.
 * Everything here is per lane; one lane's preview can never block another.
 */
export function Preview({ raceId, lane }: { raceId: string; lane: Lane }) {
  const p = lane.preview;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const term = useRef<TermHandle>(null);
  const ended = isTerminal(lane.state);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const startAuto = () => act(() => api.startPreview(raceId, lane.id, {}));
  const startManual = (command: string, type: PreviewType) => act(() => api.startPreview(raceId, lane.id, { command, type }));
  const stop = () => act(() => api.stopPreview(raceId, lane.id));

  const sourceLabel = p.source ? SOURCE_LABELS[p.source] : null;

  if (p.status === 'installing' || p.status === 'building' || p.status === 'starting') {
    const what =
      p.status === 'installing' ? 'Installing dependencies' : p.status === 'building' ? 'Building the project' : 'Starting it up';
    const command = p.status === 'installing' ? p.installCommand : p.startCommand;
    return (
      <div className="preview preview-progress">
        <div className="progress-line">
          <Spinner label={what} />
          <strong>{what}…</strong>
        </div>
        {command && <code className="cmd">{command}</code>}
        {sourceLabel && <p className="muted">Using {sourceLabel}.</p>}
        {p.manifestProblem && <p className="muted">Manifest not used: {p.manifestProblem}</p>}
        <div className="row">
          <button type="button" className="btn small" onClick={stop} disabled={busy}>
            <Icon name="stop" size={13} /> Stop
          </button>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    );
  }

  if (p.status === 'ready' && (p.type === 'web' || p.type === 'static')) {
    if (!p.url) {
      return (
        <div className="preview preview-idle">
          <ErrorNote>The preview is running but the server gave no URL to embed. Check the Logs tab.</ErrorNote>
          <button type="button" className="btn small" onClick={stop} disabled={busy}>
            Stop preview
          </button>
        </div>
      );
    }
    return (
      <div className="preview preview-web">
        <div className="preview-bar">
          <button type="button" className="btn ghost icon-only" onClick={() => setFrameKey((k) => k + 1)} title="Reload" aria-label="Reload preview">
            <Icon name="reload" size={15} />
          </button>
          <span className="preview-url" title={sourceLabel ? `${p.url} (${sourceLabel})` : p.url}>
            {p.url}
          </span>
          <a className="btn ghost icon-only" href={p.url} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open preview in a new tab">
            <Icon name="external" size={15} />
          </a>
          <button type="button" className="btn ghost icon-only" onClick={stop} disabled={busy} title="Stop preview" aria-label="Stop preview">
            <Icon name="stop" size={15} />
          </button>
        </div>
        {(p.note || p.manifestProblem) && (
          <p className="preview-note">
            {p.note}
            {p.note && p.manifestProblem ? ' ' : ''}
            {p.manifestProblem ? `Manifest not used: ${p.manifestProblem}` : ''}
          </p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <iframe
          key={frameKey}
          className="preview-frame"
          src={p.url}
          title={`${lane.agentName} preview`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
          allow="clipboard-write; fullscreen; gamepad"
        />
      </div>
    );
  }

  if (p.status === 'ready' && p.type === 'terminal') {
    return (
      <div className="preview preview-term">
        <div className="preview-bar">
          <span className="preview-url" title={sourceLabel ?? undefined}>
            {p.startCommand ?? 'terminal program'}
          </span>
          <button type="button" className="btn small" onClick={() => term.current?.restart()}>
            <Icon name="reload" size={13} /> Restart
          </button>
          <button type="button" className="btn ghost icon-only" onClick={stop} disabled={busy} title="Stop preview" aria-label="Stop preview">
            <Icon name="stop" size={15} />
          </button>
        </div>
        {p.note && <p className="preview-note">{p.note}</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
        <TermView
          ref={term}
          path={`/ws/term?raceId=${encodeURIComponent(raceId)}&laneId=${encodeURIComponent(lane.id)}`}
        />
      </div>
    );
  }

  if (p.status === 'ready') {
    return (
      <div className="preview preview-idle">
        <p>
          <strong>The result is running</strong>, but it has no page or terminal to embed here.
        </p>
        {p.startCommand && <code className="cmd">{p.startCommand}</code>}
        {p.note && <p className="muted">{p.note}</p>}
        <p className="muted">Its output is in the Logs tab.</p>
        <button type="button" className="btn small" onClick={stop} disabled={busy}>
          <Icon name="stop" size={13} /> Stop preview
        </button>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    );
  }

  if (p.status === 'failed') {
    return (
      <div className="preview preview-failed">
        <ErrorNote>{p.error || 'The preview could not be started.'}</ErrorNote>
        {p.manifestProblem && <p className="muted">Manifest not used: {p.manifestProblem}</p>}
        {(p.installCommand || p.startCommand) && (
          <p className="muted">
            Tried{' '}
            {[p.installCommand, p.startCommand]
              .filter((c): c is string => !!c)
              .map((c, i) => (
                <code key={i} className="cmd inline">
                  {c}
                </code>
              ))}
          </p>
        )}
        <div className="row">
          <button type="button" className="btn small" onClick={startAuto} disabled={busy}>
            <Icon name="reload" size={13} /> Try again automatically
          </button>
        </div>
        <ManualBox busy={busy} onRun={startManual} initialCommand={p.startCommand} />
        {error && <ErrorNote>{error}</ErrorNote>}
        <PreviewLogs raceId={raceId} laneId={lane.id} pollMs={4000} />
      </div>
    );
  }

  // none / stopped
  if (!ended) {
    return (
      <div className="preview preview-idle">
        <p className="muted">The preview starts on its own when this agent finishes.</p>
      </div>
    );
  }
  return (
    <div className="preview preview-idle">
      <p>{p.status === 'stopped' ? 'The preview is stopped.' : 'No preview is running for this lane.'}</p>
      <button type="button" className="btn primary" onClick={startAuto} disabled={busy}>
        <Icon name="play" size={14} /> Start preview
      </button>
      <button type="button" className="link" onClick={() => setManualOpen((o) => !o)} aria-expanded={manualOpen}>
        {manualOpen ? 'Hide the command box' : 'Use my own command instead'}
      </button>
      {manualOpen && <ManualBox busy={busy} onRun={startManual} initialCommand={p.startCommand} />}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
