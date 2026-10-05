import type { AgentKind, AuthState, TokenUsage, ToolKind } from '../../shared/types.js';

/**
 * Everything an agent CLI can tell us, normalised. Parsers turn one line of CLI
 * output into zero or more of these; the race engine and the metrics tracker
 * only ever see this shape.
 */
export type AgentEvent =
  /** The CLI announced its session. */
  | { type: 'init'; model?: string; sessionId?: string; cliVersion?: string }
  /** The model is thinking but the CLI does not expose the text. */
  | { type: 'thinking_active' }
  /** Reasoning text. With `delta`, append to the item with the same `id`. */
  | { type: 'thinking'; text: string; id?: string; delta?: boolean }
  /** Assistant text. With `delta`, append to the item with the same `id`. */
  | { type: 'message'; text: string; id?: string; delta?: boolean }
  /**
   * A tool call began. `pending` means the model is still writing the call
   * (shown in the lane, but not yet counted as tool time); a later tool_start
   * with the same id and no `pending` starts the clock and fills in the target.
   */
  | { type: 'tool_start'; id: string; kind: ToolKind; name: string; target: string | null; pending?: boolean }
  | { type: 'tool_end'; id: string; ok: boolean; output?: string; exitCode?: number | null }
  /** One model round-trip began. */
  | { type: 'turn' }
  /** Token usage. `total` replaces the running figures, `add` adds to them. Omitted fields are "not reported". */
  | { type: 'usage'; mode: 'total' | 'add'; usage: Partial<TokenUsage> }
  /** Cost as reported by the CLI itself (cumulative). */
  | { type: 'cost'; usd: number }
  | { type: 'error'; message: string; kind?: 'auth' | 'rate_limit' | 'other'; retry?: boolean }
  /** The CLI's own verdict on the run. */
  | { type: 'result'; ok: boolean; text?: string; turns?: number; modelMs?: number; error?: string }
  | { type: 'system'; text: string }
  /** A line we could not interpret; shown verbatim in the feed. */
  | { type: 'raw'; text: string };

export interface EventParser {
  /** Called once per complete line of output. Must never throw. */
  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[];
}

export interface Detection {
  installed: boolean;
  version: string | null;
  path: string | null;
  origin: 'path' | 'managed' | 'bundled' | 'custom' | null;
  auth: AuthState;
  authDetail: string | null;
}

export interface StartContext {
  /** Absolute path of the executable found by detect(). */
  exe: string;
  /** The full prompt. Identical, byte for byte, for every agent in a race. */
  prompt: string;
  /** The agent's private workspace; also the child's working directory. */
  workspace: string;
  /** '' = let the CLI pick its default. */
  model: string;
  options: Record<string, string>;
  costLimitUsd?: number;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
}

export interface UsageReport {
  usage?: Partial<TokenUsage>;
  costUsd?: number;
  model?: string;
}

/**
 * One agent CLI. Adding an agent means writing one file that exports one of
 * these and listing it in adapters/index.ts — see docs/WRITING_AN_ADAPTER.md.
 */
export interface AgentAdapter {
  id: string;
  name: string;
  vendor: string;
  kind: AgentKind;
  color: string;
  /** Command a user can run to install the CLI by hand. */
  installCommand: string | null;
  docsUrl: string | null;
  /** Suggested models; '' (CLI default) is added automatically. */
  models: string[];
  /** One line on how the agent is confined during a race. */
  sandboxNote: string | null;
  /** npm package that provides the official CLI, enabling one-click install. */
  managed?: { npmPackage: string; bin: string };
  /** True when the CLI confines itself (then Agent Derby does not wrap it in a second sandbox). */
  ownSandbox?: boolean;
  /** Paths outside the workspace the CLI must be able to write (its own state folder). */
  writablePaths?(): string[];

  /** Is the CLI installed, which version, and is it signed in? */
  detect(): Promise<Detection>;
  /** Command line for one non-interactive run with streaming output and auto-approval. */
  start(ctx: StartContext): SpawnSpec;
  /** A fresh parser for one run. */
  createParser(ctx: StartContext): EventParser;
  /** Optional custom stop; by default the engine signals the process group. */
  stop?(pid: number): void;
  /** Optional: usage the CLI only exposes out-of-band (session files, a usage subcommand). */
  readUsage?(ctx: StartContext & { sessionId: string | null }): Promise<UsageReport | null>;
  /** Command that runs the CLI's own interactive sign-in. */
  login?(exe: string): { command: string; args: string[]; env?: Record<string, string>; hint: string };
}

/** Shared helper: classify an error message. */
export function errorKind(message: string): 'auth' | 'rate_limit' | 'other' {
  if (
    /not logged in|please run \/login|\/login|invalid api key|401|unauthori[sz]ed|authentication|set an auth method|missing bearer|login required|credentials/i.test(
      message,
    )
  )
    return 'auth';
  if (/rate.?limit|429|quota|resource_exhausted|usage limit|overloaded/i.test(message)) return 'rate_limit';
  return 'other';
}

/** Shared helper: shorten long text for the feed. */
export function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.floor(max * 0.3))}\n… ${text.length - max} characters omitted …\n${text.slice(-Math.floor(max * 0.7))}`;
}

export function tryJson(line: string): Record<string, any> | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
