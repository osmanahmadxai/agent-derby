import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, errorText } from './api';
import { normalizeLane, normalizeRace, upsertFeed } from './format';
import { hub, type SocketStatus } from './socket';
import type { FeedItem, Lane, Race, ServerMessage } from './types';

export interface RaceView {
  race: Race | null;
  /** Feed items per lane id, sorted by seq. */
  feeds: Record<string, FeedItem[]>;
  /** Lanes whose complete history has been fetched over REST. */
  fullFeeds: Record<string, boolean>;
  loading: boolean;
  error: string | null;
}

type Action =
  | { type: 'reset' }
  | { type: 'messages'; raceId: string; messages: ServerMessage[] }
  | { type: 'rest'; race: Race }
  | { type: 'error'; error: string }
  | { type: 'fullFeed'; laneId: string; items: FeedItem[] };

const initial: RaceView = { race: null, feeds: {}, fullFeeds: {}, loading: true, error: null };

/** Exported for tests: applies server messages to the view state. */
export function reduceRace(state: RaceView, action: Action): RaceView {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'rest':
      // The WebSocket snapshot plus patches is always at least as fresh as a REST read.
      if (state.race) return state;
      return { ...state, race: normalizeRace(action.race), loading: false, error: null };
    case 'error':
      if (state.race) return state;
      return { ...state, loading: false, error: action.error };
    case 'fullFeed':
      return {
        ...state,
        feeds: { ...state.feeds, [action.laneId]: upsertFeed(state.feeds[action.laneId] ?? [], action.items) },
        fullFeeds: { ...state.fullFeeds, [action.laneId]: true },
      };
    case 'messages': {
      let race = state.race;
      let feeds = state.feeds;
      let loading = state.loading;
      let error = state.error;
      for (const msg of action.messages) {
        switch (msg.type) {
          case 'race':
            if (msg.race && msg.race.id === action.raceId) {
              race = normalizeRace(msg.race);
              loading = false;
              error = null;
            }
            break;
          case 'race_patch':
            if (race && msg.raceId === action.raceId && msg.patch) {
              const patch = msg.patch;
              race = { ...race, ...patch };
              if (patch.lanes) race.lanes = patch.lanes.map(normalizeLane);
            }
            break;
          case 'lane':
            if (race && msg.raceId === action.raceId && msg.patch) {
              const idx = race.lanes.findIndex((l) => l.id === msg.laneId);
              if (idx >= 0) {
                const merged: Lane = normalizeLane({ ...race.lanes[idx]!, ...msg.patch });
                const lanes = race.lanes.slice();
                lanes[idx] = merged;
                race = { ...race, lanes };
              }
            }
            break;
          case 'feed':
            if (msg.raceId === action.raceId && Array.isArray(msg.items)) {
              const prev = feeds[msg.laneId] ?? [];
              const next = upsertFeed(prev, msg.items);
              if (next !== prev || !(msg.laneId in feeds)) feeds = { ...feeds, [msg.laneId]: next };
            }
            break;
          default:
            break;
        }
      }
      if (race === state.race && feeds === state.feeds && loading === state.loading && error === state.error) {
        return state;
      }
      return { ...state, race, feeds, loading, error };
    }
  }
}

export interface UseRace extends RaceView {
  status: SocketStatus;
  /** Fetches the complete feed history of one lane over REST. */
  loadFullFeed: (laneId: string) => Promise<void>;
}

/** Owns the WebSocket subscription and the reduction of server messages for one race. */
export function useRace(raceId: string): UseRace {
  const [state, dispatch] = useReducer(reduceRace, initial);
  const [status, setStatus] = useState<SocketStatus>(hub.status());
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    dispatch({ type: 'reset' });
    inflight.current.clear();
    let alive = true;

    // Messages are batched so a burst of streamed tokens costs one render.
    let queue: ServerMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!alive || queue.length === 0) return;
      const messages = queue;
      queue = [];
      dispatch({ type: 'messages', raceId, messages });
    };
    const offMessage = hub.onMessage((msg) => {
      if (msg.type !== 'race' && msg.type !== 'race_patch' && msg.type !== 'lane' && msg.type !== 'feed') return;
      queue.push(msg);
      if (!timer) timer = setTimeout(flush, 40);
    });
    const offStatus = hub.onStatus(setStatus);
    setStatus(hub.status());
    const unsubscribe = hub.subscribeRace(raceId);

    // REST fallback: gives a view even when the socket is slow, and a clear error for an unknown race.
    api
      .race(raceId)
      .then((race) => {
        if (alive && race) dispatch({ type: 'rest', race });
      })
      .catch((err) => {
        if (alive) dispatch({ type: 'error', error: errorText(err) });
      });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offMessage();
      offStatus();
      unsubscribe();
    };
  }, [raceId]);

  const loadFullFeed = useCallback(
    async (laneId: string) => {
      if (inflight.current.has(laneId)) return;
      inflight.current.add(laneId);
      try {
        const items = await api.feed(raceId, laneId);
        dispatch({ type: 'fullFeed', laneId, items: Array.isArray(items) ? items : [] });
      } finally {
        inflight.current.delete(laneId);
      }
    },
    [raceId],
  );

  return { ...state, status, loadFullFeed };
}
