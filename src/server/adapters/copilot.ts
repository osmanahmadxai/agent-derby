import type { ToolKind } from '../../shared/types.js';
import { exec, which } from '../proc.js';
import { relativize } from './claude.js';
import { home, locate, readVersion } from './locate.js';
import { clip, errorKind, tryJson, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

/**
 * GitHub Copilot CLI. Flags verified against `copilot --help` for 1.0.91:
 *   -p <text>                 non-interactive run
 *   --output-format json      JSONL events
 *   --allow-all               all tools, paths and URLs pre-approved
 *   --no-ask-user             never stop to ask a question
 *   --disable-builtin-mcps    do not give an unattended run access to your GitHub account
 *   --no-custom-instructions  leave out per-machine instructions
 *   --model, --reasoning-effort, --resume=<sessionId>
 * Event shapes are from a real recorded run (test/fixtures/copilot.jsonl).
 * Copilot reports "premium requests", not tokens or dollars, so tokens and
 * cost show as not reported.
 */

function toolKind(name: string): ToolKind {
  if (/bash|shell|powershell|exec/i.test(name)) return 'command';
  if (/edit|create|write|str_replace|apply_patch|insert/i.test(name)) return 'edit';
  if (/view|read/i.test(name)) return 'read';
  if (/grep|glob|search|ls|find|^rg$/i.test(name)) return 'search';
  if (/web|fetch|url/i.test(name)) return 'web';
  if (/todo|plan|report_intent/i.test(name)) return 'plan';
  if (/task|agent/i.test(name)) return 'agent';
  return 'other';
}

function targetOf(args: Record<string, any> | undefined, workspace: string): string | null {
  if (!args) return null;
  for (const k of ['path', 'file_path', 'filePath']) if (typeof args[k] === 'string') return relativize(args[k], workspace);
  for (const k of ['command', 'pattern', 'query', 'url', 'description', 'intent']) if (typeof args[k] === 'string') return args[k];
  return null;
}

export class CopilotParser implements EventParser {
  private model: string | null = null;
  private streamed = new Set<string>();
  private pending = new Map<string, { name: string; json: string; target: string | null }>();

  constructor(private workspace: string) {}

  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const o = tryJson(line);
    if (!o) {
      const text = line.trim();
      if (!text) return [];
      if (errorKind(text) === 'auth' && /log ?in|authenticat|token|sign in/i.test(text)) return [{ type: 'error', message: text, kind: 'auth' }];
      return [{ type: 'raw', text: line }];
    }
    try {
      return this.handle(o);
    } catch {
      return [{ type: 'raw', text: clip(line, 500) }];
    }
  }

  private handle(o: Record<string, any>): AgentEvent[] {
    const d = o.data ?? {};
    const out: AgentEvent[] = [];
    if (typeof d.model === 'string' && d.model !== this.model) {
      this.model = d.model;
      out.push({ type: 'init', model: d.model });
    }
    switch (o.type) {
      case 'assistant.turn_start':
        out.push({ type: 'turn' }, { type: 'thinking_active' });
        break;
      case 'assistant.tool_call_delta': {
        const id = String(d.toolCallId);
        let p = this.pending.get(id);
        if (!p) {
          p = { name: String(d.toolName ?? 'tool'), json: '', target: null };
          this.pending.set(id, p);
          out.push({ type: 'tool_start', id, kind: toolKind(p.name), name: p.name, target: null, pending: true });
        }
        if (p.target === null && p.json.length < 4000 && typeof d.inputDelta === 'string') {
          p.json += d.inputDelta;
          const m = p.json.match(/"(?:path|file_path|command|pattern|url|query)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) {
            let value = m[1]!;
            try {
              value = JSON.parse(`"${m[1]}"`);
            } catch {
              /* keep the raw text */
            }
            p.target = relativize(value, this.workspace);
            out.push({ type: 'tool_start', id, kind: toolKind(p.name), name: p.name, target: p.target, pending: true });
          }
        }
        break;
      }
      case 'tool.execution_start': {
        const name = String(d.toolName ?? 'tool');
        out.push({ type: 'tool_start', id: String(d.toolCallId), kind: toolKind(name), name, target: targetOf(d.arguments, this.workspace) });
        break;
      }
      case 'tool.execution_complete': {
        const exit = typeof d.shellExecution?.exitCode === 'number' ? d.shellExecution.exitCode : null;
        const text = typeof d.result?.content === 'string' ? d.result.content : typeof d.error?.message === 'string' ? d.error.message : '';
        out.push({ type: 'tool_end', id: String(d.toolCallId), ok: d.success !== false && (exit === null || exit === 0), exitCode: exit, output: clip(text) });
        break;
      }
      case 'assistant.message_delta':
        if (d.deltaContent) {
          this.streamed.add(String(d.messageId));
          out.push({ type: 'message', id: String(d.messageId), text: String(d.deltaContent), delta: true });
        }
        break;
      case 'assistant.reasoning_delta':
        if (d.deltaContent) out.push({ type: 'thinking', id: String(d.reasoningId ?? d.messageId ?? 'r'), text: String(d.deltaContent), delta: true });
        break;
      case 'assistant.reasoning':
        if (d.content) out.push({ type: 'thinking', id: String(d.reasoningId ?? d.messageId ?? 'r'), text: String(d.content) });
        break;
      case 'assistant.message':
        if (d.content && !this.streamed.has(String(d.messageId))) out.push({ type: 'message', id: String(d.messageId), text: String(d.content) });
        break;
      case 'session.error':
      case 'error': {
        const message = String(d.message ?? o.message ?? 'Error');
        out.push({ type: 'error', message, kind: errorKind(message) });
        break;
      }
      case 'result': {
        if (o.sessionId) out.push({ type: 'init', sessionId: String(o.sessionId) });
        const u = o.usage ?? {};
        if (typeof u.premiumRequests === 'number') {
          out.push({ type: 'system', text: `Copilot reports ${u.premiumRequests} premium request${u.premiumRequests === 1 ? '' : 's'} for this run. It does not report tokens or a dollar cost.` });
        }
        const ok = o.exitCode === 0;
        out.push({ type: 'result', ok, modelMs: typeof u.totalApiDurationMs === 'number' ? u.totalApiDurationMs : undefined, error: ok ? undefined : `Copilot exited with code ${o.exitCode}` });
        break;
      }
    }
    return out;
  }
}

function baseArgs(model: string, effort: string): string[] {
  const args = ['--output-format', 'json', '--allow-all', '--no-ask-user', '--no-color', '--disable-builtin-mcps', '--no-custom-instructions'];
  if (model) args.push('--model', model);
  if (effort) args.push('--reasoning-effort', effort);
  return args;
}

export const copilotAdapter: AgentAdapter = {
  id: 'copilot',
  name: 'Copilot CLI',
  vendor: 'GitHub',
  kind: 'builtin',
  color: '#8b5cf6',
  installCommand: 'npm install -g @github/copilot',
  docsUrl: 'https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli',
  models: [],
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  sandboxNote: 'All tools pre-approved inside the Agent Derby sandbox; its built-in GitHub tools are switched off.',
  managed: { npmPackage: '@github/copilot', bin: 'copilot' },
  writablePaths: () => [home('.copilot')],

  async detect() {
    const found = locate('copilot', 'AGENT_DERBY_COPILOT_BIN');
    if (!found) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
    const version = await readVersion(found.path);
    // Copilot CLI has no "am I signed in" command. It can use the GitHub CLI's login, so check for that.
    let auth: 'ok' | 'unknown' = 'unknown';
    let authDetail = 'Sign-in state cannot be checked; it will say so when it runs';
    if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
      auth = 'ok';
      authDetail = 'Using a GitHub token from the environment';
    } else {
      const gh = which('gh');
      if (gh && (await exec(gh, ['auth', 'token'], { timeoutMs: 10_000 })).code === 0) {
        auth = 'ok';
        authDetail = 'Signed in through the GitHub CLI';
      }
    }
    return { installed: true, version, path: found.path, origin: found.origin, auth, authDetail };
  },

  start(ctx) {
    return { command: ctx.exe, args: [...baseArgs(ctx.model, ctx.effort), '-p', ctx.prompt] };
  },

  resume(ctx) {
    return { command: ctx.exe, args: [...baseArgs(ctx.model, ctx.effort), `--resume=${ctx.sessionId}`, '-p', ctx.prompt] };
  },

  createParser(ctx) {
    return new CopilotParser(ctx.workspace);
  },

  login(exe) {
    return { command: exe, args: ['login'], hint: 'Sign in with the GitHub account that has Copilot.' };
  },
};
