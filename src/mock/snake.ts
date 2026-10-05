/** The projects the mock agents "write". Kept small but genuinely playable. */

export function snakeHtml(title: string, accent: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #0b0f14; color: #e6edf3; font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { display: grid; gap: 10px; justify-items: center; }
  h1 { margin: 0; font-size: 18px; letter-spacing: .08em; text-transform: uppercase; color: ${accent}; }
  canvas { background: #111821; border: 2px solid ${accent}; border-radius: 8px; width: min(84vmin, 420px); height: min(84vmin, 420px); image-rendering: pixelated; }
  .hud { display: flex; gap: 18px; }
  .hint { opacity: .6; font-size: 12px; }
  button { font: inherit; color: #0b0f14; background: ${accent}; border: 0; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <div class="hud"><span>Score <b id="score">0</b></span><span>Best <b id="best">0</b></span></div>
  <canvas id="c" width="420" height="420" tabindex="0"></canvas>
  <div class="hint" id="hint">Arrow keys / WASD to steer · Space to pause</div>
  <button id="restart" hidden>Play again</button>
</main>
<script>
(() => {
  const N = 21, canvas = document.getElementById('c'), ctx = canvas.getContext('2d'), cell = canvas.width / N;
  const scoreEl = document.getElementById('score'), bestEl = document.getElementById('best');
  const hint = document.getElementById('hint'), restart = document.getElementById('restart');
  let snake, dir, queued, food, score, best = 0, over, paused, timer;
  function reset() {
    snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    dir = { x: 1, y: 0 }; queued = []; score = 0; over = false; paused = false;
    placeFood(); restart.hidden = true; hint.textContent = 'Arrow keys / WASD to steer · Space to pause';
    clearInterval(timer); timer = setInterval(tick, 110); draw();
  }
  function placeFood() {
    do { food = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) }; }
    while (snake.some((s) => s.x === food.x && s.y === food.y));
  }
  function tick() {
    if (over || paused) return;
    const next = queued.shift();
    if (next && (next.x !== -dir.x || next.y !== -dir.y)) dir = next;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.y < 0 || head.x >= N || head.y >= N || snake.some((s) => s.x === head.x && s.y === head.y)) {
      over = true; clearInterval(timer); best = Math.max(best, score); bestEl.textContent = best;
      hint.textContent = 'Game over'; restart.hidden = false; draw(); return;
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) { score++; placeFood(); } else snake.pop();
    scoreEl.textContent = score; draw();
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ef4444'; ctx.beginPath();
    ctx.arc((food.x + .5) * cell, (food.y + .5) * cell, cell * .38, 0, Math.PI * 2); ctx.fill();
    snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? '#ffffff' : '${accent}';
      ctx.fillRect(s.x * cell + 1, s.y * cell + 1, cell - 2, cell - 2);
    });
    if (over || paused) {
      ctx.fillStyle = 'rgba(11,15,20,.72)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 26px ui-monospace, monospace'; ctx.textAlign = 'center';
      ctx.fillText(over ? 'GAME OVER' : 'PAUSED', canvas.width / 2, canvas.height / 2);
    }
  }
  const keys = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
  addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); if (over) reset(); else { paused = !paused; draw(); } return; }
    const k = keys[e.key] || keys[e.key.toLowerCase()];
    if (!k) return;
    e.preventDefault();
    if (queued.length < 3) queued.push({ x: k[0], y: k[1] });
  });
  let touch = null;
  canvas.addEventListener('touchstart', (e) => { touch = e.touches[0]; }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.clientX, dy = e.changedTouches[0].clientY - touch.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 20) queued.push(Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) });
    touch = null;
  });
  restart.addEventListener('click', reset);
  canvas.focus();
  reset();
})();
</script>
</body>
</html>
`;
}

export function snakeServerJs(): string {
  return `const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Snake server listening on http://localhost:' + server.address().port));
module.exports = server;
`;
}

export function snakeTerminalJs(): string {
  return `#!/usr/bin/env node
// Terminal snake. Arrow keys or WASD to steer, q to quit, r to restart.
const out = process.stdout;
// Fit the playfield to the terminal it is running in.
const W = Math.max(8, Math.min(30, Math.floor(((out.columns || 80) - 2) / 2)));
const H = Math.max(6, Math.min(16, (out.rows || 24) - 5));
let snake, dir, next, food, score, over, timer;

function reset() {
  const y0 = Math.floor(H / 2);
  snake = [{ x: 4, y: y0 }, { x: 3, y: y0 }, { x: 2, y: y0 }];
  dir = { x: 1, y: 0 }; next = dir; score = 0; over = false;
  placeFood();
  clearInterval(timer);
  timer = setInterval(tick, 120);
  draw();
}
function placeFood() {
  do { food = { x: Math.floor(Math.random() * W), y: Math.floor(Math.random() * H) }; }
  while (snake.some((s) => s.x === food.x && s.y === food.y));
}
function tick() {
  if (over) return;
  if (next.x !== -dir.x || next.y !== -dir.y) dir = next;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  if (head.x < 0 || head.y < 0 || head.x >= W || head.y >= H || snake.some((s) => s.x === head.x && s.y === head.y)) {
    over = true; clearInterval(timer); draw(); return;
  }
  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) { score++; placeFood(); } else snake.pop();
  draw();
}
function draw() {
  let s = '\\x1b[H\\x1b[2J\\x1b[1;35m SNAKE \\x1b[0m score ' + score + '\\r\\n';
  s += '\\u250c' + '\\u2500'.repeat(W * 2) + '\\u2510\\r\\n';
  for (let y = 0; y < H; y++) {
    s += '\\u2502';
    for (let x = 0; x < W; x++) {
      const i = snake.findIndex((p) => p.x === x && p.y === y);
      if (i === 0) s += '\\x1b[97m\\u2588\\u2588\\x1b[0m';
      else if (i > 0) s += '\\x1b[35m\\u2588\\u2588\\x1b[0m';
      else if (food.x === x && food.y === y) s += '\\x1b[31m\\u25cf \\x1b[0m';
      else s += '  ';
    }
    s += '\\u2502\\r\\n';
  }
  s += '\\u2514' + '\\u2500'.repeat(W * 2) + '\\u2518\\r\\n';
  s += over ? ' \\x1b[1;31mGAME OVER\\x1b[0m  r = restart, q = quit\\r\\n' : ' arrows / WASD to steer, q to quit\\r\\n';
  out.write(s);
}
function quit() {
  clearInterval(timer);
  out.write('\\x1b[?25h\\r\\nBye! Final score: ' + score + '\\r\\n');
  process.exit(0);
}
const KEYS = {
  '\\x1b[A': [0, -1], '\\x1b[B': [0, 1], '\\x1b[D': [-1, 0], '\\x1b[C': [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
};
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (key) => {
  if (key === 'q' || key === '\\x03') return quit();
  if (key === 'r') return reset();
  const k = KEYS[key] || KEYS[String(key).toLowerCase()];
  if (k) next = { x: k[0], y: k[1] };
});
out.write('\\x1b[?25l');
reset();
`;
}
