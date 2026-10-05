import fs from 'node:fs';
import path from 'node:path';
import type { AgentInfo } from '../../shared/types.js';
import { ensureDir, homeDir, packageFile, readJson, toolsDir } from '../paths.js';
import { spawnGroup, which } from '../proc.js';
import { sandboxStatus } from '../sandbox.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { customAdapter, loadCustomConfigs } from './custom.js';
import { copilotAdapter } from './copilot.js';
import { geminiAdapter } from './gemini.js';
import { opencodeAdapter } from './opencode.js';
import { qwenAdapter } from './qwen.js';
import { mockAdapters } from './mock.js';
import type { AgentAdapter, Detection } from './types.js';

/** The built-in agents. To add one: write an adapter file and add it to this list. */
const builtin: AgentAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter, copilotAdapter, opencodeAdapter, qwenAdapter];

export function allAdapters(): AgentAdapter[] {
  const custom = loadCustomConfigs().map(customAdapter);
  return [...builtin, ...custom, ...mockAdapters];
}

export function getAdapter(id: string): AgentAdapter | null {
  return allAdapters().find((a) => a.id === id) ?? null;
}

// Detection runs each CLI a couple of times, so cache it briefly.
const cache = new Map<string, { at: number; value: Promise<Detection> }>();
const TTL = 60_000;

export function detectCached(adapter: AgentAdapter): Promise<Detection> {
  const hit = cache.get(adapter.id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = adapter.detect().catch(
    (): Detection => ({ installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null }),
  );
  cache.set(adapter.id, { at: Date.now(), value });
  return value;
}

export function invalidateDetection(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}

function modelSuggestions(adapter: AgentAdapter): string[] {
  const shipped = readJson<Record<string, unknown>>(packageFile('config', 'models.json'), {});
  const user = readJson<Record<string, unknown>>(path.join(homeDir(), 'models.json'), {});
  const pick = (o: Record<string, unknown>) => (Array.isArray(o[adapter.id]) ? (o[adapter.id] as string[]) : null);
  const list = pick(user) ?? pick(shipped) ?? adapter.models;
  return ['', ...list.filter((m) => typeof m === 'string' && m)];
}

export async function describeAgents(): Promise<AgentInfo[]> {
  const sandbox = await sandboxStatus();
  const hasNpm = Boolean(which('npm'));
  return Promise.all(
    allAdapters().map(async (a): Promise<AgentInfo> => {
      const d = await detectCached(a);
      const confinement =
        a.kind === 'mock' ? null : a.ownSandbox ? null : sandbox.kind === 'none' ? `Not sandboxed: ${sandbox.reason}.` : `${sandbox.label}.`;
      return {
        id: a.id,
        name: a.name,
        vendor: a.vendor,
        kind: a.kind,
        color: a.color,
        installed: d.installed,
        version: d.version,
        path: d.path,
        origin: d.origin,
        auth: d.auth,
        authDetail: d.authDetail,
        installCommand: a.installCommand,
        canInstall: Boolean(a.managed) && hasNpm && !d.installed,
        canLogin: Boolean(a.login) && d.installed,
        models: modelSuggestions(a),
        docsUrl: a.docsUrl,
        sandboxNote: [a.sandboxNote, confinement].filter(Boolean).join(' ') || null,
        efforts: a.efforts ?? [],
        canResume: Boolean(a.resume),
        canJudge: d.installed && d.auth !== 'missing',
        support: a.support ?? 'full',
      };
    }),
  );
}

/**
 * One-click install: put the vendor's official CLI into Agent Derby's own
 * folder (never the global npm prefix), so nothing else on the machine changes.
 */
export function installAgent(adapter: AgentAdapter, onLine: (line: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    if (!adapter.managed) {
      onLine('This agent cannot be installed automatically.');
      return resolve(false);
    }
    const npm = which('npm');
    if (!npm) {
      onLine('npm was not found. Install Node.js from https://nodejs.org, or use the Agent Derby desktop app, which brings its own.');
      return resolve(false);
    }
    const dir = ensureDir(toolsDir());
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'agent-derby-tools', private: true }, null, 2));
    onLine(`Installing ${adapter.managed.npmPackage} into ${dir}`);
    const child = spawnGroup(npm, ['install', '--no-audit', '--no-fund', '--loglevel', 'http', `${adapter.managed.npmPackage}@latest`], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const feed = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onLine(line.trim().slice(0, 300));
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (e) => {
      onLine(`Install failed: ${e.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      invalidateDetection(adapter.id);
      onLine(code === 0 ? 'Installed.' : `Install failed (npm exited with code ${code}).`);
      resolve(code === 0);
    });
  });
}

export type { AgentAdapter } from './types.js';
