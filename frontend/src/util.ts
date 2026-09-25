import { useEffect, useState } from 'react';

/** Minimal hash router: returns the path after `#`, e.g. "/matches/abc". */
export function useHashPath(): string {
  const get = () => window.location.hash.replace(/^#/, '') || '/matches';
  const [path, setPath] = useState(get);
  useEffect(() => {
    const on = () => setPath(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

export const matchHref = (id: string) => `#/matches/${encodeURIComponent(id)}`;

export function fmtDate(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function fmtEval(cp?: number | null, mate?: number | null): string {
  if (mate !== undefined && mate !== null) return mate === 0 ? '#' : `M${mate}`;
  if (cp === undefined || cp === null) return '';
  return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
}

export function pct(wins: number, draws: number, games: number): string {
  return games ? `${(((wins + draws / 2) / games) * 100).toFixed(0)}%` : '-';
}

/** Generic "fetch on mount, optionally poll" hook. */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: (data: T | undefined) => number | null) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(undefined);
        }
      })
      .catch((e: unknown) => alive && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const interval = pollMs ? pollMs(data) : null;
  useEffect(() => {
    if (!interval) return;
    const t = setTimeout(() => setTick((x) => x + 1), interval);
    return () => clearTimeout(t);
  }, [interval, tick]);
  return { data, error, reload: () => setTick((x) => x + 1), setData };
}
