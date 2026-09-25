import { api } from '../api/client';
import { fmtDate, matchHref, useFetch } from '../util';

export function LadderPage() {
  const { data, error } = useFetch(() => api.getLadder(), []);
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <div>
      <h2>Elo ladder</h2>
      <div className="panel big">
        Highest Stockfish Elo beaten:{' '}
        {data.highestEloBeaten ? (
          <>
            <b>{data.highestEloBeaten}</b>{' '}
            {data.proofMatchId && <a href={matchHref(data.proofMatchId)}>(proof game)</a>}
          </>
        ) : (
          <b>none yet</b>
        )}
      </div>
      <p className="muted">Only wins count. A draw does not beat a level.</p>
      <table className="grid">
        <thead>
          <tr>
            <th>Elo</th>
            <th>State</th>
            <th>Games</th>
            <th>W</th>
            <th>D</th>
            <th>L</th>
            <th>First win</th>
          </tr>
        </thead>
        <tbody>
          {[...data.levels].reverse().map((l) => (
            <tr key={l.elo} className={`state-${l.state}`}>
              <td>
                <b>{l.elo}</b>
              </td>
              <td>{l.state}</td>
              <td>{l.games}</td>
              <td>{l.wins}</td>
              <td>{l.draws}</td>
              <td>{l.losses}</td>
              <td>{l.firstWinMatchId ? <a href={matchHref(l.firstWinMatchId)}>{fmtDate(l.firstWinAt) || 'game'}</a> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
