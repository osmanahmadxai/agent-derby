/**
 * The shareable result card: a 1200x630 PNG drawn by hand on a canvas.
 * Same honesty rules as the table: null is "not reported", estimated cost carries "est.".
 */
import { NOT_REPORTED, allDone, finishPositions, fmtCompact, fmtDuration, fmtMoney, laneSub, shortSha, stateLabel } from './format';
import { totalTokens } from './types';
import type { Lane, Race } from './types';

export const CARD_W = 1200;
export const CARD_H = 630;

const DISPLAY = '"Avenir Next Condensed", "Bahnschrift", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const BODY = '"Avenir Next", "Segoe UI Variable", "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif';

const C = {
  bg: '#0f152b',
  panel: '#171f3d',
  line: '#2b3663',
  ink: '#eaeefb',
  muted: '#93a0c4',
  flag: '#ffd21f',
  good: '#3fd39b',
  bad: '#ff7a66',
};

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = words[i]!;
      if (lines.length === maxLines - 1) {
        line = words.slice(i).join(' ');
        break;
      }
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines).map((l) => fit(ctx, l, maxWidth));
}

function safeColor(ctx: CanvasRenderingContext2D, color: string, fallback: string): string {
  ctx.fillStyle = fallback;
  try {
    ctx.fillStyle = color; // an invalid CSS colour is ignored and the fallback stays
  } catch {
    /* keep fallback */
  }
  return String(ctx.fillStyle);
}

/** `sub` gives a lane's secondary line; the default is its model and effort. */
export function drawShareCard(canvas: HTMLCanvasElement, race: Race, ranked: Lane[], sub: (lane: Lane) => string = laneSub): void {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pad = 56;
  const positions = finishPositions(race.lanes);
  const partial = !allDone(race.lanes);

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Lane markings along the top edge: one dash run per lane colour.
  const stripeY = 0;
  const seg = CARD_W / Math.max(1, ranked.length);
  ranked.forEach((lane, i) => {
    ctx.fillStyle = safeColor(ctx, lane.color, C.muted);
    ctx.fillRect(i * seg, stripeY, seg, 10);
  });

  // Wordmark
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.flag;
  for (let i = 0; i < 3; i++) ctx.fillRect(pad, 46 + i * 9, [26, 38, 18][i]!, 5);
  ctx.fillStyle = C.ink;
  ctx.font = `700 26px ${DISPLAY}`;
  ctx.fillText('agent-derby', pad + 50, 66);

  ctx.font = `500 18px ${BODY}`;
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  const dateText = new Date(race.createdAt || Date.now()).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  ctx.fillText(partial ? `${dateText}, race still running` : dateText, CARD_W - pad, 64);
  ctx.textAlign = 'left';

  // Task
  ctx.fillStyle = C.ink;
  ctx.font = `700 46px ${DISPLAY}`;
  const taskLines = wrap(ctx, race.setup.task || 'Untitled task', CARD_W - pad * 2, 2);
  taskLines.forEach((l, i) => ctx.fillText(l, pad, 132 + i * 52));

  // Table
  const top = 132 + taskLines.length * 52 - 8;
  const bottom = CARD_H - 62;
  const shown = ranked.slice(0, 6);
  const headH = 30;
  const rowH = Math.min(78, (bottom - top - headH) / Math.max(1, shown.length));
  const cols = { pos: pad, name: pad + 86, state: 560, time: 720, cost: 860, tokens: 1010, lines: CARD_W - pad };

  ctx.font = `500 16px ${BODY}`;
  ctx.fillStyle = C.muted;
  ctx.fillText('agent', cols.name, top + 20);
  ctx.fillText('state', cols.state - 110, top + 20);
  ctx.textAlign = 'right';
  ctx.fillText('time', cols.time, top + 20);
  ctx.fillText('cost', cols.cost, top + 20);
  ctx.fillText('tokens', cols.tokens, top + 20);
  ctx.fillText('lines changed', cols.lines, top + 20);
  ctx.textAlign = 'left';

  shown.forEach((lane, i) => {
    const y = top + headH + i * rowH;
    const mid = y + rowH / 2;
    const color = safeColor(ctx, lane.color, C.muted);
    const pos = positions.get(lane.id);
    const big = rowH >= 60;

    ctx.fillStyle = C.line;
    ctx.fillRect(pad, y, CARD_W - pad * 2, 1);

    // position numeral + lane colour bar
    ctx.fillStyle = color;
    ctx.fillRect(cols.pos + 58, y + 10, 8, rowH - 20);
    ctx.font = `700 ${big ? 52 : 36}px ${DISPLAY}`;
    ctx.fillStyle = pos ? (pos === 1 && !partial ? C.flag : C.ink) : C.muted;
    ctx.textAlign = 'right';
    ctx.fillText(pos ? String(pos) : '', cols.pos + 46, mid + (big ? 18 : 13));
    ctx.textAlign = 'left';

    // name + model
    ctx.fillStyle = C.ink;
    ctx.font = `700 ${big ? 30 : 24}px ${DISPLAY}`;
    const nameW = cols.state - 110 - cols.name - 20;
    if (big) {
      ctx.fillText(fit(ctx, lane.agentName, nameW), cols.name, mid - 2);
      ctx.font = `400 17px ${BODY}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(fit(ctx, sub(lane), nameW), cols.name, mid + 22);
    } else {
      ctx.fillText(fit(ctx, `${lane.agentName}  ${sub(lane)}`, nameW), cols.name, mid + 8);
    }

    // state
    ctx.font = `600 19px ${BODY}`;
    ctx.fillStyle = lane.state === 'finished' ? C.good : lane.state === 'running' || lane.state === 'verifying' || lane.state === 'pending' ? C.ink : C.bad;
    ctx.fillText(stateLabel(lane.state), cols.state - 110, mid + 7);

    // numbers
    const numFont = `700 ${big ? 30 : 24}px ${DISPLAY}`;
    const mutedFont = `400 17px ${BODY}`;
    const cell = (x: number, value: string | null, suffix?: string) => {
      ctx.textAlign = 'right';
      if (value === null) {
        ctx.font = mutedFont;
        ctx.fillStyle = C.muted;
        ctx.fillText(NOT_REPORTED, x, mid + 7);
      } else {
        let right = x;
        if (suffix) {
          ctx.font = `600 15px ${BODY}`;
          ctx.fillStyle = C.flag;
          ctx.fillText(suffix, x, mid + 9);
          right = x - ctx.measureText(suffix).width - 6;
        }
        ctx.font = numFont;
        ctx.fillStyle = C.ink;
        ctx.fillText(value, right, mid + 10);
      }
      ctx.textAlign = 'left';
    };
    const m = lane.metrics;
    const tokens = totalTokens(m.tokens);
    cell(cols.time, fmtDuration(m.time.wallMs));
    cell(cols.cost, m.cost.usd === null ? null : fmtMoney(m.cost.usd), m.cost.usd !== null && m.cost.source === 'estimated' ? 'est.' : undefined);
    cell(cols.tokens, tokens === null ? null : fmtCompact(tokens));
    cell(cols.lines, m.code ? `+${fmtCompact(m.code.linesAdded)} −${fmtCompact(m.code.linesRemoved)}` : null);
  });

  // Footer
  ctx.fillStyle = C.line;
  ctx.fillRect(pad, CARD_H - 54, CARD_W - pad * 2, 1);
  ctx.font = `400 16px ${BODY}`;
  ctx.fillStyle = C.muted;
  const more = ranked.length > shown.length ? `  +${ranked.length - shown.length} more lanes not shown.` : '';
  const est = shown.some((l) => l.metrics.cost.source === 'estimated' && l.metrics.cost.usd !== null) ? '  est. = computed from a price table, not measured.' : '';
  ctx.fillText(
    fit(ctx, `Identical prompt for every agent, sha256 ${shortSha(race.promptSha256, 12)}.${est}${more}`, CARD_W - pad * 2),
    pad,
    CARD_H - 24,
  );
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode the image.'))), 'image/png');
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
