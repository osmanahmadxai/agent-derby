import path from 'node:path';
import { distDir } from '../paths.js';
import { tryJson, type AgentAdapter, type AgentEvent, type EventParser } from './types.js';

/**
 * Mock agents replay a scripted run (see src/mock/mock-agent.ts). They are real
 * child processes that print events and write files, so a mock race exercises
 * exactly the same code paths as a real one — without spending tokens.
 */

class MockParser implements EventParser {
  parse(line: string, stream: 'stdout' | 'stderr'): AgentEvent[] {
    const o = tryJson(line);
    if (o && typeof o.type === 'string') return [o as AgentEvent];
    if (!line.trim()) return [];
    if (stream === 'stderr' && /not logged in|\/login/i.test(line)) return [{ type: 'error', message: line.trim(), kind: 'auth' }];
    if (stream === 'stderr') return [{ type: 'error', message: line.trim(), kind: 'other' }];
    return [{ type: 'raw', text: line }];
  }
}

export function mockAgentScript(): string {
  return process.env.AGENT_DERBY_MOCK_AGENT || path.join(distDir(), 'mock-agent.js');
}

function mock(id: string, name: string, color: string, defaultScenario: string, blurb: string): AgentAdapter {
  return {
    id,
    name,
    vendor: 'Agent Derby',
    kind: 'mock',
    color,
    installCommand: null,
    docsUrl: null,
    models: [],
    efforts: ['low', 'high'],
    sandboxNote: blurb,
    async detect() {
      return { installed: true, version: '1.0.0-mock', path: mockAgentScript(), origin: 'bundled', auth: 'ok', authDetail: 'No account needed' };
    },
    start(ctx) {
      const scenario = ctx.options.scenario || defaultScenario;
      const env: Record<string, string> = {};
      // Inside the desktop app the "node" we have is Electron itself.
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      if (ctx.effort === 'low') env.AGENT_DERBY_MOCK_SPEED = String((Number(process.env.AGENT_DERBY_MOCK_SPEED) || 1) * 2);
      return { command: process.execPath, args: [mockAgentScript(), scenario], env, stdin: ctx.prompt };
    },
    // A follow-up round replays a short scripted edit.
    resume(ctx) {
      const env: Record<string, string> = {};
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      return { command: process.execPath, args: [mockAgentScript(), 'followup'], env, stdin: ctx.prompt };
    },
    createParser() {
      return new MockParser();
    },
  };
}

export const mockAdapters: AgentAdapter[] = [
  mock('mock-hare', 'Mock Hare', '#f97316', 'hare', 'Scripted demo: quickly writes a single-file browser game (static site).'),
  mock('mock-tortoise', 'Mock Tortoise', '#22c55e', 'tortoise', 'Scripted demo: slowly builds a Node web app with a test, and writes no manifest.'),
  mock('mock-owl', 'Mock Owl', '#a855f7', 'owl', 'Scripted demo: builds a terminal game.'),
  mock('mock-gremlin', 'Mock Gremlin', '#ef4444', 'crash', 'Scripted failure: crash, hang, nothing, or auth.'),
];
