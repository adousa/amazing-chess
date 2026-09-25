import { useState, type FormEvent } from 'react';
import { api, type S } from '../api/client';
import { fmtDate, matchHref, useFetch } from '../util';

export function MatchesPage() {
  const list = useFetch(
    () => api.listMatches({ limit: 200 }),
    [],
    (d) => (d?.items.some((m) => m.status === 'queued' || m.status === 'running' || m.analysisStatus === 'running') ? 3000 : null),
  );
  const engines = useFetch(() => api.listEngines(), []);

  return (
    <div>
      <h2>Matches</h2>
      <NewMatchForm engines={engines.data ?? []} onCreated={list.reload} />
      {list.error && <p className="error">Error: {list.error}</p>}
      {!list.data && !list.error && <p>Loading…</p>}
      {list.data && (
        <table className="grid">
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>SF Elo</th>
              <th>Our colour</th>
              <th>Engine</th>
              <th>Result</th>
              <th>Outcome</th>
              <th>Termination</th>
              <th>Plies</th>
              <th>Analysis</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((m) => (
              <tr key={m.id}>
                <td>{fmtDate(m.createdAt)}</td>
                <td>{m.status}</td>
                <td>{m.stockfishElo}</td>
                <td>{m.engineColor}</td>
                <td>{m.engineVersion}</td>
                <td>{m.result ?? ''}</td>
                <td>{m.outcome && <span className={`tag ${m.outcome}`}>{m.outcome}</span>}</td>
                <td>{m.termination ?? ''}</td>
                <td>{m.plyCount ?? ''}</td>
                <td>{m.analysisStatus}</td>
                <td>
                  <a href={matchHref(m.id)}>{m.status === 'running' ? 'Watch live' : 'Replay'}</a>
                </td>
              </tr>
            ))}
            {list.data.items.length === 0 && (
              <tr>
                <td colSpan={11} className="muted">
                  No matches yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewMatchForm({ engines, onCreated }: { engines: S['EngineVersion'][]; onCreated: () => void }) {
  const [elo, setElo] = useState(1320);
  const [color, setColor] = useState<S['ColorChoice']>('alternate');
  const [count, setCount] = useState(1);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    try {
      const res = await api.createMatches({
        stockfishElo: elo,
        engineColor: color,
        count,
        ...(version ? { engineVersion: version } : {}),
      });
      setMsg(`Queued ${res.length} match(es).`);
      onCreated();
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel form" onSubmit={submit}>
      <b>New match</b>
      <label>
        Stockfish Elo{' '}
        <input type="number" min={1320} max={3190} step={10} value={elo} onChange={(e) => setElo(Number(e.target.value))} required />
      </label>
      <label>
        Our colour{' '}
        <select value={color} onChange={(e) => setColor(e.target.value as S['ColorChoice'])}>
          {(['alternate', 'white', 'black', 'random'] as const).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        Count <input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} required />
      </label>
      <label>
        Engine{' '}
        <select value={version} onChange={(e) => setVersion(e.target.value)}>
          <option value="">latest</option>
          {engines.map((v) => (
            <option key={v.version} value={v.version}>
              {v.version}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy}>{busy ? 'Queuing…' : 'Queue'}</button>
      {msg && <span className={msg.startsWith('Error') ? 'error' : 'muted'}>{msg}</span>}
    </form>
  );
}
