import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeStats, DiffFile, KeepRequest, LaneDiff, RepoCheck } from '../../shared/types.js';
import { ensureDir, homeDir } from '../paths.js';
import { exec, type ExecResult } from '../proc.js';

/**
 * Workspace isolation. Every lane gets a private folder:
 *   - starting from a repo:  a git worktree on its own branch `agent-derby/<race>/<lane>`
 *   - starting empty:        a fresh folder with `git init`
 * The user's working tree, index and existing branches are never written to.
 * Workspaces stay on disk until the race is deleted.
 */

/** Never part of an agent's result: dependencies, caches, and our own manifest. */
const EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  'target/',
  '.gradle/',
  '.DS_Store',
  '*.pyc',
  'npm-debug.log*',
  MANIFEST_NAME(),
];

export function MANIFEST_NAME(): string {
  return 'agent-derby.json';
}

function supportFiles(): { excludes: string; hooks: string } {
  const dir = ensureDir(path.join(homeDir(), 'git'));
  const excludes = path.join(dir, 'excludes');
  const want = `${EXCLUDES.join('\n')}\n`;
  if (!fs.existsSync(excludes) || fs.readFileSync(excludes, 'utf8') !== want) fs.writeFileSync(excludes, want);
  return { excludes, hooks: ensureDir(path.join(dir, 'no-hooks')) };
}

/**
 * Run git with settings that make it independent of the user's configuration:
 * our own ignore list, no hooks, no signing, a fixed identity for our commits.
 * These are per-invocation `-c` flags; nothing is written to any git config.
 */
export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  const s = supportFiles();
  return exec(
    'git',
    [
      '-c', `core.excludesFile=${s.excludes}`,
      '-c', `core.hooksPath=${s.hooks}`,
      '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Agent Derby',
      '-c', 'user.email=agent-derby@localhost',
      '-c', 'core.quotepath=false',
      '-c', 'advice.detachedHead=false',
      '-c', 'gc.auto=0',
      ...args,
    ],
    { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
  );
}

export async function gitVersion(): Promise<string | null> {
  const r = await exec('git', ['--version'], { timeoutMs: 10_000 });
  const m = r.stdout.match(/\d+\.\d+(\.\d+)?/);
  return r.code === 0 && m ? m[0] : null;
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export async function checkRepo(input: string): Promise<RepoCheck> {
  const p = path.resolve(expandHome(input.trim()));
  const fail = (error: string): RepoCheck => ({ ok: false, path: p, branch: null, head: null, dirty: false, error });
  if (!input.trim()) return fail('Enter the path of a git repository');
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return fail('That folder does not exist');
  const top = await git(p, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return fail('That folder is not inside a git repository');
  const root = top.stdout.trim();
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (head.code !== 0) return fail('The repository has no commits yet; make a first commit so agents have a starting point');
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await git(root, ['status', '--porcelain']);
  return {
    ok: true,
    path: root,
    branch: branch.stdout.trim() || null,
    head: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
    error: null,
  };
}

export interface Prepared {
  workspace: string;
  branch: string | null;
  baseRef: string;
}

/** Fresh folder with its own repository and one empty starting commit. */
export async function prepareEmpty(workspace: string): Promise<Prepared> {
  ensureDir(workspace);
  let r = await git(workspace, ['init', '-q', '-b', 'main']);
  if (r.code !== 0) r = await git(workspace, ['init', '-q']);
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr.trim()}`);
  r = await git(workspace, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'agent-derby: starting point']);
  if (r.code !== 0) throw new Error(`could not create the starting commit: ${r.stderr.trim()}`);
  const head = await git(workspace, ['rev-parse', 'HEAD']);
  return { workspace, branch: null, baseRef: head.stdout.trim() };
}

/** A worktree of the user's repo on a new branch, starting at `baseRef`. */
export async function prepareWorktree(repoRoot: string, workspace: string, branch: string, baseRef: string): Promise<Prepared> {
  ensureDir(path.dirname(workspace));
  const r = await git(repoRoot, ['worktree', 'add', '-q', '-b', branch, workspace, baseRef], 120_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  return { workspace, branch, baseRef };
}

/** How many files differ from the starting point right now (committed or not). */
export async function liveChangedCount(workspace: string, baseRef: string): Promise<number> {
  const [status, committed] = await Promise.all([
    git(workspace, ['status', '--porcelain', '-uall'], 15_000),
    git(workspace, ['diff', '--name-only', baseRef, 'HEAD'], 15_000),
  ]);
  const files = new Set<string>();
  for (const line of status.stdout.split('\n')) if (line.length > 3) files.add(line.slice(3).replace(/^.* -> /, ''));
  for (const line of committed.stdout.split('\n')) if (line.trim()) files.add(line.trim());
  return files.size;
}

/** Record the agent's final state as a commit in its own workspace. Returns that commit. */
export async function snapshot(workspace: string): Promise<string> {
  await git(workspace, ['add', '-A'], 120_000);
  const staged = await git(workspace, ['diff', '--cached', '--quiet']);
  if (staged.code !== 0) {
    const c = await git(workspace, ['commit', '-q', '--no-verify', '-m', 'agent-derby: result'], 120_000);
    if (c.code !== 0) throw new Error(`could not record the result: ${c.stderr.trim()}`);
  }
  const head = await git(workspace, ['rev-parse', 'HEAD']);
  return head.stdout.trim();
}

function depsOfPackageJson(text: string): Set<string> {
  const out = new Set<string>();
  try {
    const pkg = JSON.parse(text);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg?.[field] ?? {})) out.add(name);
    }
  } catch {
    /* unparsable: no dependencies we can name */
  }
  return out;
}

function depsOfRequirements(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m && !line.trim().startsWith('#')) out.add(m[1]!.toLowerCase());
  }
  return out;
}

async function show(workspace: string, ref: string, file: string): Promise<string> {
  const r = await git(workspace, ['show', `${ref}:${file}`]);
  return r.code === 0 ? r.stdout : '';
}

export async function codeStats(workspace: string, baseRef: string, resultRef: string): Promise<CodeStats> {
  const stats: CodeStats = { filesCreated: 0, filesModified: 0, filesDeleted: 0, linesAdded: 0, linesRemoved: 0, newDependencies: [] };
  const [names, nums] = await Promise.all([
    git(workspace, ['diff', '--name-status', '-M', baseRef, resultRef]),
    git(workspace, ['diff', '--numstat', '-M', baseRef, resultRef]),
  ]);
  const touched: string[] = [];
  for (const line of names.stdout.split('\n')) {
    const [status, a, b] = line.split('\t');
    if (!status || !a) continue;
    if (status.startsWith('A')) stats.filesCreated++;
    else if (status.startsWith('D')) stats.filesDeleted++;
    else stats.filesModified++;
    if (!status.startsWith('D')) touched.push(b ?? a);
  }
  for (const line of nums.stdout.split('\n')) {
    const [added, removed] = line.split('\t');
    if (added && added !== '-') stats.linesAdded += Number(added) || 0;
    if (removed && removed !== '-') stats.linesRemoved += Number(removed) || 0;
  }
  const deps = new Set<string>();
  for (const file of touched) {
    const base = path.basename(file);
    if (base !== 'package.json' && base !== 'requirements.txt') continue;
    const [before, after] = await Promise.all([show(workspace, baseRef, file), show(workspace, resultRef, file)]);
    const parse = base === 'package.json' ? depsOfPackageJson : depsOfRequirements;
    const old = parse(before);
    for (const d of parse(after)) if (!old.has(d)) deps.add(`${base === 'package.json' ? 'npm' : 'pip'}: ${d}`);
  }
  stats.newDependencies = [...deps].sort();
  return stats;
}

const MAX_FILE_PATCH = 200_000;
const MAX_TOTAL_PATCH = 3_000_000;

export async function laneDiff(workspace: string, baseRef: string, resultRef: string | null): Promise<LaneDiff> {
  // While a lane is still running there is no result commit yet: diff the working tree instead.
  const range = resultRef ? [baseRef, resultRef] : [baseRef];
  if (!resultRef) await git(workspace, ['add', '-A', '-N'], 60_000);
  const r = await git(workspace, ['diff', '--no-color', '--no-ext-diff', '-M', ...range], 120_000);
  const files: DiffFile[] = [];
  let total = 0;
  let truncated = false;
  for (const chunk of r.stdout.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const header = chunk.slice(0, chunk.indexOf('\n@@') === -1 ? chunk.length : chunk.indexOf('\n@@'));
    const m = chunk.match(/^diff --git a\/(.*?) b\/(.*)$/m);
    const file: DiffFile = {
      path: m?.[2] ?? 'unknown',
      status: /^new file mode/m.test(header) ? 'added' : /^deleted file mode/m.test(header) ? 'deleted' : /^rename from/m.test(header) ? 'renamed' : 'modified',
      added: 0,
      removed: 0,
      binary: /^Binary files |^GIT binary patch/m.test(chunk),
      patch: '',
      truncated: false,
    };
    const body = chunk.indexOf('\n@@') === -1 ? '' : chunk.slice(chunk.indexOf('\n@@') + 1);
    for (const line of body.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) file.added++;
      else if (line.startsWith('-') && !line.startsWith('---')) file.removed++;
    }
    if (!file.binary) {
      if (body.length > MAX_FILE_PATCH || total + body.length > MAX_TOTAL_PATCH) {
        file.patch = body.slice(0, Math.min(MAX_FILE_PATCH, Math.max(0, MAX_TOTAL_PATCH - total)));
        file.truncated = true;
        truncated = true;
      } else file.patch = body;
      total += file.patch.length;
    }
    files.push(file);
  }
  return { files, truncated };
}

/**
 * "Keep this one": publish a lane's result where the user asked — a new branch
 * in their repo, or a new folder. Refuses to overwrite anything that exists.
 */
export async function keepResult(workspace: string, resultRef: string, repoRoot: string | null, req: KeepRequest): Promise<string> {
  const target = req.target.trim();
  if (!target) throw new Error('Enter a name');
  if (req.mode === 'branch') {
    if (!repoRoot) throw new Error('This race started from an empty project, so there is no repository to add a branch to. Copy to a folder instead.');
    const valid = await git(repoRoot, ['check-ref-format', '--branch', target]);
    if (valid.code !== 0) throw new Error(`"${target}" is not a valid branch name`);
    const exists = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`]);
    if (exists.code === 0) throw new Error(`Branch "${target}" already exists; pick another name`);
    const r = await git(repoRoot, ['branch', target, resultRef]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git branch failed');
    return `Created branch "${target}" in ${repoRoot}. Nothing was checked out or merged; your working tree is unchanged.`;
  }
  const dest = path.resolve(expandHome(target));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error(`${dest} already exists and is not empty`);
  ensureDir(dest);
  const tar = path.join(os.tmpdir(), `agent-derby-${process.pid}-${Date.now()}.tar`);
  try {
    const a = await git(workspace, ['archive', '--format=tar', '-o', tar, resultRef], 120_000);
    if (a.code !== 0) throw new Error(a.stderr.trim() || 'git archive failed');
    const x = await exec('tar', ['-xf', tar, '-C', dest], { timeoutMs: 120_000 });
    if (x.code !== 0) throw new Error(x.stderr.trim() || 'could not unpack the files');
  } finally {
    fs.rmSync(tar, { force: true });
  }
  return `Copied the result to ${dest}.`;
}

/** Remove a lane's workspace; for worktrees also the worktree record and its branch. */
export async function removeWorkspace(workspace: string, repoRoot: string | null, branch: string | null): Promise<void> {
  if (repoRoot && fs.existsSync(repoRoot)) {
    await git(repoRoot, ['worktree', 'remove', '--force', workspace]);
    await git(repoRoot, ['worktree', 'prune']);
    if (branch && branch.startsWith('agent-derby/')) await git(repoRoot, ['branch', '-D', branch]);
  }
  fs.rmSync(workspace, { recursive: true, force: true });
}
