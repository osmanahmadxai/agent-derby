# Writing an adapter

An adapter teaches Agent Derby how to drive one agent CLI. It is one file that
exports one object. Everything else (workspaces, the sandbox, process control,
metrics, the UI) is shared, so an adapter is usually 100 to 200 lines.

If the CLI you want already speaks the Claude, Codex or Gemini streaming
format, or you only need its plain text output, you do not need code at all:
add it to `~/.agent-derby/agents.json` (see the README).

## The five jobs

`src/server/adapters/types.ts` defines `AgentAdapter`:

| Job | Member | What it does |
| --- | --- | --- |
| Detect | `detect()` | Is the CLI installed, which version, is it signed in? |
| Start | `start(ctx)` | Return the command line for one non-interactive run |
| Parse events | `createParser(ctx)` | Turn each line of output into normalised events |
| Stop | `stop(pid)` (optional) | Custom shutdown; by default the process group gets SIGINT, then SIGTERM, then SIGKILL |
| Read usage | `readUsage(ctx)` (optional) | Fetch usage the CLI only exposes after the run (a session file, a usage command) |

Optional extras: `login(exe)` for the Sign in button, `managed` for one-click
install from npm, `writablePaths()` for the CLI's own state folder (it must
stay writable inside the sandbox), and `ownSandbox: true` if the CLI confines
itself.

## 1. Find the right flags first

Do not trust memory, blog posts, or this document for flags. For the version
you have installed, run `--help` and read the current docs, and find:

- the non-interactive mode,
- streaming structured output (JSON lines),
- auto-approval of edits and commands,
- where token usage and cost are reported.

Write the flags and the version you checked them against in a comment at the
top of the adapter, as the built-in ones do.

## 2. A minimal adapter

```ts
// src/server/adapters/acme.ts
import { locate, readVersion, home } from './locate.js';
import { tryJson, errorKind, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

// Acme CLI. Flags verified against `acme --help` for 1.4.0:
//   run --json     non-interactive, JSON lines
//   --yes          approve everything
class AcmeParser implements EventParser {
  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const o = tryJson(line);
    if (!o) return line.trim() ? [{ type: 'raw', text: line }] : [];
    switch (o.type) {
      case 'start':
        return [{ type: 'init', model: o.model }];
      case 'text':
        return [{ type: 'message', text: o.text }];
      case 'tool_call':
        return [{ type: 'tool_start', id: o.id, kind: o.tool === 'shell' ? 'command' : 'edit', name: o.tool, target: o.path ?? o.command ?? null }];
      case 'tool_done':
        return [{ type: 'tool_end', id: o.id, ok: o.ok, exitCode: o.exit_code ?? null, output: o.output }];
      case 'done':
        return [
          { type: 'usage', mode: 'total', usage: { input: o.usage.input, output: o.usage.output } },
          { type: 'result', ok: o.ok, text: o.summary },
        ];
      case 'error':
        return [{ type: 'error', message: o.message, kind: errorKind(o.message) }];
      default:
        return [];
    }
  }
}

export const acmeAdapter: AgentAdapter = {
  id: 'acme',
  name: 'Acme CLI',
  vendor: 'Acme',
  kind: 'builtin',
  color: '#06b6d4',
  installCommand: 'npm install -g @acme/cli',
  docsUrl: 'https://example.com/acme-cli',
  models: [],
  sandboxNote: 'Auto-approve mode inside the Agent Derby sandbox.',
  managed: { npmPackage: '@acme/cli', bin: 'acme' },
  writablePaths: () => [home('.acme')],

  async detect() {
    const found = locate('acme', 'AGENT_DERBY_ACME_BIN');
    if (!found) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
    return { installed: true, version: await readVersion(found.path), path: found.path, origin: found.origin, auth: 'unknown', authDetail: null };
  },

  start(ctx) {
    const args = ['run', '--json', '--yes'];
    if (ctx.model) args.push('--model', ctx.model);
    return { command: ctx.exe, args, stdin: ctx.prompt };
  },

  createParser() {
    return new AcmeParser();
  },
};
```

Then add it to the `builtin` list in `src/server/adapters/index.ts`. That is
the whole integration.

## 3. The events

| Event | Meaning |
| --- | --- |
| `init` | Session started. Carries `model`, `cliVersion`, `sessionId` when known |
| `thinking_active` | The model is thinking but the CLI exposes no text |
| `thinking`, `message` | Reasoning and assistant text. With `delta: true` and an `id`, text is appended to the same feed item |
| `tool_start` | A tool call began. `kind` is one of `read`, `edit`, `command`, `search`, `web`, `plan`, `agent`, `other`. Send it with `pending: true` while the model is still writing the call, then again without `pending` when it actually runs |
| `tool_end` | It finished. `ok`, `exitCode`, `output` |
| `turn` | One model round-trip began |
| `usage` | Token counts. `mode: 'total'` replaces, `'add'` accumulates |
| `cost` | Cost in USD **as reported by the CLI** |
| `error` | `kind: 'auth'` makes the lane end with a "not signed in" explanation; `retry: true` counts as a retry |
| `result` | The CLI's own verdict: `ok`, final `text`, `turns` |
| `raw` | A line you could not interpret. It is shown verbatim, never dropped |

## 4. Rules that keep results honest

- **Never invent a number.** Leave a usage field out when the CLI does not
  report it; the UI will say "not reported". Do not emit `cost` unless the CLI
  printed a cost. Estimates come from the price table and are labelled.
- **Normalise tokens.** `input` means input that was *not* served from cache.
  If the CLI counts cached tokens inside its input figure (OpenAI's
  convention), subtract them and report them as `cacheRead`.
- **Pass the prompt through untouched.** Use `stdin` or a single argument.
  Never build a shell string around it. Every agent must receive the same bytes.
- **A parser must never throw.** Unknown lines become `raw` events.
- **Do not load the user's extras into an unattended run** when the CLI lets
  you avoid it (MCP servers, plugins with side effects).

## 5. Test it with recorded output

Record a real run and save it under `test/fixtures/`:

```bash
acme run --json --yes "create hello.txt, then run cat hello.txt and ls nope" > test/fixtures/acme.jsonl
```

Scrub paths and anything personal, then assert on what your parser produces,
the way `test/adapters.test.ts` does for the built-in adapters: tool calls and
their targets, the failed command's exit code, final usage, and that the
recorded "not signed in" output becomes an `auth` error.

Finally run a real race against the demo agents:

```bash
npm run build
node dist/cli.js run "build a playable snake game in the browser" --agents acme,mock-hare
```
