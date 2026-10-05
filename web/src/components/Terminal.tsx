import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from '../api';
import type { AgentInfo, TermClientMessage, TermServerMessage } from '../types';
import { Modal } from './ui';

export interface TermHandle {
  /** Restarts the program (or reconnects when the socket has gone away). */
  restart: () => void;
  focus: () => void;
}

type TermStatus = 'connecting' | 'live' | 'exited' | 'closed';

interface Props {
  /** Path + query, e.g. /ws/term?raceId=..&laneId=.. */
  path: string;
  onExit?: (code: number | null) => void;
  autoFocus?: boolean;
}

/** An xterm bound to a /ws/term socket. The program starts when the socket connects. */
export const TermView = forwardRef<TermHandle, Props>(function TermView({ path, onExit, autoFocus }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [command, setCommand] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      restart: () => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          termRef.current?.reset();
          const msg: TermClientMessage = { type: 'restart' };
          ws.send(JSON.stringify(msg));
          setStatus('live');
          setExitCode(null);
          termRef.current?.focus();
        } else {
          setAttempt((n) => n + 1);
        }
      },
      focus: () => termRef.current?.focus(),
    }),
    [],
  );

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    setStatus('connecting');
    setExitCode(null);

    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: {
        background: '#0a0f22',
        foreground: '#e6ebff',
        cursor: '#ffd21f',
        cursorAccent: '#0a0f22',
        selectionBackground: '#3a4a8a',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try {
      term.open(el);
    } catch (err) {
      console.error('agent-derby: terminal failed to open', err);
    }
    termRef.current = term;

    let ws: WebSocket | null = null;
    const send = (msg: TermClientMessage) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const doFit = () => {
      if (disposed || !el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      } catch {
        /* the element may be mid-layout */
      }
    };

    try {
      ws = new WebSocket(wsUrl(path));
    } catch {
      setStatus('closed');
    }
    wsRef.current = ws;
    if (ws) {
      ws.onopen = () => {
        if (disposed) return;
        setStatus('live');
        doFit();
        if (autoFocus) term.focus();
      };
      ws.onmessage = (ev) => {
        if (disposed) return;
        let msg: TermServerMessage;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as TermServerMessage;
        } catch {
          return;
        }
        if (!msg) return;
        if (msg.type === 'data' && typeof msg.data === 'string') {
          term.write(msg.data);
        } else if (msg.type === 'started') {
          setCommand(msg.command ?? null);
          setStatus('live');
          setExitCode(null);
        } else if (msg.type === 'exit') {
          setStatus('exited');
          setExitCode(msg.code ?? null);
          term.write(`\r\n\x1b[2m[program exited${msg.code === null || msg.code === undefined ? '' : ` with code ${msg.code}`}]\x1b[0m\r\n`);
          onExitRef.current?.(msg.code ?? null);
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        setStatus((s) => (s === 'exited' ? s : 'closed'));
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    }

    const dataSub = term.onData((data) => send({ type: 'input', data }));
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => doFit()) : null;
    ro?.observe(el);
    const raf = requestAnimationFrame(doFit);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      dataSub.dispose();
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      wsRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [path, attempt, autoFocus]);

  return (
    <div className="term">
      <div
        className="term-host"
        ref={host}
        onMouseDown={() => {
          // Focus on the next frame so the click itself cannot steal it back.
          requestAnimationFrame(() => termRef.current?.focus());
        }}
      />
      <div className="term-status">
        {status === 'connecting' && <span>Connecting…</span>}
        {status === 'live' && (
          <span title={command ?? undefined}>
            {command ? `Running ${command}` : 'Running'}. Click the terminal to type; arrow keys go to the program.
          </span>
        )}
        {status === 'exited' && <span>Program exited{exitCode === null ? '' : ` with code ${exitCode}`}.</span>}
        {status === 'closed' && (
          <>
            <span>Disconnected.</span>
            <button type="button" className="btn small" onClick={() => setAttempt((n) => n + 1)}>
              Reconnect
            </button>
          </>
        )}
      </div>
    </div>
  );
});

/** The agent CLI's own sign-in flow, in a modal terminal. */
export function LoginModal({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
  const [done, setDone] = useState<number | null | undefined>(undefined);
  return (
    <Modal
      title={`Sign in to ${agent.name}`}
      onClose={onClose}
      wide
      dismissOnBackdrop={false}
      footer={
        <>
          <span className="muted grow">
            {done === undefined
              ? `This is ${agent.name}'s own sign-in. Agent Derby never sees your password or token.`
              : `Sign-in program ended${done === null ? '' : ` with code ${done}`}. Close this window to re-check the sign-in state.`}
          </span>
          <button type="button" className={done === undefined ? 'btn' : 'btn primary'} onClick={onClose}>
            {done === undefined ? 'Close' : 'Done'}
          </button>
        </>
      }
    >
      <div className="login-term">
        <TermView path={`/ws/term?login=${encodeURIComponent(agent.id)}`} autoFocus onExit={(code) => setDone(code)} />
      </div>
    </Modal>
  );
}
