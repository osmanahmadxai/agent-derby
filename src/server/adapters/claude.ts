import type { ToolKind } from '../../shared/types.js';
import { exec } from '../proc.js';
import { home, locate, newestDirs, readVersion } from './locate.js';
import { clip, errorKind, tryJson, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

/**
 * Claude Code. Flags verified against `claude --help` for 2.1.288:
 *   -p                               non-interactive
 *   --output-format stream-json      streaming JSON events (requires --verbose with -p)
 *   --include-partial-messages       token-level deltas, so text appears as it is written
 *   --permission-mode bypassPermissions   edits and commands pre-approved
 *   --strict-mcp-config              do not load the user's MCP servers into an unattended run
 *   --max-budget-usd                 native cost limit
 * Usage and cost arrive in the final `result` event (usage, modelUsage, total_cost_usd).
 */

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  KillBash: 'command',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  ToolSearch: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  TodoWrite: 'plan',
  ExitPlanMode: 'plan',
  Task: 'agent',
  Agent: 'agent',
};

export function claudeToolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other';
}

function toolTarget(name: string, input: Record<string, any> | undefined, workspace: string): string | null {
  if (!input) return null;
  const rel = (p: unknown) => (typeof p === 'string' ? relativize(p, workspace) : null);
  if (input.file_path) return rel(input.file_path);
  if (input.notebook_path) return rel(input.notebook_path);
  if (typeof input.command === 'string') return input.command;
  if (typeof input.pattern === 'string') return input.path ? `${input.pattern} in ${rel(input.path)}` : input.pattern;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.description === 'string') return input.description;
  if (typeof input.path === 'string') return rel(input.path);
  if (Array.isArray(input.todos)) {
    const done = input.todos.filter((t: any) => t?.status === 'completed').length;
    return `${done}/${input.todos.length} steps done`;
  }
  return null;
}

export function relativize(p: string, workspace: string): string {
  for (const root of [workspace, `/private${workspace}`, workspace.replace(/^\/private/, '')]) {
    if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
    if (p === root) return '.';
  }
  return p;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : ''))
      .join('\n');
  }
  return '';
}

interface MsgUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
}

export class ClaudeParser implements EventParser {
  private currentMsgId: string | null = null;
  private seenMsgIds = new Set<string>();
  /** Message ids whose text we already streamed as deltas. */
  private streamedText = new Set<string>();
  private streamedThinking = new Set<string>();
  private blockTypes = new Map<number, string>();
  private pendingTools = new Set<string>();
  /** Tool calls being streamed: content-block index -> what we know so far. */
  private streamingTools = new Map<number, { id: string; name: string; json: string; target: string | null }>();
  private usageByMsg = new Map<string, MsgUsage>();

  constructor(private workspace: string) {}

  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const o = tryJson(line);
    if (!o) {
      if (!line.trim()) return [];
      if (stream === 'stderr' && errorKind(line) === 'auth') return [{ type: 'error', message: line.trim(), kind: 'auth' }];
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
      case 'system':
        if (o.subtype === 'init') {
          return [{ type: 'init', model: o.model, sessionId: o.session_id, cliVersion: o.claude_code_version }];
        }
        if (o.subtype === 'status' && o.status === 'requesting') return [{ type: 'thinking_active' }];
        if (o.subtype === 'thinking_tokens') return [{ type: 'thinking_active' }];
        if (o.subtype === 'api_retry' || o.subtype === 'api_error') {
          return [{ type: 'error', message: String(o.error ?? o.message ?? 'API error, retrying'), retry: true, kind: 'other' }];
        }
        if (o.subtype === 'compact_boundary') return [{ type: 'system', text: 'Context compacted' }];
        return [];
      case 'rate_limit_event': {
        const info = o.rate_limit_info;
        if (info && info.status && info.status !== 'allowed' && info.status !== 'allowed_warning') {
          return [{ type: 'error', message: `Rate limit: ${info.status} (${info.rateLimitType ?? 'limit'})`, kind: 'rate_limit' }];
        }
        return [];
      }
      case 'stream_event':
        return this.streamEvent(o);
      case 'assistant':
        return this.assistant(o);
      case 'user':
        return this.user(o);
      case 'result':
        return this.result(o);
      default:
        return [];
    }
  }

  private noteMessage(id: string | undefined, out: AgentEvent[]): void {
    if (!id) return;
    this.currentMsgId = id;
    if (!this.seenMsgIds.has(id)) {
      this.seenMsgIds.add(id);
      out.push({ type: 'turn' });
    }
  }

  private noteUsage(id: string | null, u: Record<string, any> | undefined, out: AgentEvent[]): void {
    if (!id || !u) return;
    const prev = this.usageByMsg.get(id);
    const next: MsgUsage = {
      input: u.input_tokens ?? prev?.input ?? 0,
      output: Math.max(u.output_tokens ?? 0, prev?.output ?? 0),
      cacheRead: u.cache_read_input_tokens ?? prev?.cacheRead ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? prev?.cacheWrite ?? 0,
      reasoning: u.output_tokens_details?.thinking_tokens ?? prev?.reasoning ?? null,
    };
    this.usageByMsg.set(id, next);
    let input = 0,
      output = 0,
      cacheRead = 0,
      cacheWrite = 0,
      reasoning: number | null = null;
    for (const m of this.usageByMsg.values()) {
      input += m.input;
      output += m.output;
      cacheRead += m.cacheRead;
      cacheWrite += m.cacheWrite;
      if (m.reasoning !== null) reasoning = (reasoning ?? 0) + m.reasoning;
    }
    out.push({
      type: 'usage',
      mode: 'total',
      usage: { input, output, cacheRead, cacheWrite, ...(reasoning !== null ? { reasoning } : {}) },
    });
  }

  private streamEvent(o: Record<string, any>): AgentEvent[] {
    // Sub-agent streams interleave with the main one; only the main stream drives the lane.
    if (o.parent_tool_use_id) return [];
    const ev = o.event ?? {};
    const out: AgentEvent[] = [];
    switch (ev.type) {
      case 'message_start':
        this.blockTypes.clear();
        this.streamingTools.clear();
        this.noteMessage(ev.message?.id, out);
        this.noteUsage(this.currentMsgId, ev.message?.usage, out);
        break;
      case 'content_block_start': {
        const b = ev.content_block ?? {};
        this.blockTypes.set(ev.index, b.type);
        if (b.type === 'thinking') out.push({ type: 'thinking_active' });
        if (b.type === 'tool_use' && b.id) {
          this.pendingTools.add(b.id);
          this.streamingTools.set(ev.index, { id: b.id, name: b.name, json: '', target: null });
          out.push({ type: 'tool_start', id: b.id, kind: claudeToolKind(b.name), name: b.name, target: null, pending: true });
        }
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta ?? {};
        const id = `${this.currentMsgId ?? 'msg'}:${ev.index}`;
        if (d.type === 'text_delta' && d.text) {
          if (this.currentMsgId) this.streamedText.add(this.currentMsgId);
          out.push({ type: 'message', id, text: d.text, delta: true });
        } else if (d.type === 'thinking_delta') {
          if (d.thinking) {
            if (this.currentMsgId) this.streamedThinking.add(this.currentMsgId);
            out.push({ type: 'thinking', id, text: d.thinking, delta: true });
          } else out.push({ type: 'thinking_active' });
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          // A large Write can take a minute to stream; name the file as soon as it is known.
          const tool = this.streamingTools.get(ev.index);
          if (tool && tool.target === null && tool.json.length < 4000) {
            tool.json += d.partial_json;
            const m = tool.json.match(/"(?:file_path|notebook_path|command|pattern|url|query)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) {
              let value = m[1]!;
              try {
                value = JSON.parse(`"${m[1]}"`);
              } catch {
                /* keep the raw text */
              }
              tool.target = relativize(value, this.workspace);
              out.push({ type: 'tool_start', id: tool.id, kind: claudeToolKind(tool.name), name: tool.name, target: tool.target, pending: true });
            }
          }
        }
        break;
      }
      case 'message_delta':
        this.noteUsage(this.currentMsgId, ev.usage, out);
        break;
    }
    return out;
  }

  private assistant(o: Record<string, any>): AgentEvent[] {
    const msg = o.message ?? {};
    const out: AgentEvent[] = [];
    const sub = Boolean(o.parent_tool_use_id);
    if (!sub) {
      this.noteMessage(msg.id, out);
      this.noteUsage(msg.id ?? null, msg.usage, out);
    }
    if (o.error) out.push({ type: 'error', message: String(o.error), kind: errorKind(String(o.error)) });
    for (const block of msg.content ?? []) {
      if (block.type === 'text' && block.text) {
        if (sub) continue;
        if (!this.streamedText.has(msg.id)) out.push({ type: 'message', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        if (sub) continue;
        if (!this.streamedThinking.has(msg.id)) out.push({ type: 'thinking', text: block.thinking });
      } else if (block.type === 'tool_use' && block.id) {
        this.pendingTools.delete(block.id);
        out.push({
          type: 'tool_start',
          id: block.id,
          kind: claudeToolKind(block.name),
          name: block.name,
          target: toolTarget(block.name, block.input, this.workspace),
        });
      }
    }
    return out;
  }

  private user(o: Record<string, any>): AgentEvent[] {
    const out: AgentEvent[] = [];
    const content = o.message?.content;
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      const text = resultText(block.content);
      const exit = text.match(/^(?:Error: )?Exit code (\d+)/);
      out.push({
        type: 'tool_end',
        id: block.tool_use_id,
        ok: !block.is_error,
        output: clip(text),
        exitCode: exit ? Number(exit[1]) : block.is_error ? null : 0,
      });
    }
    return out;
  }

  private result(o: Record<string, any>): AgentEvent[] {
    const out: AgentEvent[] = [];
    // modelUsage covers every model call of the session (including helper calls), and is what the cost is based on.
    const models = o.modelUsage && typeof o.modelUsage === 'object' ? Object.values<any>(o.modelUsage) : [];
    if (models.length) {
      const sum = (k: string) => models.reduce((a, m) => a + (Number(m?.[k]) || 0), 0);
      const hasThinking = models.some((m) => typeof m?.thinkingTokens === 'number');
      out.push({
        type: 'usage',
        mode: 'total',
        usage: {
          input: sum('inputTokens'),
          output: sum('outputTokens'),
          cacheRead: sum('cacheReadInputTokens'),
          cacheWrite: sum('cacheCreationInputTokens'),
          ...(hasThinking ? { reasoning: sum('thinkingTokens') } : {}),
        },
      });
    } else if (o.usage) {
      out.push({
        type: 'usage',
        mode: 'total',
        usage: {
          input: o.usage.input_tokens,
          output: o.usage.output_tokens,
          cacheRead: o.usage.cache_read_input_tokens,
          cacheWrite: o.usage.cache_creation_input_tokens,
          ...(typeof o.usage.output_tokens_details?.thinking_tokens === 'number'
            ? { reasoning: o.usage.output_tokens_details.thinking_tokens }
            : {}),
        },
      });
    }
    if (typeof o.total_cost_usd === 'number') out.push({ type: 'cost', usd: o.total_cost_usd });
    const ok = !o.is_error && o.subtype === 'success';
    const text = typeof o.result === 'string' ? o.result : undefined;
    let error: string | undefined;
    if (!ok) {
      error =
        o.subtype === 'error_max_budget_usd'
          ? 'Cost limit reached'
          : o.subtype === 'error_max_turns'
            ? 'Turn limit reached'
            : text || (Array.isArray(o.errors) ? o.errors.join('; ') : '') || String(o.subtype ?? 'error');
      out.push({ type: 'error', message: error, kind: errorKind(error) });
    }
    out.push({
      type: 'result',
      ok,
      text: ok ? text : undefined,
      turns: typeof o.num_turns === 'number' ? o.num_turns : undefined,
      modelMs: typeof o.duration_api_ms === 'number' ? o.duration_api_ms : undefined,
      error,
    });
    return out;
  }
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',
  vendor: 'Anthropic',
  kind: 'builtin',
  color: '#d97757',
  installCommand: 'npm install -g @anthropic-ai/claude-code',
  docsUrl: 'https://code.claude.com/docs',
  models: ['fable', 'opus', 'sonnet', 'haiku'],
  sandboxNote: 'Permissions bypassed inside the Agent Derby sandbox; your MCP servers are not loaded.',
  writablePaths: () => claudeWritable(),
  managed: { npmPackage: '@anthropic-ai/claude-code', bin: 'claude' },

  async detect() {
    const found = locate('claude', 'AGENT_DERBY_CLAUDE_BIN', () => [
      home('.claude', 'local', 'claude'),
      home('.local', 'bin', 'claude'),
      // The VS Code / Cursor extension ships the same native binary.
      ...['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].flatMap((d) =>
        newestDirs(home(d, 'extensions'), /^anthropic\.claude-code-/).map(
          (dir) => `${dir}/resources/native-binary/claude${process.platform === 'win32' ? '.exe' : ''}`,
        ),
      ),
    ]);
    if (!found) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
    const [version, status] = await Promise.all([
      readVersion(found.path),
      exec(found.path, ['auth', 'status', '--json'], { timeoutMs: 20_000 }),
    ]);
    const info = tryJson(status.stdout);
    let auth: 'ok' | 'missing' | 'unknown' = 'unknown';
    let authDetail: string | null = null;
    if (info && typeof info.loggedIn === 'boolean') {
      auth = info.loggedIn ? 'ok' : 'missing';
      // Deliberately no e-mail or organisation name: this ends up in screenshots.
      authDetail = info.loggedIn
        ? info.subscriptionType
          ? `Signed in (${info.subscriptionType} plan)`
          : `Signed in (${info.authMethod ?? 'account'})`
        : 'Not signed in';
    } else if (process.env.ANTHROPIC_API_KEY) {
      auth = 'ok';
      authDetail = 'Using ANTHROPIC_API_KEY from the environment';
    }
    return { installed: true, version, path: found.path, origin: found.origin, auth, authDetail };
  },

  start(ctx) {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'bypassPermissions',
      '--strict-mcp-config',
    ];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.costLimitUsd) args.push('--max-budget-usd', String(ctx.costLimitUsd));
    return { command: ctx.exe, args, stdin: ctx.prompt };
  },

  createParser(ctx) {
    return new ClaudeParser(ctx.workspace);
  },

  login(exe) {
    return { command: exe, args: ['auth', 'login'], hint: 'Sign in with your Claude subscription in the browser window that opens.' };
  },
};

/** Paths Claude Code must be able to write to keep its session state. */
function claudeWritable() {
  return [home('.claude'), home('.claude.json')];
}
