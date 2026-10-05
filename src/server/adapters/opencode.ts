import type { ToolKind } from '../../shared/types.js';
import { exec } from '../proc.js';
import { relativize } from './claude.js';
import { home, locate, readVersion } from './locate.js';
import { clip, errorKind, tryJson, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

/**
 * OpenCode. Flags verified against `opencode run --help` for 1.18.34:
 *   run <message>      non-interactive run
 *   --format json      raw JSON events, one per line
 *   --auto             auto-approve permissions
 *   --dir <path>       the folder to work in (passed explicitly: OpenCode otherwise trusts $PWD)
 *   -m provider/model  model
 *   -s <sessionID>     continue a session (follow-up rounds)
 * Event shapes are from a real recorded run (test/fixtures/opencode.jsonl):
 * step_start, tool_use, text, step_finish (tokens and cost per step), error.
 * A tool is reported once, when it has finished, with its own start/end times.
 * OpenCode does not put the model name in the stream.
 */

function toolKind(name: string): ToolKind {
  if (/bash|shell|exec/i.test(name)) return 'command';
  if (/write|edit|patch|multiedit/i.test(name)) return 'edit';
  if (/read|view/i.test(name)) return 'read';
  if (/glob|grep|list|ls|find|codesearch/i.test(name)) return 'search';
  if (/web|fetch/i.test(name)) return 'web';
  if (/todo|plan/i.test(name)) return 'plan';
  if (/task|agent/i.test(name)) return 'agent';
  return 'other';
}

export class OpenCodeParser implements EventParser {
  private sawInit = false;
  private started = new Set<string>();

  constructor(private workspace: string) {}

  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const o = tryJson(line);
    if (!o) {
      const text = line.trim();
      if (!text) return [];
      if (stream === 'stderr' && errorKind(text) === 'auth') return [{ type: 'error', message: text, kind: 'auth' }];
      return [{ type: 'raw', text: line }];
    }
    try {
      return this.handle(o);
    } catch {
      return [{ type: 'raw', text: clip(line, 500) }];
    }
  }

  private handle(o: Record<string, any>): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (!this.sawInit && o.sessionID) {
      this.sawInit = true;
      out.push({ type: 'init', sessionId: o.sessionID });
    }
    const part = o.part ?? {};
    switch (o.type) {
      case 'step_start':
        out.push({ type: 'turn' }, { type: 'thinking_active' });
        break;
      case 'text':
        if (part.text) out.push({ type: 'message', id: part.id, text: String(part.text) });
        break;
      case 'reasoning':
        if (part.text) out.push({ type: 'thinking', id: part.id, text: String(part.text) });
        break;
      case 'tool_use': {
        const id = String(part.callID ?? part.id);
        const state = part.state ?? {};
        const input = state.input ?? {};
        const name = String(part.tool ?? 'tool');
        const target =
          typeof input.filePath === 'string'
            ? relativize(input.filePath, this.workspace)
            : typeof input.command === 'string'
              ? input.command
              : typeof input.pattern === 'string'
                ? input.pattern
                : typeof input.url === 'string'
                  ? input.url
                  : typeof input.path === 'string'
                    ? relativize(input.path, this.workspace)
                    : typeof state.title === 'string'
                      ? state.title
                      : null;
        const finished = state.status === 'completed' || state.status === 'error';
        if (!this.started.has(id)) {
          this.started.add(id);
          const took = finished && state.time?.start && state.time?.end ? Math.max(0, state.time.end - state.time.start) : 0;
          out.push({ type: 'tool_start', id, kind: toolKind(name), name, target, ...(took ? { agoMs: took } : {}) });
        }
        if (finished) {
          const exit = typeof state.metadata?.exit === 'number' ? state.metadata.exit : null;
          out.push({
            type: 'tool_end',
            id,
            ok: state.status === 'completed' && (exit === null || exit === 0),
            exitCode: exit,
            output: clip(String(state.output ?? state.error ?? '')),
          });
        }
        break;
      }
      case 'step_finish': {
        const t = part.tokens;
        if (t && typeof t === 'object') {
          const usage: Record<string, number> = {};
          if (typeof t.input === 'number') usage.input = t.input;
          if (typeof t.output === 'number') usage.output = t.output;
          if (typeof t.reasoning === 'number') usage.reasoning = t.reasoning;
          if (typeof t.cache?.read === 'number') usage.cacheRead = t.cache.read;
          if (typeof t.cache?.write === 'number') usage.cacheWrite = t.cache.write;
          out.push({ type: 'usage', mode: 'add', usage });
        }
        if (typeof part.cost === 'number') {
          this.cost += part.cost;
          out.push({ type: 'cost', usd: this.cost });
        }
        if (part.reason === 'stop') out.push({ type: 'result', ok: true });
        break;
      }
      case 'error': {
        const message = String(o.error?.data?.message ?? o.error?.message ?? o.error?.name ?? 'Error');
        out.push({ type: 'error', message, kind: errorKind(message) }, { type: 'result', ok: false, error: message });
        break;
      }
    }
    return out;
  }

  private cost = 0;
}

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  name: 'OpenCode',
  vendor: 'opencode.ai',
  kind: 'builtin',
  color: '#f59e0b',
  installCommand: 'npm install -g opencode-ai',
  docsUrl: 'https://opencode.ai/docs',
  models: [],
  sandboxNote: 'Auto-approve mode inside the Agent Derby sandbox.',
  managed: { npmPackage: 'opencode-ai', bin: 'opencode' },
  writablePaths: () => [home('.local', 'share', 'opencode'), home('.config', 'opencode'), home('.cache', 'opencode'), home('.local', 'state', 'opencode')],

  async detect() {
    const found = locate('opencode', 'AGENT_DERBY_OPENCODE_BIN');
    if (!found) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
    const [version, auth] = await Promise.all([readVersion(found.path), exec(found.path, ['auth', 'list'], { timeoutMs: 20_000 })]);
    const text = auth.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const signedIn = /\b[1-9]\d* credentials?\b/i.test(text);
    // OpenCode ships free models that need no account, so it is always usable.
    return {
      installed: true,
      version,
      path: found.path,
      origin: found.origin,
      auth: 'ok',
      authDetail: signedIn ? 'Signed in to a provider' : 'No sign-in needed for its free models',
    };
  },

  start(ctx) {
    const args = ['run', '--format', 'json', '--auto', '--dir', ctx.workspace];
    if (ctx.model) args.push('-m', ctx.model);
    args.push(ctx.prompt);
    return { command: ctx.exe, args };
  },

  resume(ctx) {
    const args = ['run', '--format', 'json', '--auto', '--dir', ctx.workspace, '-s', ctx.sessionId];
    if (ctx.model) args.push('-m', ctx.model);
    args.push(ctx.prompt);
    return { command: ctx.exe, args };
  },

  createParser(ctx) {
    return new OpenCodeParser(ctx.workspace);
  },

  login(exe) {
    return { command: exe, args: ['auth', 'login'], hint: 'Pick a provider and sign in. This is optional: the free models work without it.' };
  },
};
