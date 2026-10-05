import fs from 'node:fs';
import type { ToolKind } from '../../shared/types.js';
import { readJson } from '../paths.js';
import { home, locate, readVersion } from './locate.js';
import { relativize } from './claude.js';
import { clip, errorKind, tryJson, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

/**
 * Google Gemini CLI. Flags verified against `gemini --help` for 0.62.0:
 *   -p <prompt>                  non-interactive (headless) run
 *   -o stream-json               streaming JSON events
 *   --approval-mode yolo         all tools pre-approved
 *   --skip-trust                 trust the workspace for this session
 * Event shapes read from the CLI's own stream-json formatter (init, message,
 * tool_use, tool_result, error, result). Usage arrives in `result.stats`;
 * Gemini reports no cost, no reasoning tokens and no turn count in the stream.
 */

function toolKind(name: string): ToolKind {
  if (/shell|command|exec/i.test(name)) return 'command';
  if (/write|replace|edit|patch/i.test(name)) return 'edit';
  if (/read/i.test(name)) return 'read';
  if (/glob|grep|search_file|list_dir|^ls$/i.test(name)) return 'search';
  if (/web|fetch|google/i.test(name)) return 'web';
  if (/todo|plan|memory/i.test(name)) return 'plan';
  if (/agent|delegate/i.test(name)) return 'agent';
  return 'other';
}

function target(params: Record<string, any> | undefined, workspace: string): string | null {
  if (!params) return null;
  for (const k of ['file_path', 'absolute_path', 'path', 'dir_path']) {
    if (typeof params[k] === 'string') return relativize(params[k], workspace);
  }
  for (const k of ['command', 'pattern', 'query', 'url', 'prompt', 'description']) {
    if (typeof params[k] === 'string') return params[k];
  }
  if (Array.isArray(params.paths)) return params.paths.map((p: string) => relativize(String(p), workspace)).join(', ');
  return null;
}

export class GeminiParser implements EventParser {
  private segment = 0;

  constructor(private workspace: string) {}

  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const o = tryJson(line);
    if (!o) {
      const text = line.trim();
      if (!text) return [];
      if (/YOLO mode is enabled/i.test(text)) return [];
      if (errorKind(text) === 'auth' && /auth method|GEMINI_API_KEY|login|credentials/i.test(text)) {
        return [{ type: 'error', message: text, kind: 'auth' }];
      }
      if (stream === 'stderr' && /^\[?(ERROR|WARNING)\]?/i.test(text)) {
        return [{ type: 'error', message: text, kind: errorKind(text), retry: /warning/i.test(text) }];
      }
      return [{ type: 'raw', text: line }];
    }
    try {
      return this.handle(o);
    } catch {
      return [{ type: 'raw', text: clip(line, 500) }];
    }
  }

  private handle(o: Record<string, any>): AgentEvent[] {
    switch (o.type) {
      case 'init':
        return [{ type: 'init', model: o.model, sessionId: o.session_id }, { type: 'thinking_active' }];
      case 'message':
        if (o.role !== 'assistant' || !o.content) return [];
        return [{ type: 'message', id: `m${this.segment}`, text: String(o.content), delta: Boolean(o.delta) }];
      case 'tool_use': {
        this.segment++;
        const name = String(o.tool_name ?? 'tool');
        return [{ type: 'tool_start', id: String(o.tool_id), kind: toolKind(name), name, target: target(o.parameters, this.workspace) }];
      }
      case 'tool_result': {
        const ok = o.status === 'success';
        const output = String(o.output || o.error?.message || '');
        const exit = output.match(/exit code:?\s*(\d+)/i);
        return [
          { type: 'tool_end', id: String(o.tool_id), ok, output: clip(output), exitCode: exit ? Number(exit[1]) : ok ? 0 : null },
          { type: 'thinking_active' },
        ];
      }
      case 'error': {
        const message = String(o.message ?? 'Error');
        return [{ type: 'error', message, kind: errorKind(message), retry: o.severity === 'warning' }];
      }
      case 'result': {
        const out: AgentEvent[] = [];
        const s = o.stats;
        if (s && typeof s === 'object') {
          const usage: Record<string, number> = {};
          // `input` is the uncached part of the prompt; `cached` the part served from cache.
          if (typeof s.input === 'number') usage.input = s.input;
          else if (typeof s.input_tokens === 'number') usage.input = Math.max(0, s.input_tokens - (Number(s.cached) || 0));
          if (typeof s.cached === 'number') usage.cacheRead = s.cached;
          if (typeof s.output_tokens === 'number') usage.output = s.output_tokens;
          out.push({ type: 'usage', mode: 'total', usage });
          const models = s.models && typeof s.models === 'object' ? Object.keys(s.models) : [];
          if (models.length) out.push({ type: 'init', model: models.join(', ') });
        }
        const ok = o.status === 'success';
        const error = ok ? undefined : String(o.error?.message ?? 'Run failed');
        if (error) out.push({ type: 'error', message: error, kind: errorKind(error) });
        out.push({ type: 'result', ok, error });
        return out;
      }
      default:
        return [];
    }
  }
}

function hasOauth(): boolean {
  return fs.existsSync(home('.gemini', 'oauth_creds.json'));
}

function selectedAuth(): string | null {
  const settings = readJson<any>(home('.gemini', 'settings.json'), {});
  return settings?.security?.auth?.selectedType ?? settings?.selectedAuthType ?? null;
}

export const geminiAdapter: AgentAdapter = {
  id: 'gemini',
  name: 'Gemini CLI',
  vendor: 'Google',
  kind: 'builtin',
  color: '#4285f4',
  installCommand: 'npm install -g @google/gemini-cli',
  docsUrl: 'https://geminicli.com/docs',
  models: [],
  sandboxNote: 'YOLO approval mode inside the Agent Derby sandbox.',
  writablePaths: () => geminiWritable(),
  managed: { npmPackage: '@google/gemini-cli', bin: 'gemini' },

  async detect() {
    const found = locate('gemini', 'AGENT_DERBY_GEMINI_BIN');
    if (!found) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
    const version = await readVersion(found.path);
    let auth: 'ok' | 'missing' | 'unknown' = 'missing';
    let authDetail: string | null = 'Not signed in';
    if (hasOauth()) {
      auth = 'ok';
      authDetail = 'Signed in with Google';
    } else if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      auth = 'ok';
      authDetail = 'Using an API key from the environment';
    } else if (process.env.GOOGLE_GENAI_USE_VERTEXAI) {
      auth = 'ok';
      authDetail = 'Using Vertex AI from the environment';
    } else if (selectedAuth()) {
      auth = 'unknown';
      authDetail = `Auth method "${selectedAuth()}" is configured`;
    }
    return { installed: true, version, path: found.path, origin: found.origin, auth, authDetail };
  },

  start(ctx) {
    const args = ['-o', 'stream-json', '--approval-mode', 'yolo', '--skip-trust'];
    if (ctx.model) args.push('-m', ctx.model);
    // The prompt goes in as one argument: Gemini joins stdin and -p with extra newlines, which would alter it.
    args.push('-p', ctx.prompt);
    const env: Record<string, string> = {};
    // Signed in with Google but no auth method saved: select it for this run only.
    if (hasOauth() && !selectedAuth()) env.GOOGLE_GENAI_USE_GCA = 'true';
    return { command: ctx.exe, args, env };
  },

  // Sessions are stored per project folder, so "latest" is this workspace's own session.
  resume(ctx) {
    const spec = geminiAdapter.start(ctx);
    return { ...spec, args: ['--resume', 'latest', ...spec.args] };
  },

  createParser(ctx) {
    return new GeminiParser(ctx.workspace);
  },

  login(exe) {
    return {
      command: exe,
      args: [],
      env: { GOOGLE_GENAI_USE_GCA: 'true' },
      hint: 'Choose "Sign in with Google", finish in the browser, then type /quit here.',
    };
  },
};

function geminiWritable() {
  return [home('.gemini')];
}
