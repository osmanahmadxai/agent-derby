import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, isWindows, which } from '../proc.js';
import { toolsDir } from '../paths.js';

export interface Located {
  path: string;
  origin: 'path' | 'managed' | 'bundled' | 'custom';
}

/**
 * Find an agent CLI. Order: explicit override, PATH, Agent Derby's own managed
 * install folder, then extra well-known locations supplied by the adapter.
 */
export function locate(bin: string, envOverride: string, extra: () => string[] = () => []): Located | null {
  const forced = process.env[envOverride];
  if (forced && fs.existsSync(forced)) return { path: forced, origin: 'custom' };

  const onPath = which(bin);
  if (onPath) return { path: onPath, origin: 'path' };

  const managed = managedBin(bin);
  if (managed) return { path: managed, origin: 'managed' };

  for (const candidate of extra()) {
    if (candidate && fs.existsSync(candidate)) return { path: candidate, origin: 'bundled' };
  }
  return null;
}

export function managedBin(bin: string): string | null {
  const dir = path.join(toolsDir(), 'node_modules', '.bin');
  for (const name of isWindows ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** Run `<exe> --version` and pull out something that looks like a version number. */
export async function readVersion(exe: string, args: string[] = ['--version']): Promise<string | null> {
  const r = await exec(exe, args, { timeoutMs: 20_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const m = text.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
  if (m) return m[0];
  const first = text.trim().split('\n')[0]?.trim();
  return r.code === 0 && first ? first.slice(0, 40) : null;
}

/** Newest-first list of sub-directories matching a pattern, for versioned install folders. */
export function newestDirs(parent: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(parent)
      .filter((n) => pattern.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((n) => path.join(parent, n));
  } catch {
    return [];
  }
}

export const home = (...parts: string[]) => path.join(os.homedir(), ...parts);
