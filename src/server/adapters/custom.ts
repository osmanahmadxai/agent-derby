import path from 'node:path';
import type { CustomAgentConfig } from '../../shared/types.js';
import { homeDir, readJson, writeJsonAtomic } from '../paths.js';
import { which } from '../proc.js';
import { ClaudeParser } from './claude.js';
import { CodexParser } from './codex.js';
import { GeminiParser } from './gemini.js';
import { readVersion } from './locate.js';
import { errorKind, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

/**
 * Any other agent CLI, described in <home>/agents.json instead of code.
 * If the CLI speaks one of the known streaming formats (many are forks of, or
 * compatible with, the three built-in ones) pick that format and it gets full
 * metrics. Otherwise use "text": its output is shown line by line, and metrics
 * that need structured events show as "not reported".
 */

class TextParser implements EventParser {
  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const text = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    if (!text.trim()) return [];
    if (stream === 'stderr' && errorKind(text) === 'auth') return [{ type: 'error', message: text.trim(), kind: 'auth' }];
    return [{ type: 'raw', text }];
  }
}

function file(): string {
  return path.join(homeDir(), 'agents.json');
}

export function loadCustomConfigs(): CustomAgentConfig[] {
  const list = readJson<CustomAgentConfig[]>(file(), []);
  return Array.isArray(list) ? list.filter((c) => c && c.id && c.command) : [];
}

export function validateCustom(c: Partial<CustomAgentConfig>): string | null {
  if (!c.name?.trim()) return 'Give the agent a name';
  if (!c.command?.trim()) return 'Enter the command that starts the agent';
  if (!Array.isArray(c.args)) return 'Arguments must be a list';
  if (c.promptVia !== 'stdin' && c.promptVia !== 'arg') return 'Choose how the prompt is passed';
  if (c.promptVia === 'arg' && !c.args.some((a) => a.includes('{prompt}'))) return 'Add {prompt} to the arguments, or pass the prompt on stdin';
  if (!['text', 'claude-stream-json', 'codex-json', 'gemini-stream-json'].includes(String(c.format))) return 'Unknown output format';
  return null;
}

export function saveCustom(c: CustomAgentConfig): void {
  const id = `custom-${(c.id || c.name).toLowerCase().replace(/^custom-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'}`;
  const list = loadCustomConfigs().filter((x) => x.id !== id);
  list.push({ ...c, id });
  writeJsonAtomic(file(), list);
}

export function deleteCustom(id: string): void {
  writeJsonAtomic(
    file(),
    loadCustomConfigs().filter((x) => x.id !== id),
  );
}

const PALETTE = ['#eab308', '#06b6d4', '#ec4899', '#84cc16', '#f43f5e', '#8b5cf6'];

/** Fill {prompt} {model} {workspace}; drop a flag whose value is an empty {model}. */
export function fillArgs(args: string[], vars: { prompt: string; model: string; workspace: string }): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '{model}' && !vars.model) {
      if (out.length && out[out.length - 1]!.startsWith('-')) out.pop();
      continue;
    }
    out.push(a.replaceAll('{prompt}', vars.prompt).replaceAll('{model}', vars.model).replaceAll('{workspace}', vars.workspace));
  }
  return out;
}

export function customAdapter(c: CustomAgentConfig, index: number): AgentAdapter {
  return {
    id: c.id,
    name: c.name,
    vendor: 'Custom',
    kind: 'custom',
    color: c.color || PALETTE[index % PALETTE.length]!,
    installCommand: c.installCommand ?? null,
    docsUrl: null,
    models: c.models ?? [],
    sandboxNote: 'Custom agent, run inside the Agent Derby sandbox.',
    async detect() {
      const exe = which(c.command);
      if (!exe) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
      const version = await readVersion(exe, c.versionArgs ?? ['--version']);
      return { installed: true, version, path: exe, origin: 'custom', auth: 'unknown', authDetail: 'Sign-in state is not checked for custom agents' };
    },
    start(ctx) {
      const args = fillArgs(c.args, { prompt: ctx.prompt, model: ctx.model, workspace: ctx.workspace });
      return { command: ctx.exe, args, stdin: c.promptVia === 'stdin' ? ctx.prompt : undefined };
    },
    createParser(ctx) {
      switch (c.format) {
        case 'claude-stream-json':
          return new ClaudeParser(ctx.workspace);
        case 'codex-json':
          return new CodexParser(ctx.workspace);
        case 'gemini-stream-json':
          return new GeminiParser(ctx.workspace);
        default:
          return new TextParser();
      }
    },
  };
}
