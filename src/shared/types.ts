/**
 * Types shared by the server, the web UI, the terminal UI and the desktop shell.
 * This file is the contract between them: it must not import anything.
 */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentKind = 'builtin' | 'mock' | 'custom';

/** `unknown` means the CLI offers no cheap way to ask. */
export type AuthState = 'ok' | 'missing' | 'unknown';

export interface AgentInfo {
  id: string;
  name: string;
  vendor: string;
  kind: AgentKind;
  /** CSS colour used for this agent's lane. */
  color: string;
  installed: boolean;
  version: string | null;
  /** Absolute path of the executable that will be run. */
  path: string | null;
  /** Where the executable came from. `managed` = installed by Agent Derby into its own folder. */
  origin: 'path' | 'managed' | 'bundled' | 'custom' | null;
  auth: AuthState;
  authDetail: string | null;
  /** Shell command a user can run to install the CLI themselves. */
  installCommand: string | null;
  /** True when Agent Derby can install the official CLI itself with one click. */
  canInstall: boolean;
  /** True when Agent Derby can open the CLI's own sign-in flow in an embedded terminal. */
  canLogin: boolean;
  /** Suggested model names. The first entry is always '' = "the CLI's default". */
  models: string[];
  docsUrl: string | null;
  /** Human-readable note about how this agent is confined while racing. */
  sandboxNote: string | null;
}

/** A user-defined agent, stored in `<home>/agents.json`. */
export interface CustomAgentConfig {
  id: string;
  name: string;
  /** Executable name or absolute path. */
  command: string;
  /**
   * Arguments. Placeholders: {prompt} {model} {workspace}.
   * An argument that is exactly "{model}" (and the argument before it, when it
   * starts with "-") is dropped when no model is chosen.
   */
  args: string[];
  /** How the prompt is delivered. With 'arg', use {prompt} in args. */
  promptVia: 'stdin' | 'arg';
  /** Output format, so an existing parser can be reused. */
  format: 'text' | 'claude-stream-json' | 'codex-json' | 'gemini-stream-json';
  versionArgs?: string[];
  installCommand?: string;
  models?: string[];
  color?: string;
}

// ---------------------------------------------------------------------------
// Race setup
// ---------------------------------------------------------------------------

export interface Entrant {
  agentId: string;
  /** '' or undefined = the CLI's default model. */
  model?: string;
  /** Adapter-specific options (the mock agents use `scenario`). */
  options?: Record<string, string>;
}

export type RaceSource = { type: 'empty' } | { type: 'repo'; path: string };

export interface RaceSetup {
  task: string;
  entrants: Entrant[];
  source: RaceSource;
  /** When set, a lane only finishes successfully if this passes in its workspace. */
  finishCommand?: string;
  timeLimitSec?: number;
  costLimitUsd?: number;
}

export interface RepoCheck {
  ok: boolean;
  path: string;
  branch: string | null;
  head: string | null;
  /** Uncommitted changes exist; they are NOT part of the race (it starts from HEAD). */
  dirty: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export type LaneState =
  | 'pending'
  | 'running'
  /** Agent exited; the finish command is running. */
  | 'verifying'
  | 'finished'
  | 'failed'
  | 'stopped'
  | 'timed_out'
  | 'over_budget';

export const TERMINAL_STATES: LaneState[] = ['finished', 'failed', 'stopped', 'timed_out', 'over_budget'];

export type ToolKind = 'read' | 'edit' | 'command' | 'search' | 'web' | 'plan' | 'agent' | 'other';

export const TOOL_KINDS: ToolKind[] = ['read', 'edit', 'command', 'search', 'web', 'plan', 'agent', 'other'];

export type NowKind =
  | 'waiting'
  | 'starting'
  | 'thinking'
  | 'writing'
  | 'reading'
  | 'editing'
  | 'running'
  | 'searching'
  | 'browsing'
  | 'planning'
  | 'delegating'
  | 'tool'
  | 'verifying'
  | 'done';

export interface NowStatus {
  kind: NowKind;
  /** Plain words, e.g. "Editing src/game.js". */
  text: string;
}

export type FeedType = 'system' | 'thinking' | 'message' | 'tool' | 'error' | 'raw';

export interface FeedTool {
  kind: ToolKind;
  /** The CLI's own tool name, e.g. "Bash" or "run_shell_command". */
  name: string;
  /** File path, command line, query or URL. */
  target: string | null;
  status: 'running' | 'ok' | 'failed';
  durationMs: number | null;
  exitCode: number | null;
  /** Tail of the tool output, truncated. */
  output: string | null;
}

/** One entry in a lane's activity feed. Items are upserted by `seq`. */
export interface FeedItem {
  seq: number;
  /** Milliseconds since the lane started. */
  t: number;
  type: FeedType;
  text: string;
  tool?: FeedTool;
  /** True while streamed text is still growing. */
  streaming?: boolean;
}

/** null always means "not reported" — never zero, never a guess. */
export type Maybe<T> = T | null;

export interface TokenUsage {
  /** Input tokens that were NOT served from cache. */
  input: Maybe<number>;
  output: Maybe<number>;
  cacheRead: Maybe<number>;
  cacheWrite: Maybe<number>;
  /** Reasoning/thinking tokens; a subset of `output` when reported. */
  reasoning: Maybe<number>;
}

export interface CodeStats {
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  linesAdded: number;
  linesRemoved: number;
  /** e.g. ["npm: express", "pip: flask"] */
  newDependencies: string[];
}

export type FinishOutcome = 'not_set' | 'not_run' | 'passed' | 'failed';
export type BuildOutcome = 'not_run' | 'no_build_script' | 'passed' | 'failed';
export type PreviewOutcome = 'not_run' | 'pending' | 'started' | 'failed';

export interface LaneMetrics {
  time: {
    /** Agent process start to exit. Live while running. */
    wallMs: number;
    firstEditMs: Maybe<number>;
    /** Time waiting on the model. */
    modelMs: Maybe<number>;
    /** `reported` = the CLI said so; `derived` = wall time minus tool time, from event timestamps. */
    modelMsSource: Maybe<'reported' | 'derived'>;
    /** Time spent inside shell commands, from event timestamps. */
    commandMs: Maybe<number>;
    /** Time spent inside all tools, from event timestamps. */
    toolMs: Maybe<number>;
  };
  tokens: TokenUsage;
  cost: {
    usd: Maybe<number>;
    /** `estimated` = computed from config/pricing.json, never shown as a measurement. */
    source: Maybe<'reported' | 'estimated'>;
  };
  activity: {
    turns: Maybe<number>;
    toolCalls: number;
    byKind: Record<ToolKind, number>;
    commands: number;
    commandsFailed: number;
    errors: number;
    retries: number;
  };
  /** Files with uncommitted or committed changes vs the starting point, polled from git while running. */
  filesChangedLive: number;
  /** Final diff statistics; null until the lane ends. */
  code: Maybe<CodeStats>;
  outcome: {
    finish: FinishOutcome;
    finishExitCode: Maybe<number>;
    tests: Maybe<{ passed: number; failed: number; total: number }>;
    build: BuildOutcome;
    preview: PreviewOutcome;
  };
  /** The model the CLI reported using. */
  model: Maybe<string>;
  cliVersion: Maybe<string>;
}

export type PreviewType = 'web' | 'static' | 'terminal' | 'other';

export type PreviewStatus = 'none' | 'installing' | 'building' | 'starting' | 'ready' | 'failed' | 'stopped';

export interface PreviewInfo {
  status: PreviewStatus;
  type: PreviewType | null;
  /** How the run instructions were found. */
  source: 'manifest' | 'detected' | 'manual' | null;
  /** For web/static: the URL to embed. */
  url: string | null;
  port: number | null;
  installCommand: string | null;
  startCommand: string | null;
  /** Why the manifest could not be used, when detection took over. */
  manifestProblem: string | null;
  error: string | null;
  /** Notes worth showing, e.g. "ignored PORT, found on 5173". */
  note: string | null;
}

export interface KeptInfo {
  mode: 'branch' | 'folder';
  target: string;
  at: number;
}

export interface Lane {
  id: string;
  agentId: string;
  agentName: string;
  kind: AgentKind;
  color: string;
  /** Model requested in setup, '' = CLI default. */
  requestedModel: string;
  state: LaneState;
  /** Plain-words reason for a non-success end state. */
  stateReason: string | null;
  /** Epoch ms. */
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  now: NowStatus;
  metrics: LaneMetrics;
  preview: PreviewInfo;
  workspace: string;
  branch: string | null;
  /** The exact command line that was run (prompt elided), for reproducibility. */
  commandLine: string | null;
  finalMessage: string | null;
  kept: KeptInfo | null;
  feedCount: number;
}

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

export type RaceState = 'preparing' | 'running' | 'finished' | 'interrupted';

export interface Race {
  id: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  state: RaceState;
  setup: RaceSetup;
  /** The exact text every agent received. */
  prompt: string;
  promptSha256: string;
  /** Commit every workspace started from. */
  baseRef: string | null;
  lanes: Lane[];
  /** Set when the race could not be prepared at all. */
  error: string | null;
  appVersion: string;
}

export interface RaceSummary {
  id: string;
  createdAt: number;
  state: RaceState;
  task: string;
  source: RaceSource;
  lanes: { id: string; agentName: string; color: string; state: LaneState; wallMs: number; model: string | null }[];
  winner: string | null;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
  /** Unified diff for this file; empty when binary or too large. */
  patch: string;
  truncated: boolean;
}

export interface LaneDiff {
  files: DiffFile[];
  /** True when some files were left out because the diff is very large. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface SystemInfo {
  appVersion: string;
  platform: string;
  /** null = git was not found; races cannot run without it. */
  git: string | null;
  node: string;
  /** Data folder (races, workspaces, managed CLIs). */
  home: string;
  /** True when an interactive pseudo-terminal is available for terminal previews and sign-in. */
  pty: 'node-pty' | 'script' | 'pipe';
  desktop: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket protocol: /ws
// ---------------------------------------------------------------------------

export type ClientMessage = { type: 'subscribe'; raceId: string } | { type: 'unsubscribe'; raceId: string };

export type ServerMessage =
  /** Full snapshot, sent on subscribe. */
  | { type: 'race'; race: Race }
  | { type: 'race_patch'; raceId: string; patch: Partial<Race> }
  /** Shallow patch of one lane. */
  | { type: 'lane'; raceId: string; laneId: string; patch: Partial<Lane> }
  /** New or updated feed items; upsert by seq. */
  | { type: 'feed'; raceId: string; laneId: string; items: FeedItem[] }
  /** Progress of a one-click CLI install. */
  | { type: 'install'; agentId: string; line?: string; done?: boolean; ok?: boolean }
  /** Agent list changed (install/login finished); refetch /api/agents. */
  | { type: 'agents_changed' };

// ---------------------------------------------------------------------------
// WebSocket protocol: /ws/term  (?raceId=&laneId=  or  ?login=<agentId>)
// ---------------------------------------------------------------------------

export type TermClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'restart' };

export type TermServerMessage =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'started'; command: string };

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export interface KeepRequest {
  mode: 'branch' | 'folder';
  /** Branch name, or absolute folder path. */
  target: string;
}

export interface ManualPreviewRequest {
  /** When omitted, the automatic flow (manifest, then detection) is retried. */
  command?: string;
  type?: PreviewType;
}

export interface ApiError {
  error: string;
}

/** Helper used on both sides. */
export function emptyMetrics(): LaneMetrics {
  return {
    time: { wallMs: 0, firstEditMs: null, modelMs: null, modelMsSource: null, commandMs: null, toolMs: null },
    tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
    cost: { usd: null, source: null },
    activity: {
      turns: null,
      toolCalls: 0,
      byKind: { read: 0, edit: 0, command: 0, search: 0, web: 0, plan: 0, agent: 0, other: 0 },
      commands: 0,
      commandsFailed: 0,
      errors: 0,
      retries: 0,
    },
    filesChangedLive: 0,
    code: null,
    outcome: { finish: 'not_set', finishExitCode: null, tests: null, build: 'not_run', preview: 'not_run' },
    model: null,
    cliVersion: null,
  };
}

export function emptyPreview(): PreviewInfo {
  return {
    status: 'none',
    type: null,
    source: null,
    url: null,
    port: null,
    installCommand: null,
    startCommand: null,
    manifestProblem: null,
    error: null,
    note: null,
  };
}

export function isTerminal(state: LaneState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function totalTokens(t: TokenUsage): Maybe<number> {
  const parts = [t.input, t.output, t.cacheRead, t.cacheWrite];
  if (parts.every((p) => p === null)) return null;
  return parts.reduce<number>((a, b) => a + (b ?? 0), 0);
}

/**
 * Podium order: successful finishes first, then by time.
 * Lanes that did not finish keep their relative order by how long they ran.
 */
export function rankLanes(lanes: Lane[]): Lane[] {
  return [...lanes].sort((a, b) => {
    const af = a.state === 'finished' ? 0 : 1;
    const bf = b.state === 'finished' ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.metrics.time.wallMs - b.metrics.time.wallMs;
  });
}
