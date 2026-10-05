import fs from 'node:fs';
import { readJson } from '../paths.js';
import { ClaudeParser } from './claude.js';
import { home, locate, readVersion } from './locate.js';
import type { AgentAdapter } from './types.js';

/**
 * Qwen Code. Flags verified against `qwen --help` for 0.24.7:
 *   <prompt>                 positional prompt, non-interactive when stdout is piped
 *   -o stream-json           streaming JSON events
 *   --approval-mode yolo     all actions pre-approved
 *   -m <model>
 * Its stream-json uses the same message shapes as Claude Code (confirmed on the
 * recorded "no auth type selected" result), so the Claude parser is reused.
 * A successful signed-in run has not been recorded yet.
 */

function authSelected(): string | null {
  const s = readJson<any>(home('.qwen', 'settings.json'), {});
  return s?.security?.auth?.selectedType ?? s?.selectedAuthType ?? null;
}

export const qwenAdapter: AgentAdapter = {
  id: 'qwen',
  name: 'Qwen Code',
  vendor: 'Alibaba',
  kind: 'builtin',
  color: '#615ced',
  installCommand: 'npm install -g @qwen-code/qwen-code',
  docsUrl: 'https://github.com/QwenLM/qwen-code',
  models: [],
  sandboxNote: 'YOLO approval mode inside the Agent Derby sandbox.',
  managed: { npmPackage: '@qwen-code/qwen-code', bin: 'qwen' },
  writablePaths: () => [home('.qwen')],

  async detect() {
    const found = locate('qwen', 'AGENT_DERBY_QWEN_BIN');
    if (!found) return { installed: false, version: null, path: null, origin: null, auth: 'unknown', authDetail: null };
    const version = await readVersion(found.path);
    const selected = authSelected();
    const hasOauth = fs.existsSync(home('.qwen', 'oauth_creds.json'));
    const auth = selected || hasOauth ? 'ok' : 'missing';
    return {
      installed: true,
      version,
      path: found.path,
      origin: found.origin,
      auth,
      authDetail: auth === 'ok' ? `Auth method: ${selected ?? 'qwen-oauth'}` : 'Not signed in',
    };
  },

  start(ctx) {
    const args = ['-o', 'stream-json', '--approval-mode', 'yolo'];
    if (ctx.model) args.push('-m', ctx.model);
    args.push(ctx.prompt);
    return { command: ctx.exe, args, env: { QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' } };
  },

  createParser(ctx) {
    return new ClaudeParser(ctx.workspace);
  },

  login(exe) {
    return { command: exe, args: [], hint: 'Type /auth, choose how to sign in, finish in the browser, then type /quit.' };
  },
};
