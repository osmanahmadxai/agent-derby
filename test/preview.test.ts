import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPrompt, detectPlan, MANIFEST_INSTRUCTION, readManifest } from '../src/server/preview/plan.js';
import { safeJoin, serveStatic } from '../src/server/preview/static.js';
import { freePort } from '../src/server/proc.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-derby-plan-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const dir = path.join(tmp, `p${n++}`);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('prompt', () => {
  it('is the task plus the fixed manifest instruction, the same bytes every time', () => {
    const a = buildPrompt('  build a snake game \n');
    const b = buildPrompt('build a snake game');
    expect(a).toBe(b);
    expect(a.startsWith('build a snake game\n\n---\n')).toBe(true);
    expect(a).toContain(MANIFEST_INSTRUCTION);
    expect(a).toContain('PORT environment variable');
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    expect(sha(a)).toBe(sha(b));
  });
});

describe('manifest', () => {
  it('reads a valid web manifest', () => {
    const dir = project({ 'agent-derby.json': JSON.stringify({ type: 'web', install: 'npm install', start: 'npm start' }) });
    expect(readManifest(dir)).toEqual({ plan: { type: 'web', install: 'npm install', start: 'npm start', root: null, source: 'manifest' }, problem: null });
  });

  it('resolves the static root and tolerates a code fence', () => {
    const dir = project({ 'agent-derby.json': '```json\n{"type":"static","install":null,"start":null,"root":"public"}\n```', 'public/index.html': '<p>' });
    expect(readManifest(dir).plan).toMatchObject({ type: 'static', root: 'public', start: null });
  });

  it.each([
    [{}, /did not write/],
    [{ 'agent-derby.json': '{oops' }, /not valid JSON/],
    [{ 'agent-derby.json': '{"type":"spaceship"}' }, /unknown type/],
    [{ 'agent-derby.json': '{"type":"web","start":null}' }, /no start command/],
    [{ 'agent-derby.json': '{"type":"static","root":"dist"}' }, /no index.html/],
  ])('explains a missing or wrong manifest %#', (files, problem) => {
    const r = readManifest(project(files as Record<string, string>));
    expect(r.plan).toBeNull();
    expect(r.problem).toMatch(problem);
  });
});

describe('project type detection', () => {
  it('static site', () => {
    expect(detectPlan(project({ 'index.html': '<h1>' }))).toMatchObject({ type: 'static', root: '.', source: 'detected' });
    expect(detectPlan(project({ 'dist/index.html': '<h1>' }))).toMatchObject({ type: 'static', root: 'dist' });
  });

  it('Vite app gets an explicit port flag, because Vite ignores PORT', () => {
    const plan = detectPlan(project({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^7' } }), 'index.html': '' }));
    expect(plan).toMatchObject({ type: 'web', install: 'npm install' });
    expect(plan!.start).toMatch(/vite --port .*PORT/);
  });

  it('Node server with a start script', () => {
    const plan = detectPlan(project({ 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }), 'server.js': 'require("http").createServer().listen(process.env.PORT)' }));
    expect(plan).toMatchObject({ type: 'web', start: 'npm start', install: null });
  });

  it('Node terminal program', () => {
    expect(detectPlan(project({ 'package.json': JSON.stringify({ scripts: { start: 'node game.js' } }), 'game.js': 'process.stdin.setRawMode(true)' }))).toMatchObject({
      type: 'terminal',
      start: 'npm start',
    });
    expect(detectPlan(project({ 'snake.js': 'console.log(1)' }))).toMatchObject({ type: 'terminal', start: 'node snake.js' });
  });

  it('Python: server vs terminal program', () => {
    expect(detectPlan(project({ 'app.py': 'from flask import Flask' }))).toMatchObject({ type: 'web', start: 'python3 app.py' });
    expect(detectPlan(project({ 'game.py': 'import curses' }))).toMatchObject({ type: 'terminal', start: 'python3 game.py' });
    expect(detectPlan(project({ 'main.py': 'import curses', 'requirements.txt': 'windows-curses' }))!.install).toMatch(/venv/);
  });

  it('Go and Rust', () => {
    expect(detectPlan(project({ 'go.mod': 'module x' }))).toMatchObject({ type: 'terminal', start: 'go run .' });
    expect(detectPlan(project({ 'Cargo.toml': '[package]' }))).toMatchObject({ type: 'terminal', start: 'cargo run' });
  });

  it('gives up honestly on an empty or unrecognisable project', () => {
    expect(detectPlan(project({}))).toBeNull();
    expect(detectPlan(project({ 'notes.txt': 'hello' }))).toBeNull();
  });
});

describe('static server', () => {
  it('serves files and refuses to leave its folder', async () => {
    const dir = project({ 'index.html': '<h1>hi</h1>', 'js/app.js': 'x=1' });
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
    const port = await freePort();
    const server = await serveStatic(dir, port);
    try {
      const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
      const index = await get('/');
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toMatch(/text\/html/);
      expect(await index.text()).toBe('<h1>hi</h1>');
      expect((await get('/js/app.js')).headers.get('content-type')).toMatch(/javascript/);
      expect((await get('/missing')).status).toBe(404);
      expect((await get('/%2e%2e/secret.txt')).status).not.toBe(200);
    } finally {
      server.close();
    }
    expect(safeJoin(dir, '/../secret.txt')).toBe(path.join(dir, 'secret.txt'));
    expect(safeJoin(dir, '/a/../../x')).toBe(path.join(dir, 'x'));
  });
});
