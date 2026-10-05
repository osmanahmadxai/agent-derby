import path from 'node:path';
import type { TokenUsage } from '../../shared/types.js';
import { homeDir, packageFile, readJson } from '../paths.js';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type PriceTable = Record<string, Price>;

/** config/pricing.json, with the user's ~/.agent-derby/pricing.json layered on top. */
export function loadPrices(): PriceTable {
  const shipped = readJson<{ models?: PriceTable }>(packageFile('config', 'pricing.json'), {});
  const user = readJson<{ models?: PriceTable }>(path.join(homeDir(), 'pricing.json'), {});
  return { ...(shipped.models ?? {}), ...(user.models ?? {}) };
}

export function findPrice(prices: PriceTable, model: string | null): Price | null {
  if (!model) return null;
  const name = model.toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(prices)) {
    const k = key.toLowerCase();
    if (name === k || name.startsWith(k)) if (!best || k.length > best.length) best = key;
  }
  return best ? prices[best]! : null;
}

/**
 * Estimate cost from the price table. Returns null when the model has no price
 * or no tokens were reported — the caller then shows "not reported".
 */
export function estimateCost(prices: PriceTable, model: string | null, tokens: TokenUsage): number | null {
  const price = findPrice(prices, model);
  if (!price) return null;
  if (tokens.input === null && tokens.output === null) return null;
  const per = (n: number | null, usdPerMillion: number | undefined) => ((n ?? 0) * (usdPerMillion ?? 0)) / 1_000_000;
  return (
    per(tokens.input, price.input) +
    per(tokens.output, price.output) +
    per(tokens.cacheRead, price.cacheRead ?? price.input) +
    per(tokens.cacheWrite, price.cacheWrite ?? price.input)
  );
}
