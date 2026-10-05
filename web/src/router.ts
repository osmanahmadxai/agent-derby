import { useEffect, useState } from 'react';
import type { RaceSetup } from './types';

export type Route = { name: 'setup' } | { name: 'history' } | { name: 'race'; id: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'race' && parts[1]) {
    let id = parts[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep raw */
    }
    return { name: 'race', id };
  }
  if (parts[0] === 'history') return { name: 'history' };
  return { name: 'setup' };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(hash: string) {
  window.location.hash = hash;
}

export const raceHash = (id: string) => `#/race/${encodeURIComponent(id)}`;

// --- "Race again": the last setup survives navigation and reloads within the tab ---------------

const KEY = 'agent-derby:last-setup';
let memory: RaceSetup | null = null;

export function rememberSetup(setup: RaceSetup) {
  memory = setup;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(setup));
  } catch {
    /* storage may be unavailable; module state still works */
  }
}

export function recallSetup(): RaceSetup | null {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RaceSetup;
    if (parsed && typeof parsed === 'object' && typeof parsed.task === 'string') {
      memory = parsed;
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}
