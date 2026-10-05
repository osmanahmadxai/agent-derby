import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_VERSION = '0.1.1';

/** Data folder: races, workspaces, managed CLIs, user config. */
export function homeDir(): string {
  return process.env.AGENT_DERBY_HOME || path.join(os.homedir(), '.agent-derby');
}

export function racesDir(): string {
  return path.join(homeDir(), 'races');
}

export function raceDir(raceId: string): string {
  return path.join(racesDir(), raceId);
}

/** Managed (one-click installed) agent CLIs live here, never in the global npm prefix. */
export function toolsDir(): string {
  return path.join(homeDir(), 'tools');
}

export function runDir(): string {
  return path.join(homeDir(), 'run');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directory containing the built files (dist/), whether bundled or run from source. */
export function distDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Locate a file shipped with the package (config/, dist/web, ...). */
export function packageFile(...parts: string[]): string {
  const here = distDir();
  const candidates = [path.join(here, '..', ...parts), path.join(here, '..', '..', ...parts), path.join(here, ...parts)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]!;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file so a kill mid-write never leaves a half-written file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
