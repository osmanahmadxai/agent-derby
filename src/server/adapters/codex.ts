import type { ToolKind } from '../../shared/types.js';
import { exec } from '../proc.js';
import { home, locate, readVersion } from './locate.js';
import { relativize } from './claude.js';
import { clip, errorKind, tryJson, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

/**
 * OpenAI Codex CLI. Flags verified against `codex exec --help` for 0.160.0:
 *   exec                         non-interactive run
 *   --json                       JSONL events on stdout
 *   --sandbox workspace-write    Codex's own OS sandbox: writes only inside the workspace
 *   -c sandbox_workspace_write.network_access=true   keep the network, so installs work
 *   --skip-git-repo-check        allow fresh folders
 *   -                            read the prompt from stdin
 * `codex exec` never asks for approval, so nothing else is needed for auto-approval.
 * Event shapes follow the ThreadEvent types published in @openai/codex-sdk 0.160.0.
 * Usage arrives in `turn.completed`; Codex reports no cost and no model name in the stream.
 */

function stripShell(command: string): string {
  const m = command.match(/^(?:\/\S+\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/);
  return m ? m[2]! : command;
}

export class CodexParser implements EventParser {
  private started = new Set<string>();

  constructor(private workspace: string) {}

  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const o = tryJson(line);
    if (!o) {
      if (!line.trim()) return [];
      // Codex logs transport retries to stderr; the same information arrives as JSON events.
      if (stream === 'stderr' && /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(ERROR|WARN|INFO)/.test(line)) return [];
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
      case 'thread.started':
        return [{ type: 'init', sessionId: o.thread_id }];
      case 'turn.started':
        return [{ type: 'turn' }, { type: 'thinking_active' }];
      case 'turn.completed': {
        const u = o.usage ?? {};
        const cached = Number(u.cached_input_tokens) || 0;
        const usage: Record<string, number> = {};
        // OpenAI counts cached tokens inside input_tokens; we report uncached input separately.
        if (typeof u.input_tokens === 'number') usage.input = Math.max(0, u.input_tokens - cached);
        if (typeof u.cached_input_tokens === 'number') usage.cacheRead = cached;
        if (typeof u.cache_write_input_tokens === 'number') usage.cacheWrite = u.cache_write_input_tokens;
        if (typeof u.output_tokens === 'number') usage.output = u.output_tokens;
        if (typeof u.reasoning_output_tokens === 'number') usage.reasoning = u.reasoning_output_tokens;
        return [
          { type: 'usage', mode: 'add', usage },
          { type: 'result', ok: true },
        ];
      }
      case 'turn.failed': {
        const message = String(o.error?.message ?? 'Turn failed');
        return [
          { type: 'error', message, kind: errorKind(message) },
          { type: 'result', ok: false, error: message },
        ];
      }
      case 'error': {
        const message = String(o.message ?? 'Error');
        return [{ type: 'error', message, kind: errorKind(message), retry: /^Reconnecting/i.test(message) }];
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(o.type.slice(5) as 'started' | 'updated' | 'completed', o.item ?? {});
      default:
        return [];
    }
  }

  private begin(id: string, kind: ToolKind, name: string, target: string | null, out: AgentEvent[]): void {
    if (this.started.has(id)) return;
    this.started.add(id);
    out.push({ type: 'tool_start', id, kind, name, target });
  }

  private item(phase: 'started' | 'updated' | 'completed', item: Record<string, any>): AgentEvent[] {
    const out: AgentEvent[] = [];
    const id = String(item.id ?? `item_${this.started.size}`);
    const done = phase === 'completed';
    switch (item.type) {
      case 'agent_message':
        if (done && item.text) out.push({ type: 'message', text: item.text });
        break;
      case 'reasoning':
        if (done && item.text) out.push({ type: 'thinking', text: item.text });
        else out.push({ type: 'thinking_active' });
        break;
      case 'command_execution':
        this.begin(id, 'command', 'shell', stripShell(String(item.command ?? '')), out);
        if (done) {
          const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
          out.push({
            type: 'tool_end',
            id,
            ok: item.status === 'completed' && (exitCode === null || exitCode === 0),
            exitCode,
            output: clip(String(item.aggregated_output ?? '')),
          });
        }
        break;
      case 'file_change': {
        const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
        const target = changes.map((c) => relativize(String(c.path), this.workspace)).join(', ') || null;
        this.begin(id, 'edit', 'apply_patch', target, out);
        if (done) {
          out.push({
            type: 'tool_end',
            id,
            ok: item.status === 'completed',
            output: changes.map((c) => `${c.kind} ${relativize(String(c.path), this.workspace)}`).join('\n'),
          });
        }
        break;
      }
      case 'mcp_tool_call':
        this.begin(id, 'other', `${item.server}.${item.tool}`, null, out);
        if (done) out.push({ type: 'tool_end', id, ok: item.status === 'completed', output: item.error?.message });
        break;
      case 'collab_tool_call':
        this.begin(id, 'agent', String(item.tool ?? 'agent'), typeof item.prompt === 'string' ? item.prompt : null, out);
        if (done) out.push({ type: 'tool_end', id, ok: item.status !== 'failed' });
        break;
      case 'web_search':
        this.begin(id, 'web', 'web_search', String(item.query ?? ''), out);
        if (done) out.push({ type: 'tool_end', id, ok: true });
        break;
      case 'todo_list': {
        const items: any[] = Array.isArray(item.items) ? item.items : [];
        if (phase === 'started') {
          this.begin(id, 'plan', 'todo_list', `${items.filter((i) => i.completed).length}/${items.length} steps done`, out);
          out.push({ type: 'tool_end', id, ok: true, output: items.map((i) => `${i.completed ? '[x]' : '[ ]'} ${i.text}`).join('\n') });
        }
        break;
      }
      case 'error':
        if (done) {
          const message = String(item.message ?? 'Error');
          out.push({ type: 'error', message, kind: errorKind(message), retry: /falling back|retry/i.test(message) });
        }
        break;
    }
    return out;
  }
}

function codexConfig(effort: string): string[] {
  const args = ['-c', 'sandbox_workspace_write.network_access=true'];
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  return args;
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  kind: 'builtin',
  color: '#10a37f',
  installCommand: 'npm install -g @openai/codex',
  docsUrl: 'https://developers.openai.com/codex/cli',
  models: [],
  // Values of the model_reasoning_effort config key, as listed in @openai/codex-sdk 0.160.0.
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  sandboxNote: "Runs in Codex's own workspace-write sandbox with network access.",
  ownSandbox: true,
  writablePaths: () => codexWritable(),
  managed: { npmPackage: '@openai/codex', bin: 'codex' },

  async detect() {
    const found = locate('codex', 'AGENT_DERBY_CODEX_BIN');
    if (!found) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
    const [version, status] = await Promise.all([
      readVersion(found.path),
      exec(found.path, ['login', 'status'], { timeoutMs: 20_000 }),
    ]);
    const text = `${status.stdout}\n${status.stderr}`.trim();
    let auth: 'ok' | 'missing' | 'unknown' = 'unknown';
    let authDetail: string | null = null;
    if (/not logged in/i.test(text)) {
      auth = 'missing';
      authDetail = 'Not signed in';
    } else if (/logged in/i.test(text)) {
      auth = 'ok';
      authDetail = /chatgpt/i.test(text) ? 'Signed in with ChatGPT' : /api key/i.test(text) ? 'Signed in with an API key' : 'Signed in';
    }
    return { installed: true, version, path: found.path, origin: found.origin, auth, authDetail };
  },

  start(ctx) {
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...codexConfig(ctx.effort), '--color', 'never', '-C', ctx.workspace];
    if (ctx.model) args.push('-m', ctx.model);
    args.push('-');
    return { command: ctx.exe, args, stdin: ctx.prompt };
  },

  // `codex exec resume [SESSION_ID] [PROMPT]`, per `codex exec resume --help`. The sandbox
  // policy is passed as config because `resume` does not take --sandbox.
  resume(ctx) {
    const args = ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', ...codexConfig(ctx.effort)];
    if (ctx.model) args.push('-m', ctx.model);
    args.push(ctx.sessionId, '-');
    return { command: ctx.exe, args, stdin: ctx.prompt };
  },

  createParser(ctx) {
    return new CodexParser(ctx.workspace);
  },

  login(exe) {
    return { command: exe, args: ['login'], hint: 'Sign in with your ChatGPT account in the browser window that opens.' };
  },
};

function codexWritable() {
  return [home('.codex')];
}
