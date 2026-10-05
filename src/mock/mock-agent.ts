/**
 * The mock agent: a tiny stand-alone program that behaves like an agent CLI.
 * It replays a scripted run (fake events, fake timings, fake token counts) and
 * really writes a small project into its working directory, so the whole
 * pipeline — streaming, metrics, diff, preview — can be exercised without
 * spending a token. It ignores the task and always builds a snake game.
 *
 * Output: one normalised AgentEvent (see adapters/types.ts) per line as JSON.
 *
 *   node mock-agent.js <scenario>     scenario: hare | tortoise | owl | crash | hang | nothing | auth
 *   AGENT_DERBY_MOCK_SPEED=20          run 20x faster (tests)
 */
import fs from 'node:fs';
import path from 'node:path';
import { snakeHtml, snakeServerJs, snakeTerminalJs } from './snake.js';

const scenario = process.argv[2] ?? 'hare';
const speed = Number(process.env.AGENT_DERBY_MOCK_SPEED) || 1;
const cwd = process.cwd();

const emit = (ev: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / speed));

let toolSeq = 0;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

async function turn(thought: string, thinkMs: number, tokens: { in: number; out: number; cached?: number; reasoning?: number }) {
  emit({ type: 'turn' });
  emit({ type: 'thinking_active' });
  const id = `think-${toolSeq++}`;
  const words = thought.split(' ');
  for (let i = 0; i < words.length; i++) {
    emit({ type: 'thinking', id, delta: true, text: (i ? ' ' : '') + words[i] });
    await sleep(thinkMs / words.length);
  }
  usage.input += tokens.in;
  usage.output += tokens.out;
  usage.cacheRead += tokens.cached ?? 0;
  usage.reasoning += tokens.reasoning ?? Math.round(tokens.out * 0.3);
  emit({ type: 'usage', mode: 'total', usage: { ...usage } });
}

async function say(text: string, ms = 600) {
  const id = `msg-${toolSeq++}`;
  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    emit({ type: 'message', id, delta: true, text: (i ? ' ' : '') + words[i] });
    await sleep(ms / words.length);
  }
}

async function tool(
  kind: string,
  name: string,
  target: string,
  ms: number,
  result: { ok?: boolean; output?: string; exitCode?: number } = {},
  action?: () => void,
) {
  const id = `tool-${toolSeq++}`;
  emit({ type: 'tool_start', id, kind, name, target, pending: true });
  await sleep(Math.min(400, ms / 3));
  emit({ type: 'tool_start', id, kind, name, target });
  await sleep(ms);
  action?.();
  emit({ type: 'tool_end', id, ok: result.ok ?? true, output: result.output ?? '', exitCode: result.exitCode ?? (kind === 'command' ? 0 : null) });
}

function write(file: string, content: string) {
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const manifest = (m: Record<string, unknown>) => `${JSON.stringify(m, null, 2)}\n`;

async function hare() {
  emit({ type: 'init', model: 'mock-hare-1', sessionId: 'mock-hare', cliVersion: '1.0.0-mock' });
  emit({ type: 'system', text: 'Mock agent: replays a scripted run and ignores the task.' });
  await turn('A single HTML file with a canvas is the fastest way to a playable snake game. No build step, no dependencies.', 1500, { in: 2100, out: 240, cached: 0 });
  await tool('search', 'list', '.', 300, { output: '(empty directory)' });
  await turn('Write the whole game in one go: grid, snake, food, keyboard and touch controls, score.', 1200, { in: 400, out: 1900, cached: 2100 });
  await tool('edit', 'write', 'index.html', 1800, { output: 'created index.html' }, () => write('index.html', snakeHtml('Snake', '#f97316')));
  await tool('edit', 'write', 'README.md', 500, { output: 'created README.md' }, () =>
    write('README.md', '# Snake\n\nOpen `index.html` in a browser. Arrow keys or WASD to steer, space to pause.\n'),
  );
  await tool('edit', 'write', 'agent-derby.json', 300, {}, () =>
    write('agent-derby.json', manifest({ type: 'static', install: null, start: null, root: '.' })),
  );
  await turn('Done. One file, playable immediately.', 500, { in: 300, out: 60, cached: 4400 });
  await say('Built a single-file snake game in index.html. Arrow keys or WASD to move, space to pause.');
  emit({ type: 'cost', usd: 0.0183 });
  emit({ type: 'result', ok: true, text: 'Built a single-file snake game in index.html. Arrow keys or WASD to move, space to pause.', turns: 3 });
}

async function tortoise() {
  emit({ type: 'init', model: 'mock-tortoise-1', sessionId: 'mock-tortoise', cliVersion: '1.0.0-mock' });
  emit({ type: 'system', text: 'Mock agent: replays a scripted run and ignores the task.' });
  await turn('I will structure this properly: a small Node server that honours PORT, static assets in public/, and a smoke test.', 2600, { in: 2300, out: 380 });
  await tool('search', 'list', '.', 400, { output: '(empty directory)' });
  await tool('command', 'shell', 'node --version', 600, { output: process.version });
  await turn('Node is available. Start with package.json and the server.', 1600, { in: 500, out: 700, cached: 2300 });
  await tool('edit', 'write', 'package.json', 900, {}, () =>
    write(
      'package.json',
      manifest({ name: 'snake-server', version: '1.0.0', private: true, type: 'commonjs', scripts: { start: 'node server.js', test: 'node test.js' } }),
    ),
  );
  await tool('edit', 'write', 'server.js', 1500, {}, () => write('server.js', snakeServerJs()));
  await turn('Now the game itself, served from public/.', 1800, { in: 600, out: 2300, cached: 2800 });
  await tool('edit', 'write', 'public/index.html', 2600, {}, () => write('public/index.html', snakeHtml('Snake Deluxe', '#22c55e')));
  await tool('command', 'shell', 'npm test', 1400, { ok: false, exitCode: 1, output: "Error: Cannot find module './test.js'" });
  emit({ type: 'error', message: 'Test command failed: test.js does not exist yet', kind: 'other', retry: true });
  await turn('The test script is referenced but missing. Add a smoke test that boots the server and fetches the page.', 1700, { in: 700, out: 520, cached: 3400 });
  await tool('edit', 'write', 'test.js', 1100, {}, () =>
    write(
      'test.js',
      `const http = require('http');\nprocess.env.PORT = '0';\nconst server = require('./server.js');\nserver.on('listening', () => {\n  const { port } = server.address();\n  http.get('http://127.0.0.1:' + port + '/', (res) => {\n    let body = '';\n    res.on('data', (c) => (body += c));\n    res.on('end', () => {\n      const ok = res.statusCode === 200 && body.includes('<canvas');\n      console.log(ok ? '1 passing' : '1 failing');\n      server.close(() => process.exit(ok ? 0 : 1));\n    });\n  });\n});\n`,
    ),
  );
  await tool('command', 'shell', 'npm test', 1500, { output: '> node test.js\n\n1 passing' });
  await tool('read', 'read', 'public/index.html', 500, { output: '(file contents)' });
  await tool('edit', 'edit', 'public/index.html', 900, { output: 'updated public/index.html' }, () =>
    write('public/index.html', snakeHtml('Snake Deluxe', '#22c55e').replace('</title>', ' · served by Node</title>')),
  );
  // Deliberately no agent-derby.json: this lane exercises project-type detection.
  await turn('Server, game and test are in place.', 700, { in: 400, out: 90, cached: 5200 });
  await say('Built a Node-served snake game: `npm start` serves public/ on $PORT, `npm test` runs a smoke test.', 900);
  emit({ type: 'result', ok: true, text: 'Built a Node-served snake game: `npm start` serves public/ on $PORT, `npm test` runs a smoke test.', turns: 5 });
}

async function owl() {
  emit({ type: 'init', model: 'mock-owl-1', sessionId: 'mock-owl', cliVersion: '1.0.0-mock' });
  emit({ type: 'system', text: 'Mock agent: replays a scripted run and ignores the task.' });
  await turn('A terminal version: raw-mode keyboard input and ANSI drawing, no dependencies.', 2000, { in: 2200, out: 300 });
  await tool('web', 'web_search', 'ANSI escape codes cursor positioning', 1200, { output: '3 results' });
  await turn('Write the game loop with a fixed tick and a bordered playfield.', 1500, { in: 900, out: 1500, cached: 2200 });
  await tool('edit', 'write', 'snake.js', 2200, {}, () => write('snake.js', snakeTerminalJs()));
  await tool('command', 'shell', 'node --check snake.js', 700, { output: '' });
  await tool('edit', 'write', 'agent-derby.json', 300, {}, () =>
    write('agent-derby.json', manifest({ type: 'terminal', install: null, start: 'node snake.js' })),
  );
  await turn('Syntax check passes.', 500, { in: 300, out: 70, cached: 3900 });
  await say('Built a terminal snake game in snake.js. Run `node snake.js`; arrow keys or WASD to steer, q to quit.', 700);
  emit({ type: 'result', ok: true, text: 'Built a terminal snake game in snake.js. Run `node snake.js`; arrow keys or WASD to steer, q to quit.', turns: 3 });
}

async function main() {
  // Read (and ignore) the prompt so the parent's write to stdin never blocks.
  process.stdin.on('data', () => {});
  process.stdin.on('error', () => {});
  switch (scenario) {
    case 'hare':
      return hare();
    case 'tortoise':
      return tortoise();
    case 'owl':
      return owl();
    case 'crash':
      emit({ type: 'init', model: 'mock-gremlin-1', cliVersion: '1.0.0-mock' });
      await turn('Starting work', 600, { in: 900, out: 40 });
      await tool('command', 'shell', 'npm install left-pad', 700, { ok: false, exitCode: 1, output: 'npm ERR! network timeout' });
      process.stderr.write('fatal: unexpected internal error (mock crash)\n');
      process.exit(3);
      break;
    case 'auth':
      process.stderr.write('Not logged in. Please run /login to sign in.\n');
      process.exit(1);
      break;
    case 'nothing':
      emit({ type: 'init', model: 'mock-gremlin-1', cliVersion: '1.0.0-mock' });
      await turn('Considering the task', 800, { in: 900, out: 60 });
      await say('I looked at the task but did not change any files.');
      emit({ type: 'result', ok: true, text: 'No changes made.', turns: 1 });
      return;
    case 'hang':
      emit({ type: 'init', model: 'mock-gremlin-1', cliVersion: '1.0.0-mock' });
      await turn('Starting work', 600, { in: 900, out: 40 });
      await tool('edit', 'write', 'half-finished.txt', 500, {}, () => write('half-finished.txt', 'work in progress\n'));
      emit({ type: 'tool_start', id: 'hang', kind: 'command', name: 'shell', target: 'sleep infinity' });
      // Ignore polite requests to stop, like a truly stuck process would.
      process.on('SIGINT', () => {});
      process.on('SIGTERM', () => {});
      await new Promise(() => setInterval(() => {}, 1 << 30));
      return;
    default:
      process.stderr.write(`unknown mock scenario: ${scenario}\n`);
      process.exit(2);
  }
}

main().then(
  () => setTimeout(() => process.exit(0), 20),
  (e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
