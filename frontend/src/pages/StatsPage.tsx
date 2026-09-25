import type { ReactNode } from 'react';
import { api, type S } from '../api/client';
import { pct, useFetch } from '../util';

function WdlTable({ title, rows }: { title: string; rows: { key: ReactNode; wdl?: S['WDL'] }[] }) {
  return (
    <>
      <h3>{title}</h3>
      <table className="grid">
        <thead>
          <tr>
            <th />
            <th>Games</th>
            <th>W</th>
            <th>D</th>
            <th>L</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <b>{r.key}</b>
              </td>
              <td>{r.wdl?.games ?? 0}</td>
              <td>{r.wdl?.wins ?? 0}</td>
              <td>{r.wdl?.draws ?? 0}</td>
              <td>{r.wdl?.losses ?? 0}</td>
              <td>{r.wdl ? pct(r.wdl.wins, r.wdl.draws, r.wdl.games) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function StatsPage() {
  const { data, error } = useFetch(() => api.getStats(), []);
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <div>
      <h2>Stats</h2>
      <WdlTable title="Total" rows={[{ key: 'All games', wdl: data.total }]} />
      <WdlTable title="Per Stockfish Elo" rows={data.byElo.map((r) => ({ key: r.elo, wdl: r }))} />
      <WdlTable
        title="Per colour (ours)"
        rows={[
          { key: 'White', wdl: data.byColor.white },
          { key: 'Black', wdl: data.byColor.black },
        ]}
      />
      <WdlTable title="Per engine version" rows={data.byEngineVersion.map((r) => ({ key: r.engineVersion, wdl: r }))} />
    </div>
  );
}
