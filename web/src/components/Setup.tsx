import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { slugify, splitArgs } from '../format';
import { navigate, raceHash, recallSetup, rememberSetup, suiteHash } from '../router';
import { hub } from '../socket';
import type { AgentInfo, CustomAgentConfig, Entrant, RaceSetup, RepoCheck, SuiteRequest, SystemInfo } from '../types';
import { LoginModal } from './Terminal';
import { CopyButton, ErrorNote, Icon, Spinner, laneStyle } from './ui';

const EXAMPLES = [
  'Build a playable snake game in the browser',
  'Build a pomodoro timer web app',
  'Build a terminal todo app',
  'Build a markdown previewer',
];

const GREMLIN_ID = 'mock-gremlin';
const GREMLIN_SCENARIOS: { value: string; label: string }[] = [
  { value: 'crash', label: 'crash: exits with an error' },
  { value: 'hang', label: 'hang: never finishes' },
  { value: 'nothing', label: 'nothing: finishes without changing a file' },
  { value: 'auth', label: 'auth: is not signed in' },
];

const BASIC_SUPPORT_TOOLTIP =
  "Agent Derby shows this agent's output as text. Tool calls, tokens and cost may show as not reported.";

const ORIGIN_LABELS: Record<string, string> = {
  path: 'found on your PATH',
  managed: 'installed by Agent Derby',
  bundled: 'built in',
  custom: 'added by you',
};

interface Row {
  key: number;
  agentId: string;
  model: string;
  custom: boolean;
  scenario: string;
  /** '' = the CLI's default effort. */
  effort: string;
}

let rowKey = 1;
const newRow = (agentId: string, model = '', scenario = 'crash', effort = ''): Row => ({ key: rowKey++, agentId, model, custom: false, scenario, effort });

interface InstallState {
  running: boolean;
  lines: string[];
  ok?: boolean;
  error?: string;
}

function rowsFromSetup(setup: RaceSetup | null): Row[] {
  if (!setup || !Array.isArray(setup.entrants)) return [];
  return setup.entrants
    .filter((e) => e && typeof e.agentId === 'string')
    .map((e) => newRow(e.agentId, e.model ?? '', e.options?.scenario ?? 'crash', typeof e.effort === 'string' ? e.effort : ''));
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

interface CardProps {
  agent: AgentInfo;
  rows: Row[];
  install: InstallState | undefined;
  onToggle: (agent: AgentInfo) => void;
  onAddLane: (agent: AgentInfo) => void;
  onRemoveRow: (key: number) => void;
  onRowChange: (key: number, patch: Partial<Row>) => void;
  onInstall: (agent: AgentInfo) => void;
  onLogin: (agent: AgentInfo) => void;
  onDelete?: (agent: AgentInfo) => void;
}

function AgentCard({ agent, rows, install, onToggle, onAddLane, onRemoveRow, onRowChange, onInstall, onLogin, onDelete }: CardProps) {
  const selected = rows.length > 0;
  const models = useMemo(() => {
    const list = Array.isArray(agent.models) ? agent.models.slice() : [];
    if (!list.includes('')) list.unshift('');
    return list;
  }, [agent.models]);
  const efforts = Array.isArray(agent.efforts) ? agent.efforts.filter((e) => typeof e === 'string' && e !== '') : [];
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [install?.lines.length]);

  return (
    <article className={`agent${selected ? ' selected' : ''}${agent.installed ? '' : ' missing'}`} style={laneStyle(agent.color || '#7a86a8')}>
      <div className="agent-top">
        {agent.installed ? (
          <label className="agent-pick">
            <input type="checkbox" checked={selected} onChange={() => onToggle(agent)} />
            <span className="agent-swatch" aria-hidden="true" />
            <span className="agent-name">{agent.name}</span>
          </label>
        ) : (
          <div className="agent-pick">
            <span className="agent-swatch" aria-hidden="true" />
            <span className="agent-name">{agent.name}</span>
          </div>
        )}
        {agent.support === 'basic' && (
          <span className="tag support" title={BASIC_SUPPORT_TOOLTIP}>
            basic support
          </span>
        )}
        {onDelete && (
          <button type="button" className="btn ghost icon-only" onClick={() => onDelete(agent)} title={`Remove ${agent.name}`} aria-label={`Remove ${agent.name}`}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>

      <p className="agent-meta">
        {agent.vendor && <span>{agent.vendor}</span>}
        {agent.installed ? (
          <>
            {agent.version && <span>version {agent.version}</span>}
            {agent.origin && <span title={agent.path ?? undefined}>{ORIGIN_LABELS[agent.origin] ?? agent.origin}</span>}
          </>
        ) : (
          <span className="warn-text">not installed</span>
        )}
      </p>

      {agent.installed && agent.auth === 'missing' && (
        <div className="agent-auth">
          <span className="warn-text">
            <Icon name="alert" size={14} /> Not signed in{agent.authDetail && !/^not signed in$/i.test(agent.authDetail) ? `: ${agent.authDetail}` : ''}
          </span>
          {agent.canLogin ? (
            <button type="button" className="btn primary small" onClick={() => onLogin(agent)}>
              Sign in
            </button>
          ) : (
            <span className="muted small">Sign in with its own CLI in a terminal, then reload.</span>
          )}
        </div>
      )}
      {agent.installed && agent.auth === 'unknown' && agent.kind !== 'mock' && (
        <p className="muted small" title={agent.authDetail ?? undefined}>
          Sign-in state unknown: this CLI has no quick way to check.
          {agent.canLogin && (
            <>
              {' '}
              <button type="button" className="link" onClick={() => onLogin(agent)}>
                Sign in
              </button>
            </>
          )}
        </p>
      )}

      {!agent.installed && (
        <div className="agent-install">
          {agent.installCommand && (
            <div className="install-cmd">
              <code>{agent.installCommand}</code>
              <CopyButton text={agent.installCommand} label="Copy" className="btn small" />
            </div>
          )}
          {agent.canInstall && (
            <button type="button" className="btn primary small" onClick={() => onInstall(agent)} disabled={install?.running}>
              {install?.running ? (
                <>
                  <Spinner /> Installing…
                </>
              ) : install?.ok === false ? (
                'Try the install again'
              ) : (
                'Install'
              )}
            </button>
          )}
          {!agent.installCommand && !agent.canInstall && <p className="muted small">Install it yourself, then reload this page.</p>}
          {agent.docsUrl && (
            <a className="small" href={agent.docsUrl} target="_blank" rel="noreferrer">
              Install guide
            </a>
          )}
        </div>
      )}
      {install && (install.lines.length > 0 || install.error || install.ok !== undefined) && (
        <div className="install-log">
          {install.lines.length > 0 && <pre ref={logRef}>{install.lines.join('\n')}</pre>}
          {install.error && <ErrorNote>{install.error}</ErrorNote>}
          {install.ok === false && !install.error && <ErrorNote>The install did not succeed. The log above says why.</ErrorNote>}
          {install.ok === true && <p className="ok-text small">Installed.</p>}
        </div>
      )}

      {selected && (
        <div className="agent-lanes">
          {rows.map((row, i) => {
            const isCustom = row.custom || !models.includes(row.model);
            return (
              <div className="agent-lane" key={row.key}>
                {agent.kind !== 'mock' && (
                  <>
                    <select
                      aria-label={`Model for ${agent.name}${rows.length > 1 ? `, lane ${i + 1}` : ''}`}
                      value={isCustom ? '__custom' : row.model}
                      onChange={(ev) => {
                        const v = ev.target.value;
                        if (v === '__custom') onRowChange(row.key, { custom: true, model: '' });
                        else onRowChange(row.key, { custom: false, model: v });
                      }}
                    >
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m === '' ? 'Default model' : m}
                        </option>
                      ))}
                      <option value="__custom">Custom…</option>
                    </select>
                    {isCustom && (
                      <input
                        type="text"
                        className="mono"
                        aria-label="Custom model name"
                        placeholder="model name"
                        value={row.model}
                        onChange={(ev) => onRowChange(row.key, { custom: true, model: ev.target.value })}
                        spellCheck={false}
                      />
                    )}
                    {efforts.length > 0 && (
                      <select
                        className="effort"
                        aria-label={`Thinking effort for ${agent.name}${rows.length > 1 ? `, lane ${i + 1}` : ''}`}
                        title="How hard the model thinks. Default leaves it to the CLI."
                        value={efforts.includes(row.effort) ? row.effort : ''}
                        onChange={(ev) => onRowChange(row.key, { effort: ev.target.value })}
                      >
                        <option value="">Default effort</option>
                        {efforts.map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                )}
                {agent.id === GREMLIN_ID && (
                  <select aria-label="What goes wrong" value={row.scenario} onChange={(ev) => onRowChange(row.key, { scenario: ev.target.value })}>
                    {GREMLIN_SCENARIOS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                )}
                {agent.kind === 'mock' && agent.id !== GREMLIN_ID && <span className="muted small">Scripted demo run</span>}
                {rows.length > 1 && (
                  <button type="button" className="btn ghost icon-only" onClick={() => onRemoveRow(row.key)} title="Remove this lane" aria-label="Remove this lane">
                    <Icon name="x" size={14} />
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" className="link small" onClick={() => onAddLane(agent)} title="Race this agent against itself, for example with another model">
            <Icon name="plus" size={12} /> add another lane
          </button>
        </div>
      )}
      {agent.sandboxNote && selected && <p className="muted small">{agent.sandboxNote}</p>}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Custom agent form
// ---------------------------------------------------------------------------

function CustomAgentForm({ existingIds, onAdded }: { existingIds: string[]; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [promptVia, setPromptVia] = useState<CustomAgentConfig['promptVia']>('stdin');
  const [format, setFormat] = useState<CustomAgentConfig['format']>('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const argList = splitArgs(args);
  const needsPrompt = promptVia === 'arg' && !argList.some((a) => a.includes('{prompt}'));
  const valid = name.trim() !== '' && command.trim() !== '' && !needsPrompt;

  const submit = async () => {
    setBusy(true);
    setError(null);
    let id = `custom-${slugify(name)}`;
    let n = 2;
    while (existingIds.includes(id)) id = `custom-${slugify(name)}-${n++}`;
    try {
      await api.addCustomAgent({ id, name: name.trim(), command: command.trim(), args: argList, promptVia, format });
      setName('');
      setCommand('');
      setArgs('');
      onAdded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="custom-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (valid && !busy) submit();
      }}
    >
      <p className="muted">
        Any command-line agent can race if it takes a prompt and works on the files in the current folder. It runs in its own
        workspace like the others.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="My agent" />
        </label>
        <label className="field">
          <span>Command</span>
          <input type="text" className="mono" value={command} onChange={(ev) => setCommand(ev.target.value)} placeholder="aider" spellCheck={false} />
        </label>
        <label className="field span2">
          <span>Arguments, separated by spaces</span>
          <input
            type="text"
            className="mono"
            value={args}
            onChange={(ev) => setArgs(ev.target.value)}
            placeholder="--yes --model {model} --message {prompt}"
            spellCheck={false}
          />
          <small className="muted">
            Placeholders: <code>{'{prompt}'}</code> <code>{'{model}'}</code> <code>{'{workspace}'}</code>. Arguments are split on
            spaces, so one argument cannot contain a space.
          </small>
        </label>
        <label className="field">
          <span>The prompt is passed</span>
          <select value={promptVia} onChange={(ev) => setPromptVia(ev.target.value as CustomAgentConfig['promptVia'])}>
            <option value="stdin">on standard input</option>
            <option value="arg">as an argument ({'{prompt}'})</option>
          </select>
        </label>
        <label className="field">
          <span>Its output looks like</span>
          <select value={format} onChange={(ev) => setFormat(ev.target.value as CustomAgentConfig['format'])}>
            <option value="text">plain text</option>
            <option value="claude-stream-json">Claude Code stream-json</option>
            <option value="codex-json">Codex JSON</option>
            <option value="gemini-stream-json">Gemini stream-json</option>
          </select>
        </label>
      </div>
      {needsPrompt && <p className="warn-text small">Add {'{prompt}'} to the arguments, or pass the prompt on standard input.</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="submit" className="btn" disabled={!valid || busy}>
        {busy ? 'Adding…' : 'Add agent'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Setup page
// ---------------------------------------------------------------------------

export function Setup() {
  const prefill = useRef(recallSetup()).current;

  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [task, setTask] = useState(prefill?.task ?? '');
  const [rows, setRows] = useState<Row[]>(() => rowsFromSetup(prefill));
  const [sourceType, setSourceType] = useState<'empty' | 'repo'>(prefill?.source?.type === 'repo' ? 'repo' : 'empty');
  const [repoPath, setRepoPath] = useState(prefill?.source?.type === 'repo' ? prefill.source.path : '');
  const [repoCheck, setRepoCheck] = useState<RepoCheck | null>(null);
  const [repoChecking, setRepoChecking] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [finishCommand, setFinishCommand] = useState(prefill?.finishCommand ?? '');
  const [timeLimitMin, setTimeLimitMin] = useState(prefill?.timeLimitSec ? String(Math.round((prefill.timeLimitSec / 60) * 100) / 100) : '');
  const [costLimit, setCostLimit] = useState(prefill?.costLimitUsd ? String(prefill.costLimitUsd) : '');
  const [blind, setBlind] = useState(prefill?.blind === true);
  const [suiteOn, setSuiteOn] = useState(false);
  const [suiteName, setSuiteName] = useState('');
  /** Tasks 2, 3, … of a suite. Task 1 is `task`, so switching the suite on and off keeps what was typed. */
  const [moreTasks, setMoreTasks] = useState<string[]>(['']);

  const [installs, setInstalls] = useState<Record<string, InstallState>>({});
  const [loginAgent, setLoginAgent] = useState<AgentInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const list = await api.agents();
      setAgents(Array.isArray(list) ? list : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .system()
      .then((s) => alive && setSystem(s))
      .catch((err) => alive && setLoadError(errorText(err)));
    loadAgents();
    return () => {
      alive = false;
    };
  }, [loadAgents]);

  // Install progress and "agents changed" arrive on the main socket.
  useEffect(() => {
    hub.connect();
    return hub.onMessage((msg) => {
      if (msg.type === 'agents_changed') {
        loadAgents();
      } else if (msg.type === 'install') {
        setInstalls((cur) => {
          const prev = cur[msg.agentId] ?? { running: true, lines: [] };
          const lines = typeof msg.line === 'string' ? [...prev.lines, msg.line].slice(-300) : prev.lines;
          return { ...cur, [msg.agentId]: { ...prev, lines, running: msg.done ? false : prev.running, ok: msg.done ? !!msg.ok : prev.ok } };
        });
        if (msg.done) loadAgents();
      }
    });
  }, [loadAgents]);

  // A prefilled repo path is checked right away.
  useEffect(() => {
    if (sourceType === 'repo' && repoPath.trim()) void checkRepo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop lanes whose agent is gone or no longer installed (once the list is known).
  useEffect(() => {
    if (!agents) return;
    setRows((cur) => {
      const next = cur.filter((r) => agents.some((a) => a.id === r.agentId && a.installed));
      return next.length === cur.length ? cur : next;
    });
  }, [agents]);

  async function checkRepo(): Promise<RepoCheck | null> {
    const path = repoPath.trim();
    if (!path) {
      setRepoCheck(null);
      return null;
    }
    setRepoChecking(true);
    setRepoError(null);
    try {
      const res = await api.checkRepo(path);
      setRepoCheck(res);
      return res;
    } catch (err) {
      setRepoCheck(null);
      setRepoError(errorText(err));
      return null;
    } finally {
      setRepoChecking(false);
    }
  }

  const toggle = (agent: AgentInfo) =>
    setRows((cur) => (cur.some((r) => r.agentId === agent.id) ? cur.filter((r) => r.agentId !== agent.id) : [...cur, newRow(agent.id)]));
  const addLane = (agent: AgentInfo) => setRows((cur) => [...cur, newRow(agent.id)]);
  const removeRow = (key: number) => setRows((cur) => cur.filter((r) => r.key !== key));
  const changeRow = (key: number, patch: Partial<Row>) => setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const install = async (agent: AgentInfo) => {
    setInstalls((cur) => ({ ...cur, [agent.id]: { running: true, lines: [] } }));
    try {
      await api.installAgent(agent.id);
    } catch (err) {
      setInstalls((cur) => ({ ...cur, [agent.id]: { running: false, lines: cur[agent.id]?.lines ?? [], ok: false, error: errorText(err) } }));
    }
  };

  const removeCustom = async (agent: AgentInfo) => {
    if (!window.confirm(`Remove ${agent.name} from your agents?`)) return;
    setAgentError(null);
    try {
      await api.deleteCustomAgent(agent.id);
      await loadAgents();
    } catch (err) {
      setAgentError(errorText(err));
    }
  };

  const list = agents ?? [];
  const real = list.filter((a) => a.kind !== 'mock');
  const mocks = list.filter((a) => a.kind === 'mock');
  const byId = useMemo(() => new Map(list.map((a) => [a.id, a])), [list]);
  const liveRows = agents ? rows.filter((r) => byId.get(r.agentId)?.installed) : rows;
  const unsigned = liveRows.map((r) => byId.get(r.agentId)).filter((a): a is AgentInfo => !!a && a.auth === 'missing');

  const timeNum = timeLimitMin.trim() === '' ? null : Number(timeLimitMin);
  const costNum = costLimit.trim() === '' ? null : Number(costLimit);

  const suiteTasks = [task, ...moreTasks];
  const emptyTasks = suiteTasks.filter((t) => !t.trim()).length;

  let reason: string | null = null;
  if (system && system.git === null) reason = 'Git is required to run a race.';
  else if (suiteOn && emptyTasks > 0) reason = emptyTasks === 1 ? 'One task is still empty. Fill it in or remove it.' : `${emptyTasks} tasks are still empty. Fill them in or remove them.`;
  else if (!task.trim()) reason = 'Describe the task first.';
  else if (liveRows.length === 0) reason = 'Pick at least one agent.';
  else if (unsigned.length > 0) {
    const names = [...new Set(unsigned.map((a) => a.name))].join(' and ');
    reason = `${names} ${unsigned.length > 1 && names.includes(' and ') ? 'are' : 'is'} not signed in. Sign in on the card, or untick it.`;
  }
  else if (sourceType === 'repo' && !repoPath.trim()) reason = 'Enter the path of your git repository.';
  else if (sourceType === 'repo' && repoCheck && !repoCheck.ok) reason = 'That folder is not a usable git repository.';
  else if (timeNum !== null && (!Number.isFinite(timeNum) || timeNum <= 0)) reason = 'The time limit must be a number of minutes above zero.';
  else if (costNum !== null && (!Number.isFinite(costNum) || costNum <= 0)) reason = 'The cost limit must be an amount above zero.';

  const start = async () => {
    if (reason || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      let source: RaceSetup['source'] = { type: 'empty' };
      if (sourceType === 'repo') {
        const check = repoCheck && repoCheck.path && repoPath.trim() && repoCheck.ok ? repoCheck : await checkRepo();
        if (!check || !check.ok) {
          setStartError(check?.error || 'That folder is not a usable git repository.');
          return;
        }
        source = { type: 'repo', path: check.path || repoPath.trim() };
      }
      const entrants: Entrant[] = liveRows.map((r) => {
        const e: Entrant = { agentId: r.agentId };
        const agent = byId.get(r.agentId);
        if (agent?.kind !== 'mock' && r.model.trim()) e.model = r.model.trim();
        if (agent?.kind !== 'mock' && r.effort && Array.isArray(agent?.efforts) && agent.efforts.includes(r.effort)) e.effort = r.effort;
        if (r.agentId === GREMLIN_ID) e.options = { scenario: r.scenario };
        return e;
      });
      const setup: RaceSetup = { task: task.trim(), entrants, source };
      if (finishCommand.trim()) setup.finishCommand = finishCommand.trim();
      if (timeNum !== null) setup.timeLimitSec = Math.round(timeNum * 60);
      if (costNum !== null) setup.costLimitUsd = costNum;
      if (blind) setup.blind = true;
      rememberSetup(setup);
      if (suiteOn) {
        const { task: _first, ...rest } = setup;
        const body: SuiteRequest = { ...rest, tasks: suiteTasks.map((t) => t.trim()) };
        if (suiteName.trim()) body.name = suiteName.trim();
        const made = await api.startSuite(body);
        if (!made?.id) throw new Error('The server did not return a suite id.');
        navigate(suiteHash(made.id));
        return;
      }
      const res = await api.startRace(setup);
      if (!res?.id) throw new Error('The server did not return a race id.');
      navigate(raceHash(res.id));
    } catch (err) {
      setStartError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const cardProps = (agent: AgentInfo) => ({
    agent,
    rows: rows.filter((r) => r.agentId === agent.id),
    install: installs[agent.id],
    onToggle: toggle,
    onAddLane: addLane,
    onRemoveRow: removeRow,
    onRowChange: changeRow,
    onInstall: install,
    onLogin: setLoginAgent,
  });

  const laneCount = liveRows.length;

  return (
    <div className="page setup">
      {system && system.git === null && (
        <div className="blocker" role="alert">
          <h2>Git is required</h2>
          <p>
            Agent Derby gives every agent its own isolated copy of the project using git, and measures what each one changed with it.
            Install git from <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">git-scm.com</a>, then restart
            Agent Derby.
          </p>
        </div>
      )}

      <section className="setup-task">
        <h1>
          <label htmlFor="task">What should they build?</label>
        </h1>
        {suiteOn && (
          <p className="muted suite-intro">
            A suite runs these tasks one after another with the same agents, then adds the results up in one leaderboard.
          </p>
        )}
        <div className={suiteOn ? 'suite-task' : undefined}>
          {suiteOn && <span className="suite-task-num">1</span>}
          <textarea
            id="task"
            value={task}
            onChange={(ev) => setTask(ev.target.value)}
            placeholder="Describe the task. Every agent gets exactly these words."
            rows={suiteOn ? 2 : 4}
            autoFocus
            aria-label={suiteOn ? 'Task 1' : undefined}
            onKeyDown={(ev) => {
              if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') void start();
            }}
          />
        </div>
        {suiteOn &&
          moreTasks.map((t, i) => (
            <div className="suite-task" key={i}>
              <span className="suite-task-num">{i + 2}</span>
              <textarea
                value={t}
                onChange={(ev) => setMoreTasks((cur) => cur.map((x, j) => (j === i ? ev.target.value : x)))}
                placeholder="Describe another task."
                rows={2}
                aria-label={`Task ${i + 2}`}
                onKeyDown={(ev) => {
                  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') void start();
                }}
              />
              <button
                type="button"
                className="btn ghost icon-only"
                onClick={() => setMoreTasks((cur) => cur.filter((_, j) => j !== i))}
                disabled={moreTasks.length <= 1}
                title={moreTasks.length <= 1 ? 'A suite needs at least two tasks' : `Remove task ${i + 2}`}
                aria-label={`Remove task ${i + 2}`}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        {suiteOn && (
          <div className="suite-tools">
            <button type="button" className="btn small" onClick={() => setMoreTasks((cur) => [...cur, ''])}>
              <Icon name="plus" size={12} /> Add a task
            </button>
            <label className="field suite-name">
              <span>Suite name (optional)</span>
              <input type="text" value={suiteName} onChange={(ev) => setSuiteName(ev.target.value)} placeholder="Small web apps" />
            </label>
          </div>
        )}
        {!suiteOn && (
          <div className="chips">
            <span className="muted small">Or try one:</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => setTask(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        <label className="check suite-toggle">
          <input type="checkbox" checked={suiteOn} onChange={(ev) => setSuiteOn(ev.target.checked)} />
          <span>
            <strong>Run several tasks (suite)</strong>
          </span>
        </label>
      </section>

      <section>
        <div className="section-head">
          <h2>Who is racing?</h2>
          {laneCount > 0 && <span className="muted">{laneCount === 1 ? '1 lane' : `${laneCount} lanes`}</span>}
        </div>
        {loadError && (
          <div>
            <ErrorNote>{loadError}</ErrorNote>
            <button type="button" className="btn small" onClick={() => loadAgents()}>
              Try again
            </button>
          </div>
        )}
        {agentError && <ErrorNote>{agentError}</ErrorNote>}
        {!agents && !loadError && (
          <p className="loading">
            <Spinner /> Looking for agents on this computer…
          </p>
        )}
        {agents && real.length === 0 && mocks.length === 0 && <p className="muted">The server reported no agents.</p>}
        {real.length > 0 && (
          <div className="agent-grid">
            {real.map((a) => (
              <AgentCard key={a.id} {...cardProps(a)} onDelete={a.kind === 'custom' ? removeCustom : undefined} />
            ))}
          </div>
        )}

        <details className="fold">
          <summary>Add any other agent</summary>
          <CustomAgentForm existingIds={list.map((a) => a.id)} onAdded={loadAgents} />
        </details>

        {mocks.length > 0 && (
          <>
            <h3 className="group-title">
              Demo agents <span className="muted">no tokens spent</span>
            </h3>
            <p className="muted small">Scripted stand-ins that behave like real agents. Good for seeing how a race works before spending anything.</p>
            <div className="agent-grid">
              {mocks.map((a) => (
                <AgentCard key={a.id} {...cardProps(a)} />
              ))}
            </div>
          </>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Starting from</h2>
        </div>
        <div className="source-choice">
          <label className={`radio card${sourceType === 'empty' ? ' on' : ''}`}>
            <input type="radio" name="source" checked={sourceType === 'empty'} onChange={() => setSourceType('empty')} />
            <span>
              <strong>Empty project</strong>
              <span className="muted">Each agent starts in a new, empty folder.</span>
            </span>
          </label>
          <label className={`radio card${sourceType === 'repo' ? ' on' : ''}`}>
            <input type="radio" name="source" checked={sourceType === 'repo'} onChange={() => setSourceType('repo')} />
            <span>
              <strong>Existing git repo</strong>
              <span className="muted">Each agent gets its own copy of your latest commit.</span>
            </span>
          </label>
        </div>
        {sourceType === 'repo' && (
          <div className="repo">
            <label className="field">
              <span>Path of the repository on this computer</span>
              <input
                type="text"
                className="mono"
                value={repoPath}
                onChange={(ev) => {
                  setRepoPath(ev.target.value);
                  setRepoCheck(null);
                  setRepoError(null);
                }}
                onBlur={() => void checkRepo()}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') void checkRepo();
                }}
                placeholder="/Users/you/projects/my-app"
                spellCheck={false}
              />
            </label>
            {repoChecking && (
              <p className="muted small">
                <Spinner /> Checking…
              </p>
            )}
            {repoError && <ErrorNote>{repoError}</ErrorNote>}
            {repoCheck && !repoCheck.ok && <ErrorNote>{repoCheck.error || 'This folder is not a git repository.'}</ErrorNote>}
            {repoCheck && repoCheck.ok && (
              <p className="note ok">
                <Icon name="check" size={15} />
                <span>
                  Agents start from {repoCheck.branch ? <>branch <code>{repoCheck.branch}</code></> : 'a detached HEAD'}
                  {repoCheck.head ? (
                    <>
                      {' '}
                      at commit <code>{repoCheck.head.slice(0, 10)}</code>
                    </>
                  ) : null}
                  .
                </span>
              </p>
            )}
            {repoCheck && repoCheck.ok && repoCheck.dirty && (
              <p className="note warn">
                <Icon name="alert" size={15} />
                <span>
                  This repository has uncommitted changes. They are not included: agents start from the HEAD commit. Commit them
                  first if the agents should see them.
                </span>
              </p>
            )}
            <p className="muted small">
              Your working tree and your branches are never touched. Agents work in separate copies, on branches named{' '}
              <code>agent-derby/…</code>.
            </p>
          </div>
        )}
      </section>

      <section>
        <details className="fold" open={!!(prefill?.finishCommand || prefill?.timeLimitSec || prefill?.costLimitUsd || prefill?.blind) || undefined}>
          <summary>Options</summary>
          <div className="form-grid">
            <label className="field span2">
              <span>Finish command</span>
              <input
                type="text"
                className="mono"
                value={finishCommand}
                onChange={(ev) => setFinishCommand(ev.target.value)}
                placeholder="npm test"
                spellCheck={false}
              />
              <small className="muted">
                With this set, an agent only counts as finished if the command exits 0 in its workspace. Leave empty to count any
                clean exit.
              </small>
            </label>
            <label className="field">
              <span>Time limit per agent, minutes</span>
              <input type="number" min="0" step="any" inputMode="decimal" value={timeLimitMin} onChange={(ev) => setTimeLimitMin(ev.target.value)} placeholder="no limit" />
            </label>
            <label className="field">
              <span>Cost limit per agent, USD</span>
              <input type="number" min="0" step="any" inputMode="decimal" value={costLimit} onChange={(ev) => setCostLimit(ev.target.value)} placeholder="no limit" />
            </label>
            <label className="check span2">
              <input type="checkbox" checked={blind} onChange={(ev) => setBlind(ev.target.checked)} />
              <span>
                <strong>Blind race</strong>
                <span className="muted">Hides which agent is in which lane until you pick a winner.</span>
              </span>
            </label>
          </div>
        </details>
      </section>

      <div className="start-bar">
        <div className="start-info">
          {reason ? (
            <span className="start-reason">{reason}</span>
          ) : suiteOn ? (
            <span>
              {suiteTasks.length} tasks, one race each with {laneCount === 1 ? '1 lane' : `${laneCount} lanes`}, run one after another{' '}
              {sourceType === 'repo' ? 'from your repository' : 'from an empty project'}.{blind ? ' Blind.' : ''}
            </span>
          ) : laneCount === 1 ? (
            <span>One agent is a solo run. Pick two or more to make it a race.</span>
          ) : (
            <span>
              {laneCount} lanes, all given the identical prompt, starting {sourceType === 'repo' ? 'from your repository' : 'from an empty project'}.
              {blind ? ' Blind: agents stay hidden until you pick one.' : ''}
            </span>
          )}
          {startError && <ErrorNote>{startError}</ErrorNote>}
        </div>
        <button type="button" className="btn start" onClick={() => void start()} disabled={!!reason || starting} title={reason ?? undefined}>
          {starting ? 'Starting…' : suiteOn ? 'Start suite' : laneCount === 1 ? 'Start solo run' : 'Start race'}
        </button>
      </div>

      {system && (
        <p className="footnote muted small">
          Agent Derby {system.appVersion}. Races and workspaces are stored in <code className="break">{system.home}</code>.
          {system.pty === 'pipe' ? ' No pseudo-terminal is available here, so terminal previews and sign-in are limited.' : ''}
        </p>
      )}

      {loginAgent && (
        <LoginModal
          agent={loginAgent}
          onClose={() => {
            setLoginAgent(null);
            void loadAgents();
          }}
        />
      )}
    </div>
  );
}
