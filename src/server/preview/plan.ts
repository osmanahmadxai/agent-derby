import fs from 'node:fs';
import path from 'node:path';
import type { PreviewType } from '../../shared/types.js';
import { isWindows } from '../proc.js';
import { MANIFEST_NAME } from '../race/workspace.js';

/** How to run what an agent built. */
export interface RunPlan {
  type: PreviewType;
  install: string | null;
  start: string | null;
  /** For static sites: folder containing index.html, relative to the workspace. */
  root: string | null;
  source: 'manifest' | 'detected' | 'manual';
}

/**
 * The fixed text appended to every task. It is part of the prompt, so every
 * agent receives it identically.
 */
export const MANIFEST_INSTRUCTION = `When you are done, also create a file named ${MANIFEST_NAME()} in the project root describing how to run what you built, as JSON with exactly these keys:

{
  "type": "web" | "static" | "terminal" | "other",
  "install": "<shell command that installs dependencies, or null>",
  "start": "<shell command that starts it, or null>",
  "root": "<static only: folder containing index.html, relative to the project root>"
}

- "web": anything that needs a running server (including dev servers). The start command MUST listen on the port given in the PORT environment variable.
- "static": plain HTML/CSS/JS that works when the folder is served as-is. "start" is null.
- "terminal": a program or game that runs interactively in a terminal. "start" runs it.
- "other": anything else; give the most useful "start" command.

Do not leave servers or other long-running processes running when you finish.`;

export function buildPrompt(task: string): string {
  return `${task.trim()}\n\n---\n${MANIFEST_INSTRUCTION}\n`;
}

const TYPES: PreviewType[] = ['web', 'static', 'terminal', 'other'];

export type ManifestResult = { plan: RunPlan; problem: null } | { plan: null; problem: string };

export function readManifest(workspace: string): ManifestResult {
  const file = path.join(workspace, MANIFEST_NAME());
  if (!fs.existsSync(file)) return { plan: null, problem: `The agent did not write ${MANIFEST_NAME()}` };
  let raw: any;
  try {
    // Tolerate a manifest wrapped in a Markdown code fence.
    const text = fs.readFileSync(file, 'utf8').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
    raw = JSON.parse(text);
  } catch (e) {
    return { plan: null, problem: `${MANIFEST_NAME()} is not valid JSON (${(e as Error).message})` };
  }
  if (!raw || typeof raw !== 'object') return { plan: null, problem: `${MANIFEST_NAME()} is not a JSON object` };
  const type = String(raw.type ?? '').toLowerCase() as PreviewType;
  if (!TYPES.includes(type)) return { plan: null, problem: `${MANIFEST_NAME()} has an unknown type "${raw.type}"` };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
  const plan: RunPlan = { type, install: str(raw.install), start: str(raw.start), root: str(raw.root), source: 'manifest' };
  if ((type === 'web' || type === 'terminal') && !plan.start) {
    return { plan: null, problem: `${MANIFEST_NAME()} says "${type}" but has no start command` };
  }
  if (type === 'static') {
    const root = findStaticRoot(workspace, plan.root);
    if (!root) return { plan: null, problem: `${MANIFEST_NAME()} says "static" but no index.html was found${plan.root ? ` in "${plan.root}"` : ''}` };
    plan.root = root;
  }
  return { plan, problem: null };
}

/** Folder (relative to the workspace) that contains an index.html, or null. */
export function findStaticRoot(workspace: string, preferred: string | null = null): string | null {
  const candidates = [preferred, '.', 'dist', 'build', 'public', 'out', 'site', 'docs', 'www', 'src'].filter((c): c is string => c !== null);
  for (const c of candidates) {
    const dir = path.resolve(workspace, c);
    if (!dir.startsWith(path.resolve(workspace))) continue;
    if (fs.existsSync(path.join(dir, 'index.html'))) return path.relative(workspace, dir) || '.';
  }
  // Otherwise: any single top-level HTML file.
  try {
    const html = fs.readdirSync(workspace).filter((f) => f.toLowerCase().endsWith('.html'));
    if (html.length >= 1) return '.';
  } catch {
    /* unreadable workspace */
  }
  return null;
}

export const portVar = () => (isWindows ? '%PORT%' : '$PORT');

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const SERVER_HINT = /\.listen\s*\(|createServer|express\(|fastify\(|new Koa|Bun\.serve|Deno\.serve|http\.server|flask|fastapi|uvicorn|django|aiohttp|streamlit|gradio/i;

/** Work out how to run a project from its files, when there is no usable manifest. */
export function detectPlan(workspace: string): RunPlan | null {
  const has = (f: string) => fs.existsSync(path.join(workspace, f));
  const detected = (type: PreviewType, start: string | null, install: string | null = null, root: string | null = null): RunPlan => ({
    type,
    start,
    install,
    root,
    source: 'detected',
  });

  if (has('package.json')) {
    let pkg: any = {};
    try {
      pkg = JSON.parse(read(path.join(workspace, 'package.json')));
    } catch {
      /* treated as empty */
    }
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const hasDeps = Object.keys(deps).length > 0;
    const install = hasDeps ? (has('pnpm-lock.yaml') ? 'pnpm install' : has('yarn.lock') ? 'yarn install' : has('bun.lockb') ? 'bun install' : 'npm install') : null;
    const scriptText = Object.values(scripts).join(' ');
    if (deps.vite || /\bvite\b/.test(scriptText)) return detected('web', `npx vite --port ${portVar()} --strictPort --host 127.0.0.1`, install);
    if (deps.next) return detected('web', `npx next dev -p ${portVar()}`, install);
    if (deps.astro) return detected('web', `npx astro dev --port ${portVar()}`, install);
    const runScript = scripts.start ? 'npm start' : scripts.dev ? 'npm run dev' : scripts.serve ? 'npm run serve' : null;
    const entry = [pkg.main, typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0], 'server.js', 'index.js', 'app.js', 'main.js', 'src/index.js']
      .filter((f): f is string => typeof f === 'string')
      .find((f) => has(f));
    const scriptTarget = (scripts.start ?? scripts.dev ?? '').match(/(?:node|tsx|ts-node|bun)\s+([^\s&|;]+)/)?.[1];
    const code = read(path.join(workspace, scriptTarget ?? entry ?? '')) + scriptText;
    const looksLikeServer = SERVER_HINT.test(code) || Boolean(deps.express || deps.fastify || deps.koa || deps['http-server'] || deps.serve || deps['react-scripts']);
    if (runScript) return detected(looksLikeServer ? 'web' : findStaticRoot(workspace) ? 'static' : 'terminal', looksLikeServer || !findStaticRoot(workspace) ? runScript : null, install, looksLikeServer ? null : findStaticRoot(workspace));
    if (entry) return detected(looksLikeServer ? 'web' : 'terminal', `node ${entry}`, install);
  }

  const staticRoot = findStaticRoot(workspace);
  if (staticRoot) return detected('static', null, null, staticRoot);

  const top = (() => {
    try {
      return fs.readdirSync(workspace).filter((f) => !f.startsWith('.'));
    } catch {
      return [];
    }
  })();
  const pick = (ext: string, names: string[]) => {
    const files = top.filter((f) => f.endsWith(ext));
    return names.map((n) => n + ext).find((n) => files.includes(n)) ?? (files.length === 1 ? files[0]! : null);
  };

  const py = pick('.py', ['main', 'app', 'game', 'snake', 'run', 'server', 'cli']);
  if (py) {
    const venvPython = isWindows ? '.venv\\Scripts\\python' : '.venv/bin/python';
    const install = has('requirements.txt') ? `python3 -m venv .venv && ${venvPython} -m pip install -r requirements.txt` : null;
    const python = install ? venvPython : 'python3';
    return detected(SERVER_HINT.test(read(path.join(workspace, py))) ? 'web' : 'terminal', `${python} ${py}`, install);
  }
  if (has('go.mod')) return detected('terminal', 'go run .');
  if (has('Cargo.toml')) return detected('terminal', 'cargo run');
  const js = pick('.js', ['index', 'main', 'game', 'snake', 'cli', 'app', 'server']) ?? pick('.mjs', ['index', 'main']);
  if (js) return detected(SERVER_HINT.test(read(path.join(workspace, js))) ? 'web' : 'terminal', `node ${js}`);
  const sh = pick('.sh', ['run', 'start', 'main']);
  if (sh) return detected('terminal', `sh ${sh}`);
  return null;
}

/** Does this project declare a build step we can check? */
export function buildCommand(workspace: string): string | null {
  try {
    const pkg = JSON.parse(read(path.join(workspace, 'package.json')));
    return pkg?.scripts?.build ? 'npm run build' : null;
  } catch {
    return null;
  }
}
