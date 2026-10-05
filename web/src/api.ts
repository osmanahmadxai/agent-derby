import type {
  AgentInfo,
  CustomAgentConfig,
  FeedItem,
  FollowUpRequest,
  JudgeRequest,
  KeepRequest,
  LaneDiff,
  ManualPreviewRequest,
  Race,
  RaceSetup,
  RaceSummary,
  RepoCheck,
  SuiteRequest,
  SuiteView,
  SystemInfo,
  VoteRequest,
} from './types';

export class ApiFailure extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFailure('Cannot reach the Agent Derby server. Check that it is still running.', 0);
  }
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Request failed (${res.status} ${res.statusText || 'error'})`;
    throw new ApiFailure(msg, res.status);
  }
  return data as T;
}

const e = encodeURIComponent;
const lanePath = (raceId: string, laneId: string) => `/api/races/${e(raceId)}/lanes/${e(laneId)}`;

export const api = {
  system: () => req<SystemInfo>('GET', '/api/system'),
  agents: () => req<AgentInfo[]>('GET', '/api/agents'),
  installAgent: (id: string) => req<{ ok: true }>('POST', `/api/agents/${e(id)}/install`),
  addCustomAgent: (cfg: CustomAgentConfig) => req<{ ok: true }>('POST', '/api/custom-agents', cfg),
  deleteCustomAgent: (id: string) => req<unknown>('DELETE', `/api/custom-agents/${e(id)}`),
  checkRepo: (path: string) => req<RepoCheck>('POST', '/api/check-repo', { path }),

  startRace: (setup: RaceSetup) => req<{ id: string }>('POST', '/api/races', setup),
  races: () => req<RaceSummary[]>('GET', '/api/races'),
  race: (id: string) => req<Race>('GET', `/api/races/${e(id)}`),
  stopRace: (id: string) => req<unknown>('POST', `/api/races/${e(id)}/stop`),
  closeRace: (id: string) => req<unknown>('POST', `/api/races/${e(id)}/close`),
  deleteRace: (id: string) => req<unknown>('DELETE', `/api/races/${e(id)}`),
  exportUrl: (id: string) => `/api/races/${e(id)}/export`,
  closeUrl: (id: string) => `/api/races/${e(id)}/close`,
  replayUrl: (id: string) => `/api/races/${e(id)}/replay`,
  followUp: (id: string, body: FollowUpRequest) => req<{ ok: true }>('POST', `/api/races/${e(id)}/followup`, body),
  judge: (id: string, body: JudgeRequest) => req<{ ok: true }>('POST', `/api/races/${e(id)}/judge`, body),
  vote: (id: string, body: VoteRequest) => req<{ ok: true }>('POST', `/api/races/${e(id)}/vote`, body),

  startSuite: (body: SuiteRequest) => req<{ id: string }>('POST', '/api/suites', body),
  suites: () => req<SuiteView[]>('GET', '/api/suites'),
  suite: (id: string) => req<SuiteView>('GET', `/api/suites/${e(id)}`),
  stopSuite: (id: string) => req<{ ok: true }>('POST', `/api/suites/${e(id)}/stop`),
  deleteSuite: (id: string) => req<{ ok: true }>('DELETE', `/api/suites/${e(id)}`),

  feed: (raceId: string, laneId: string) => req<FeedItem[]>('GET', `${lanePath(raceId, laneId)}/feed`),
  diff: (raceId: string, laneId: string) => req<LaneDiff>('GET', `${lanePath(raceId, laneId)}/diff`),
  stopLane: (raceId: string, laneId: string) => req<unknown>('POST', `${lanePath(raceId, laneId)}/stop`),
  keep: (raceId: string, laneId: string, body: KeepRequest) =>
    req<{ ok: true; detail: string }>('POST', `${lanePath(raceId, laneId)}/keep`, body),
  startPreview: (raceId: string, laneId: string, body: ManualPreviewRequest = {}) =>
    req<unknown>('POST', `${lanePath(raceId, laneId)}/preview/start`, body),
  stopPreview: (raceId: string, laneId: string) => req<unknown>('POST', `${lanePath(raceId, laneId)}/preview/stop`),
  previewLogs: (raceId: string, laneId: string) =>
    req<{ log: string }>('GET', `${lanePath(raceId, laneId)}/preview/logs`),
  openWorkspace: (raceId: string, laneId: string) => req<unknown>('POST', `${lanePath(raceId, laneId)}/open`),
};

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
