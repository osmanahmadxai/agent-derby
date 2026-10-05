import { isTerminal, rankLanes, totalTokens, type FeedItem, type Race } from '../../shared/types.js';

/**
 * A race as one self-contained web page: no server, no network, nothing to
 * install. It replays each lane's activity against a shared clock, then shows
 * the final numbers. Everything in it comes from the recorded race.
 */

interface ReplayLane {
  name: string;
  color: string;
  model: string | null;
  state: string;
  reason: string | null;
  wallMs: number;
  tokens: number | null;
  cost: number | null;
  costEstimated: boolean;
  files: number | null;
  added: number | null;
  removed: number | null;
  judge: number | null;
  place: number;
  feed: { t: number; type: string; text: string; kind?: string; ok?: boolean | null; ms?: number | null }[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function replayData(race: Race, feeds: Record<string, FeedItem[]>): { task: string; date: number; sha: string; version: string; hidden: boolean; rounds: string[]; lanes: ReplayLane[] } {
  // A blind race that has not been voted on stays blind in its replay.
  const hidden = race.blind && !race.vote;
  const ranked = rankLanes(race.lanes);
  const lanes = race.lanes.map((lane, i): ReplayLane => {
    const m = lane.metrics;
    return {
      name: hidden ? `Agent ${String.fromCharCode(65 + i)}` : lane.agentName,
      color: hidden ? '#8b95b3' : lane.color,
      model: hidden ? null : m.model,
      state: lane.state,
      reason: lane.stateReason,
      wallMs: m.time.wallMs,
      tokens: totalTokens(m.tokens),
      cost: m.cost.usd,
      costEstimated: m.cost.source === 'estimated',
      files: m.code ? m.code.filesCreated + m.code.filesModified + m.code.filesDeleted : null,
      added: m.code?.linesAdded ?? null,
      removed: m.code?.linesRemoved ?? null,
      judge: lane.judge?.score ?? null,
      place: ranked.indexOf(lane) + 1,
      feed: (feeds[lane.id] ?? [])
        .filter((f) => !(hidden && f.type === 'system' && f.text.startsWith('Model:')))
        .map((f) => ({
          t: f.t,
          type: f.type,
          text: clip(f.type === 'tool' ? (f.tool?.target ?? f.tool?.name ?? '') : f.text, 400),
          ...(f.tool ? { kind: f.tool.kind, ok: f.tool.status === 'running' ? null : f.tool.status === 'ok', ms: f.tool.durationMs } : {}),
        })),
    };
  });
  return {
    task: race.setup.task,
    date: race.createdAt,
    sha: race.promptSha256.slice(0, 12),
    version: race.appVersion,
    hidden,
    rounds: (race.rounds ?? []).map((r) => r.prompt),
    lanes,
  };
}

export function buildReplay(race: Race, feeds: Record<string, FeedItem[]>): string {
  const data = replayData(race, feeds);
  const finished = race.lanes.every((l) => isTerminal(l.state));
  // "<" must not appear raw inside the script block, or "</script>" in a feed line would end it early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(new RegExp('[\\u2028\\u2029]', 'g'), '');
  const title = `Agent Derby replay: ${clip(race.setup.task.replace(/\s+/g, ' '), 70)}`.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{--bg:#0e1420;--panel:#161d2e;--line:#27314a;--ink:#eef2fb;--mute:#8b95b3;--accent:#facc15;--ok:#34d399;--bad:#f87171}
@media (prefers-color-scheme: light){:root{--bg:#eef1f8;--panel:#fff;--line:#d5dbea;--ink:#101729;--mute:#5d6785;--ok:#047857;--bad:#b91c1c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:16px 20px 12px;border-bottom:1px solid var(--line)}
h1{margin:0 0 4px;font-size:20px;line-height:1.25}
.sub{color:var(--mute);font-size:12.5px}
.bar{display:flex;gap:12px;align-items:center;padding:10px 20px;position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);z-index:2;flex-wrap:wrap}
button,select{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;min-width:76px}
input[type=range]{flex:1;min-width:160px;accent-color:var(--accent)}
.clock{font:700 22px ui-monospace,SFMono-Regular,Menlo,monospace;min-width:92px;text-align:right}
.lanes{display:grid;gap:12px;padding:16px 20px;grid-template-columns:repeat(auto-fit,minmax(270px,1fr))}
.lane{background:var(--panel);border:1px solid var(--line);border-top:4px solid var(--c);border-radius:10px;display:flex;flex-direction:column;min-height:420px;max-height:72vh;overflow:hidden}
.lane h2{margin:0;font-size:16px;display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.top{padding:10px 12px 8px;border-bottom:1px solid var(--line)}
.badge{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:5px;background:var(--line);white-space:nowrap}
.badge.finished{background:color-mix(in srgb,var(--ok) 22%,transparent);color:var(--ok)}
.badge.bad{background:color-mix(in srgb,var(--bad) 22%,transparent);color:var(--bad)}
.badge.running{background:color-mix(in srgb,var(--accent) 30%,transparent)}
.model{color:var(--mute);font-size:12px;margin-top:2px;min-height:17px}
.now{font-weight:600;margin-top:6px;min-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats{display:flex;gap:14px;margin-top:6px;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mute);flex-wrap:wrap}
.stats b{color:var(--ink);font-weight:600}
.feed{padding:8px 12px;overflow:auto;flex:1;font-size:13px}
.feed div{padding:2px 0;overflow-wrap:anywhere}
.thinking{color:var(--mute);font-style:italic}
.system{color:var(--mute)}
.error{color:var(--bad)}
.tool{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.tool i{font-style:normal;color:var(--mute)}
.raw{font-family:ui-monospace,monospace;font-size:12px;color:var(--mute)}
footer{padding:14px 20px 26px;color:var(--mute);font-size:12.5px}
footer a{color:inherit}
.nr{color:var(--mute);font-style:italic}
</style>
</head>
<body>
<header>
  <h1 id="task"></h1>
  <div class="sub" id="meta"></div>
</header>
<div class="bar">
  <button class="primary" id="play">Play</button>
  <select id="speed" aria-label="Speed"><option value="1">1x</option><option value="4" selected>4x</option><option value="16">16x</option><option value="64">64x</option></select>
  <input type="range" id="seek" min="0" max="1000" value="0" aria-label="Position">
  <div class="clock" id="clock">0:00.0</div>
</div>
<div class="lanes" id="lanes"></div>
<footer>
  Replay of a race run with <a href="https://github.com/osmanahmadxai/agent-derby">Agent Derby</a>${finished ? '' : ' (the race had not finished when this was exported)'}.
  Every agent received the identical prompt. Tokens, cost and code changes are final figures and appear when a lane ends;
  "not reported" means the agent's CLI did not report that number. An "est." cost is computed from a price table, not measured.
  An AI judge score is one model's opinion, not a measurement.
</footer>
<script>
const D = ${json};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dur = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + '.' + Math.floor((ms % 1000) / 100); };
const num = (n) => n === null ? '<span class="nr">not reported</span>' : n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k' : (n / 1e6).toFixed(2) + 'M';
const total = Math.max(1000, ...D.lanes.map((l) => l.wallMs));
const WORDS = { finished: 'finished', failed: 'failed', stopped: 'stopped', timed_out: 'timed out', over_budget: 'over budget' };
$('task').textContent = D.task;
$('meta').textContent = new Date(D.date).toLocaleString() + ' · prompt sha256 ' + D.sha + (D.rounds.length ? ' · ' + D.rounds.length + ' follow-up round' + (D.rounds.length > 1 ? 's' : '') : '') + (D.hidden ? ' · blind race: agents hidden' : '');
$('lanes').innerHTML = D.lanes.map((l, i) => '<section class="lane" style="--c:' + esc(l.color) + '"><div class="top"><h2><span>' + esc(l.name) + '</span><span class="badge" id="b' + i + '"></span></h2><div class="model">' + esc(l.model || '') + '</div><div class="now" id="n' + i + '"></div><div class="stats" id="s' + i + '"></div></div><div class="feed" id="f' + i + '"></div></section>').join('');
const shown = D.lanes.map(() => -1);
function line(f) {
  if (f.type === 'tool') return '<div class="tool">' + (f.ok === null ? '…' : f.ok ? '✓' : '✗') + ' <i>' + esc(f.kind) + '</i> ' + esc(f.text) + (f.ms != null ? ' <i>' + (f.ms / 1000).toFixed(1) + 's</i>' : '') + '</div>';
  return '<div class="' + esc(f.type) + '">' + esc(f.text) + '</div>';
}
function nowText(f) {
  if (!f) return 'Starting';
  if (f.type === 'tool') return ({ read: 'Reading ', edit: 'Editing ', command: 'Running ', search: 'Searching ', web: 'Looking up ', plan: 'Planning ', agent: 'Delegating ' }[f.kind] || 'Using ') + f.text;
  return f.type === 'thinking' ? 'Thinking' : f.type === 'message' ? 'Writing a reply' : 'Working';
}
function render(t) {
  $('clock').textContent = dur(t);
  D.lanes.forEach((l, i) => {
    let upto = -1;
    for (let k = 0; k < l.feed.length; k++) { if (l.feed[k].t <= t) upto = k; else break; }
    const feed = $('f' + i);
    if (upto < shown[i]) { feed.innerHTML = ''; shown[i] = -1; }
    if (upto > shown[i]) {
      feed.insertAdjacentHTML('beforeend', l.feed.slice(shown[i] + 1, upto + 1).map(line).join(''));
      shown[i] = upto;
      feed.scrollTop = feed.scrollHeight;
    }
    const done = t >= l.wallMs;
    const b = $('b' + i);
    b.textContent = done ? (l.state === 'finished' ? '#' + l.place + ' ' : '') + (WORDS[l.state] || l.state) : 'running';
    b.className = 'badge ' + (done ? (l.state === 'finished' ? 'finished' : 'bad') : 'running');
    $('n' + i).textContent = done ? (l.reason || (l.state === 'finished' ? 'Finished' : WORDS[l.state] || l.state)) : nowText(l.feed[upto]);
    const tools = l.feed.filter((f, k) => k <= upto && f.type === 'tool').length;
    let s = '<span><b>' + dur(Math.min(t, l.wallMs)) + '</b></span><span><b>' + tools + '</b> tools</span>';
    if (done) {
      s += (l.tokens === null ? '<span class="nr">tokens not reported</span>' : '<span><b>' + num(l.tokens) + '</b> tokens</span>') + '<span>' + (l.cost === null ? '<span class="nr">cost not reported</span>' : '<b>$' + l.cost.toFixed(l.cost < 1 ? 3 : 2) + '</b>' + (l.costEstimated ? ' est.' : '')) + '</span>';
      if (l.files !== null) s += '<span><b>' + l.files + '</b> files <b>+' + l.added + ' −' + l.removed + '</b></span>';
      if (l.judge !== null) s += '<span>AI judge opinion <b>' + l.judge + '/10</b></span>';
    }
    $('s' + i).innerHTML = s;
  });
}
let t = 0, playing = false, last = 0;
function frame(now) {
  if (!playing) return;
  t = Math.min(total, t + (now - last) * Number($('speed').value));
  last = now;
  $('seek').value = Math.round((t / total) * 1000);
  render(t);
  if (t >= total) { playing = false; $('play').textContent = 'Replay'; return; }
  requestAnimationFrame(frame);
}
$('play').onclick = () => {
  if (playing) { playing = false; $('play').textContent = 'Play'; return; }
  if (t >= total) t = 0;
  playing = true; last = performance.now(); $('play').textContent = 'Pause';
  requestAnimationFrame(frame);
};
$('seek').oninput = (e) => { t = (Number(e.target.value) / 1000) * total; render(t); };
render(0);
</script>
</body>
</html>
`;
}
