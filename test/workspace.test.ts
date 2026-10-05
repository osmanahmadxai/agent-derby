import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-derby-ws-')));
process.env.AGENT_DERBY_HOME = path.join(tmp, 'home');

const ws = await import('../src/server/race/workspace.js');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

const repo = path.join(tmp, 'user-repo');
let head = '';

beforeAll(() => {
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 'user@example.com');
  sh(repo, 'config', 'user.name', 'User');
  write(repo, 'README.md', '# project\n');
  write(repo, 'package.json', JSON.stringify({ name: 'p', dependencies: { leftpad: '1.0.0' } }, null, 2));
  write(repo, 'src/app.js', 'console.log(1);\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'initial');
  head = sh(repo, 'rev-parse', 'HEAD');
  // The user has work in progress: one modified file, one untracked file.
  write(repo, 'src/app.js', 'console.log("uncommitted user change");\n');
  write(repo, 'notes.txt', 'private notes\n');
  // A hook that would scream if Agent Derby ever triggered it.
  write(repo, '.git/hooks/pre-commit', '#!/bin/sh\necho hook-ran > "$(git rev-parse --show-toplevel)/HOOK_RAN"\nexit 1\n');
  fs.chmodSync(path.join(repo, '.git/hooks/pre-commit'), 0o755);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('checkRepo', () => {
  it('describes a repository and notices uncommitted work', async () => {
    const r = await ws.checkRepo(path.join(repo, 'src'));
    expect(r).toMatchObject({ ok: true, path: repo, branch: 'main', head, dirty: true, error: null });
  });

  it('explains what is wrong with a bad path', async () => {
    expect((await ws.checkRepo(path.join(tmp, 'nope'))).error).toMatch(/does not exist/);
    fs.mkdirSync(path.join(tmp, 'plain'));
    expect((await ws.checkRepo(path.join(tmp, 'plain'))).error).toMatch(/not inside a git repository/);
    expect((await ws.checkRepo('')).ok).toBe(false);
  });
});

describe('worktree isolation (starting from a repo)', () => {
  const a = path.join(tmp, 'home', 'races', 'r1', 'workspaces', 'alpha');
  const b = path.join(tmp, 'home', 'races', 'r1', 'workspaces', 'beta');
  let refA = '';
  let refB = '';

  it('gives each lane its own worktree on its own branch at the same commit', async () => {
    const [pa, pb] = await Promise.all([
      ws.prepareWorktree(repo, a, 'agent-derby/r1/alpha', head),
      ws.prepareWorktree(repo, b, 'agent-derby/r1/beta', head),
    ]);
    expect(pa.baseRef).toBe(head);
    expect(pb.baseRef).toBe(head);
    expect(sh(a, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(a, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent-derby/r1/alpha');
    expect(sh(b, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent-derby/r1/beta');
  });

  it('starts from the commit, not from the user\'s uncommitted changes', () => {
    expect(fs.readFileSync(path.join(a, 'src/app.js'), 'utf8')).toBe('console.log(1);\n');
    expect(fs.existsSync(path.join(a, 'notes.txt'))).toBe(false);
  });

  it('keeps lanes from seeing each other\'s work', async () => {
    write(a, 'alpha.txt', 'from alpha\n');
    write(a, 'src/app.js', 'console.log("alpha");\n');
    write(a, 'node_modules/big/index.js', 'x'.repeat(1000));
    write(a, 'agent-derby.json', '{"type":"static"}');
    write(a, 'package.json', JSON.stringify({ name: 'p', dependencies: { leftpad: '1.0.0', express: '^5' }, devDependencies: { vitest: '^3' } }, null, 2));
    write(b, 'beta.txt', 'from beta\nsecond line\n');
    fs.rmSync(path.join(b, 'README.md'));

    expect(fs.existsSync(path.join(b, 'alpha.txt'))).toBe(false);
    expect(fs.existsSync(path.join(a, 'beta.txt'))).toBe(false);
    expect(await ws.liveChangedCount(a, head)).toBe(3); // alpha.txt, src/app.js, package.json — not node_modules, not the manifest
    expect(await ws.liveChangedCount(b, head)).toBe(2);
  });

  it('records results without touching the user\'s repo state', async () => {
    refA = await ws.snapshot(a);
    refB = await ws.snapshot(b);
    expect(refA).not.toBe(head);
    expect(refB).not.toBe(refA);

    // The user's checkout is exactly as they left it.
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(sh(repo, 'rev-parse', 'main')).toBe(head);
    // (sh() trims, so the leading space of ' M' is gone) modified-but-unstaged, plus their untracked file
    expect(sh(repo, 'status', '--porcelain')).toBe('M src/app.js\n?? notes.txt');
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8')).toBe('console.log("uncommitted user change");\n');
    expect(fs.existsSync(path.join(repo, 'alpha.txt'))).toBe(false);
    // Their hooks never ran, and nothing was written to their git config.
    expect(fs.existsSync(path.join(repo, 'HOOK_RAN'))).toBe(false);
    expect(fs.existsSync(path.join(a, 'HOOK_RAN'))).toBe(false);
    expect(sh(repo, 'config', '--local', '--list')).not.toMatch(/excludesfile|hookspath|agent-derby/i);
  });

  it('measures what each lane changed', async () => {
    const sa = await ws.codeStats(a, head, refA);
    expect(sa).toMatchObject({ filesCreated: 1, filesModified: 2, filesDeleted: 0 });
    expect(sa.newDependencies).toEqual(['npm: express', 'npm: vitest']);
    expect(sa.linesAdded).toBeGreaterThan(2);
    const sb = await ws.codeStats(b, head, refB);
    expect(sb).toMatchObject({ filesCreated: 1, filesModified: 0, filesDeleted: 1, linesAdded: 2, linesRemoved: 1, newDependencies: [] });
  });

  it('produces a per-file diff that leaves out dependencies and the manifest', async () => {
    const d = await ws.laneDiff(a, head, refA);
    expect(d.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ['alpha.txt', 'added'],
      ['package.json', 'modified'],
      ['src/app.js', 'modified'],
    ]);
    const app = d.files.find((f) => f.path === 'src/app.js')!;
    expect(app).toMatchObject({ added: 1, removed: 1, binary: false });
    expect(app.patch).toContain('+console.log("alpha");');
    expect((await ws.laneDiff(b, head, refB)).files.find((f) => f.path === 'README.md')?.status).toBe('deleted');
  });

  it('"keep" creates a branch without checking it out, and refuses to overwrite', async () => {
    const msg = await ws.keepResult(a, refA, repo, { mode: 'branch', target: 'winner' });
    expect(msg).toMatch(/Created branch "winner"/);
    expect(sh(repo, 'rev-parse', 'winner')).toBe(refA);
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(sh(repo, 'rev-parse', 'main')).toBe(head);
    await expect(ws.keepResult(a, refA, repo, { mode: 'branch', target: 'winner' })).rejects.toThrow(/already exists/);
    await expect(ws.keepResult(a, refA, repo, { mode: 'branch', target: 'main' })).rejects.toThrow(/already exists/);
    await expect(ws.keepResult(a, refA, repo, { mode: 'branch', target: 'bad..name' })).rejects.toThrow(/not a valid branch name/);
  });

  it('"keep" copies to a new folder, and refuses a non-empty one', async () => {
    const dest = path.join(tmp, 'kept');
    await ws.keepResult(a, refA, repo, { mode: 'folder', target: dest });
    expect(fs.readFileSync(path.join(dest, 'alpha.txt'), 'utf8')).toBe('from alpha\n');
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
    await expect(ws.keepResult(a, refA, repo, { mode: 'folder', target: dest })).rejects.toThrow(/not empty/);
  });

  it('deleting removes the worktrees and only the race\'s own branches', async () => {
    await ws.removeWorkspace(a, repo, 'agent-derby/r1/alpha');
    await ws.removeWorkspace(b, repo, 'agent-derby/r1/beta');
    expect(fs.existsSync(a)).toBe(false);
    const branches = sh(repo, 'branch', '--format=%(refname:short)').split('\n').sort();
    expect(branches).toEqual(['main', 'winner']);
    expect(sh(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(sh(repo, 'status', '--porcelain')).toContain('notes.txt');
  });
});

describe('empty-project isolation', () => {
  it('creates independent repositories with a starting commit', async () => {
    const a = path.join(tmp, 'empty', 'a');
    const b = path.join(tmp, 'empty', 'b');
    const [pa, pb] = await Promise.all([ws.prepareEmpty(a), ws.prepareEmpty(b)]);
    expect(pa.branch).toBeNull();
    write(a, 'index.html', '<h1>a</h1>\n');
    expect(fs.readdirSync(b).filter((f) => f !== '.git')).toEqual([]);
    const ref = await ws.snapshot(a);
    expect(await ws.codeStats(a, pa.baseRef, ref)).toMatchObject({ filesCreated: 1, linesAdded: 1 });
    // Nothing changed: the snapshot is the starting commit and the stats are all zero.
    expect(await ws.snapshot(b)).toBe(pb.baseRef);
    expect(await ws.codeStats(b, pb.baseRef, pb.baseRef)).toMatchObject({ filesCreated: 0, filesModified: 0, filesDeleted: 0 });
    await expect(ws.keepResult(a, ref, null, { mode: 'branch', target: 'x' })).rejects.toThrow(/empty project/);
  });
});
