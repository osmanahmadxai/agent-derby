/**
 * The single /ws connection shared by the whole app.
 * Reconnects with backoff and re-subscribes to every race that is still wanted.
 */
import { wsUrl } from './api';
import type { ClientMessage, ServerMessage } from './types';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting';

type MessageFn = (msg: ServerMessage) => void;
type StatusFn = (status: SocketStatus) => void;

let ws: WebSocket | null = null;
let status: SocketStatus = 'connecting';
let started = false;
let attempts = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const messageFns = new Set<MessageFn>();
const statusFns = new Set<StatusFn>();
const wanted = new Map<string, number>(); // raceId -> refcount

function setStatus(next: SocketStatus) {
  if (status === next) return;
  status = next;
  statusFns.forEach((fn) => {
    try {
      fn(next);
    } catch {
      /* a listener must not break the socket */
    }
  });
}

function send(msg: ClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* will be re-sent after reconnect */
    }
  }
}

function scheduleReconnect() {
  if (timer) return;
  const delay = Math.min(8000, 400 * 2 ** Math.min(attempts, 5)) + Math.random() * 250;
  attempts += 1;
  timer = setTimeout(() => {
    timer = null;
    open();
  }, delay);
}

function open() {
  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl('/ws'));
  } catch {
    setStatus('reconnecting');
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    attempts = 0;
    setStatus('open');
    for (const raceId of wanted.keys()) send({ type: 'subscribe', raceId });
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    messageFns.forEach((fn) => {
      try {
        fn(msg);
      } catch (err) {
        console.error('agent-derby: message handler failed', err);
      }
    });
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setStatus('reconnecting');
    scheduleReconnect();
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  };
}

export const hub = {
  /** Idempotent. */
  connect() {
    if (started) return;
    started = true;
    open();
  },
  status(): SocketStatus {
    return status;
  },
  onStatus(fn: StatusFn): () => void {
    statusFns.add(fn);
    return () => {
      statusFns.delete(fn);
    };
  },
  onMessage(fn: MessageFn): () => void {
    messageFns.add(fn);
    return () => {
      messageFns.delete(fn);
    };
  },
  /** Subscribe to a race; returns the unsubscribe function. Survives reconnects. */
  subscribeRace(raceId: string): () => void {
    hub.connect();
    const n = wanted.get(raceId) ?? 0;
    wanted.set(raceId, n + 1);
    if (n === 0) send({ type: 'subscribe', raceId });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (wanted.get(raceId) ?? 1) - 1;
      if (left <= 0) {
        wanted.delete(raceId);
        send({ type: 'unsubscribe', raceId });
      } else {
        wanted.set(raceId, left);
      }
    };
  },
};
