/**
 * Blind races: the one place that decides how a lane is shown.
 *
 * While a race is blind and the user has not voted, every screen works from a
 * masked copy of the race: lanes are renamed "Agent A", "Agent B", …, put in a
 * shuffled order, given neutral colours, and stripped of every field that names
 * the agent. Components never look at the real race for display, so nothing can
 * leak by being forgotten. Counters (time, tokens, cost, files) are left alone.
 */
import { useMemo } from 'react';
import { HIDDEN_TEXT, laneSub } from './format';
import type { FeedItem, Lane, Race } from './types';

/** Muted and unrelated to any agent's own colour; assigned by letter, not by agent. */
const NEUTRAL_COLORS = ['#6b7a99', '#96866d', '#5f8a84', '#8a6f8f', '#7d8a5f', '#9a7a7a', '#4f6f8f', '#8f8a6a'];

export interface RaceDisplay {
  /** The race as it should be shown. Masked while `hidden`, otherwise the race itself. */
  race: Race;
  /** True while agents are anonymous: a blind race that has not been voted on. */
  hidden: boolean;
  /** The lane the user picked in a blind race, once voted. */
  pickedLaneId: string | null;
}

export function isHidden(race: Race): boolean {
  return race.blind === true && !race.vote;
}

function hash(text: string): number {
  // FNV-1a, 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lane ids in an order that depends only on the race id and the set of lane ids, never on lane order. */
export function blindOrder(raceId: string, laneIds: string[]): string[] {
  return [...laneIds].sort((a, b) => {
    const d = hash(`${raceId}/${a}`) - hash(`${raceId}/${b}`);
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
}

export function blindName(index: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < letters.length ? `Agent ${letters[index]}` : `Agent ${index + 1}`;
}

// Masked copies are cached per source lane, so an unchanged lane keeps its identity across renders.
const maskCache = new WeakMap<Lane, { index: number; masked: Lane }>();

function maskLane(lane: Lane, index: number): Lane {
  const hit = maskCache.get(lane);
  if (hit && hit.index === index) return hit.masked;
  const masked: Lane = {
    ...lane,
    agentName: blindName(index),
    color: NEUTRAL_COLORS[index % NEUTRAL_COLORS.length]!,
    requestedModel: '',
    effort: '',
    commandLine: null,
    finalMessage: null,
    workspace: '',
    branch: null,
    metrics: { ...lane.metrics, model: null, cliVersion: null },
  };
  maskCache.set(lane, { index, masked });
  return masked;
}

export function displayRace(race: Race): RaceDisplay {
  if (!isHidden(race)) {
    return { race, hidden: false, pickedLaneId: race.blind ? (race.vote?.laneId ?? null) : null };
  }
  const order = blindOrder(
    race.id,
    race.lanes.map((l) => l.id),
  );
  const byId = new Map(race.lanes.map((l) => [l.id, l]));
  const lanes = order.map((id, i) => maskLane(byId.get(id)!, i));
  return { race: { ...race, lanes }, hidden: true, pickedLaneId: null };
}

export function useRaceDisplay(race: Race | null): RaceDisplay | null {
  return useMemo(() => (race ? displayRace(race) : null), [race]);
}

/** A lane's secondary line: model and effort, or a placeholder while the race is blind. */
export function laneSecondary(lane: Lane, hidden: boolean): string {
  return hidden ? HIDDEN_TEXT : laneSub(lane);
}

/** Rows of the comparison table that would name the agent. */
export const HIDDEN_METRIC_ROWS = new Set(['modelName', 'modelRequested', 'effort', 'cli', 'cmd']);

/** The feed minus the lines that name the model, while the race is blind. */
export function displayFeed(items: FeedItem[], hidden: boolean): FeedItem[] {
  if (!hidden) return items;
  const out = items.filter((it) => !(it.type === 'system' && /^\s*model\b/i.test(it.text ?? '')));
  return out.length === items.length ? items : out;
}
