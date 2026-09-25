// Thin fetch wrapper over the contract (contracts/openapi.yaml).
// All types come from the generated `schema.d.ts` (`npm run gen:api`).
import type { components, operations } from './schema';

export type S = components['schemas'];
export type Match = S['Match'];
export type MatchSummary = S['MatchSummary'];
export type Move = S['Move'];
export type Analysis = S['Analysis'];
export type AnalyzedMove = S['AnalyzedMove'];
export type AgentReport = S['AgentReport'];
export type MatchEvent = S['MatchEvent'];
export type EngineThinking = S['EngineThinking'];

export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as S['Error'];
      if (err?.message) msg = `${err.code}: ${err.message}`;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

function qs(q?: Record<string, string | number | undefined>): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export const api = {
  health: () => req<S['Health']>('/health'),
  listEngines: () => req<S['EngineVersion'][]>('/engines'),
  listMatches: (q?: operations['listMatches']['parameters']['query']) =>
    req<S['MatchPage']>(`/matches${qs(q)}`),
  createMatches: (body: S['CreateMatchRequest']) =>
    req<MatchSummary[]>('/matches', { method: 'POST', body: JSON.stringify(body) }),
  getMatch: (id: string) => req<Match>(`/matches/${enc(id)}`),
  abortMatch: (id: string) => req<MatchSummary>(`/matches/${enc(id)}/abort`, { method: 'POST' }),
  getAnalysis: (id: string) => req<Analysis>(`/matches/${enc(id)}/analysis`),
  rerunAnalysis: (id: string) => req<Analysis>(`/matches/${enc(id)}/analysis`, { method: 'POST' }),
  getLadder: () => req<S['Ladder']>('/ladder'),
  getStats: (q?: operations['getStats']['parameters']['query']) => req<S['Stats']>(`/stats${qs(q)}`),
};

export const pgnUrl = (id: string) => `${API_BASE}/matches/${enc(id)}/pgn`;
export const eventsUrl = (id: string) => `${API_BASE}/matches/${enc(id)}/events`;

export const MATCH_EVENT_TYPES: MatchEvent['type'][] = [
  'match.snapshot',
  'match.started',
  'engine.info',
  'move.played',
  'match.finished',
  'analysis.updated',
];
