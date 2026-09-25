import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  eventsUrl,
  pgnUrl,
  MATCH_EVENT_TYPES,
  type AgentReport,
  type Analysis,
  type AnalyzedMove,
  type EngineThinking,
  type Match,
  type MatchEvent,
  type Move,
} from '../api/client';
import { Board } from '../components/Board';
import { EvalGraph } from '../components/EvalGraph';
import { fmtDate, fmtEval } from '../util';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BADGE: Partial<Record<AnalyzedMove['classification'], string>> = {
  brilliant: '!!',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};
const isActive = (s?: Match['status']) => s === 'queued' || s === 'running';

export function MatchPage({ id }: { id: string }) {
  const [match, setMatch] = useState<Match>();
  const [error, setError] = useState<string>();
  const [ply, setPly] = useState(0);
  const [follow, setFollow] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const [speed, setSpeed] = useState(1000);
  const [flipped, setFlipped] = useState(false);
  const [live, setLive] = useState(false);
  const [thinking, setThinking] = useState<{ side: string; thinking: EngineThinking }>();
  const [analysis, setAnalysis] = useState<Analysis>();
  const [analysisError, setAnalysisError] = useState<string>();

  // ---- load match -------------------------------------------------------
  useEffect(() => {
    setMatch(undefined);
    setError(undefined);
    setAnalysis(undefined);
    api
      .getMatch(id)
      .then((m) => {
        setMatch(m);
        const active = isActive(m.status);
        setLive(active);
        setFollow(active);
        setPly(active ? m.moves.length : 0);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const moves: Move[] = match?.moves ?? [];
  const n = moves.length;

  // ---- live events (SSE) --------------------------------------------------
  const loadAnalysis = useCallback(() => {
    api
      .getAnalysis(id)
      .then((a) => {
        setAnalysis(a);
        setAnalysisError(undefined);
      })
      .catch((e: Error) => setAnalysisError(e.message));
  }, [id]);

  useEffect(() => {
    if (!live) return;
    const es = new EventSource(eventsUrl(id));
    const handle = (raw: MessageEvent<string>) => {
      let ev: MatchEvent;
      try {
        ev = JSON.parse(raw.data) as MatchEvent;
      } catch {
        return;
      }
      switch (ev.type) {
        case 'match.snapshot':
        case 'match.started':
          setMatch(ev.match);
          break;
        case 'move.played': {
          const mv = ev.move;
          setMatch((m) =>
            m && !m.moves.some((x) => x.ply === mv.ply)
              ? { ...m, status: 'running', moves: [...m.moves, mv].sort((a, b) => a.ply - b.ply), plyCount: mv.ply }
              : m,
          );
          setThinking(undefined);
          break;
        }
        case 'engine.info':
          setThinking({ side: ev.side, thinking: ev.thinking });
          break;
        case 'match.finished':
          setMatch((m) => m && { ...m, status: 'finished', result: ev.result, outcome: ev.outcome, termination: ev.termination });
          setThinking(undefined);
          break;
        case 'analysis.updated':
          setMatch((m) => m && { ...m, analysisStatus: ev.analysisStatus });
          loadAnalysis();
          if (ev.analysisStatus === 'ready' || ev.analysisStatus === 'failed') es.close();
          break;
        default:
          break; // unknown types are ignored (contract rule)
      }
    };
    for (const t of MATCH_EVENT_TYPES) es.addEventListener(t, handle as EventListener);
    return () => es.close();
  }, [id, live, loadAnalysis]);

  // follow the latest move while live
  useEffect(() => {
    if (follow) setPly(n);
  }, [n, follow]);

  // ---- analysis (poll while pending/running) ------------------------------
  const finished = match && !isActive(match.status);
  useEffect(() => {
    if (finished) loadAnalysis();
  }, [finished, loadAnalysis]);
  const aStatus = analysis?.status ?? match?.analysisStatus;
  useEffect(() => {
    if (!finished || (aStatus !== 'pending' && aStatus !== 'running')) return;
    const t = setInterval(loadAnalysis, 3000);
    return () => clearInterval(t);
  }, [finished, aStatus, loadAnalysis]);

  // ---- navigation ---------------------------------------------------------
  const goto = useCallback(
    (p: number) => {
      const c = Math.max(0, Math.min(n, p));
      setPly(c);
      setFollow(live && c === n);
    },
    [n, live],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const map: Record<string, number> = { ArrowLeft: ply - 1, ArrowRight: ply + 1, Home: 0, End: n };
      if (e.key in map) {
        e.preventDefault();
        setAutoplay(false);
        goto(map[e.key]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ply, n, goto]);

  useEffect(() => {
    if (!autoplay) return;
    if (ply >= n) {
      setAutoplay(false);
      return;
    }
    const t = setTimeout(() => goto(ply + 1), speed);
    return () => clearTimeout(t);
  }, [autoplay, ply, n, speed, goto]);

  const byPly = useMemo(() => {
    const m = new Map<number, AnalyzedMove>();
    for (const a of analysis?.moves ?? []) m.set(a.ply, a);
    return m;
  }, [analysis]);

  if (error) return <p className="error">Error: {error}</p>;
  if (!match) return <p>Loading…</p>;

  const cur = ply > 0 ? moves[ply - 1] : undefined;
  const fen = cur?.fenAfter ?? match.startFen ?? START_FEN;
  const engineName = `${match.engine?.name ?? 'AmazingChess'} v${match.engineVersion}`;
  const sfName = `Stockfish (${match.stockfishElo})`;
  const white = match.engineColor === 'white' ? engineName : sfName;
  const black = match.engineColor === 'white' ? sfName : engineName;
  const orientation = (match.engineColor === 'black') !== flipped ? 'black' : 'white';
  const curA = cur ? byPly.get(cur.ply) : undefined;
  const nextBest = byPly.get(ply + 1)?.bestMoveUci;
  const sanAt = (p: number) => {
    const m = moves[p - 1];
    return m ? `${Math.ceil(p / 2)}.${m.color === 'black' ? '..' : ''} ${m.san}` : `ply ${p}`;
  };

  return (
    <div>
      <h2>
        {white} vs {black}
      </h2>
      <p>
        <b>{match.result ?? '*'}</b> {match.outcome && <span className={`tag ${match.outcome}`}>{match.outcome}</span>}{' '}
        {match.termination && <span>by {match.termination}</span>} · status <b>{match.status}</b>
        {live && isActive(match.status) && <span className="tag live">LIVE</span>} · {fmtDate(match.startedAt ?? match.createdAt)} ·{' '}
        <a href={pgnUrl(match.id)} download={`${match.id}.pgn`}>
          Download PGN
        </a>
        {isActive(match.status) && (
          <>
            {' '}
            · <button onClick={() => api.abortMatch(match.id).catch((e: Error) => alert(e.message))}>Abort</button>
          </>
        )}
      </p>
      <p className="muted">
        Stockfish {match.stockfish?.version ?? ''} UCI_Elo {match.stockfish?.elo} (limitStrength), {match.stockfish?.moveTimeMs} ms/move ·
        our engine {match.engine?.moveTimeMs} ms/move · id {match.id}
      </p>

      <div className="replay">
        <div>
          <Board fen={fen} lastMoveUci={cur?.uci} orientation={orientation} arrowUci={nextBest} />
          <div className="controls">
            <button onClick={() => goto(0)} title="Home">⏮</button>
            <button onClick={() => goto(ply - 1)} title="←">◀</button>
            <button onClick={() => goto(ply + 1)} title="→">▶</button>
            <button onClick={() => goto(n)} title="End">⏭</button>
            <button onClick={() => (ply >= n ? (goto(0), setAutoplay(true)) : setAutoplay((a) => !a))}>
              {autoplay ? 'Pause' : 'Autoplay'}
            </button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value={2000}>0.5×</option>
              <option value={1000}>1×</option>
              <option value={500}>2×</option>
              <option value={250}>4×</option>
            </select>
            <button onClick={() => setFlipped((f) => !f)}>Flip</button>
            <span className="muted">
              ply {ply}/{n}
            </span>
          </div>
          {cur && (
            <div className="panel">
              <b>{sanAt(cur.ply)}</b> by {cur.by} in {cur.timeMs} ms
              {cur.thinking && (
                <span className="muted">
                  {' '}
                  · depth {cur.thinking.depth} · score {fmtEval(cur.thinking.scoreCp, cur.thinking.mateIn)} (mover)
                  {cur.thinking.nps ? ` · ${Math.round(cur.thinking.nps / 1000)} knps` : ''}
                </span>
              )}
              {curA && (
                <div>
                  Eval {fmtEval(curA.evalCp, curA.mateIn)} · <span className={`cls ${curA.classification}`}>{curA.classification}</span>
                  {curA.cpLoss ? ` (−${curA.cpLoss} cp)` : ''}
                  {curA.bestMoveSan && curA.bestMoveUci !== cur.uci && <> · best was <b>{curA.bestMoveSan}</b></>}
                </div>
              )}
            </div>
          )}
          {nextBest && <p className="muted">Green arrow: analysis best move in this position.</p>}
          {thinking && isActive(match.status) && (
            <div className="panel">
              {thinking.side} thinking: depth {thinking.thinking.depth ?? '?'} · score{' '}
              {fmtEval(thinking.thinking.scoreCp, thinking.thinking.mateIn)}
              {thinking.thinking.nodes ? ` · ${thinking.thinking.nodes} nodes` : ''}
              {thinking.thinking.pv?.length ? ` · pv ${thinking.thinking.pv.slice(0, 6).join(' ')}` : ''}
            </div>
          )}
        </div>

        <div className="side">
          <MoveList moves={moves} ply={ply} byPly={byPly} onJump={goto} />
          {byPly.size > 0 && <EvalGraph analysis={[...byPly.values()]} plies={n} ply={ply} onJump={goto} />}
        </div>
      </div>

      <AnalysisSection
        match={match}
        analysis={analysis}
        status={aStatus}
        error={analysisError}
        sanAt={sanAt}
        onJump={goto}
        onRerun={() => api.rerunAnalysis(match.id).then(setAnalysis).catch((e: Error) => alert(e.message))}
      />
    </div>
  );
}

function MoveList({
  moves,
  ply,
  byPly,
  onJump,
}: {
  moves: Move[];
  ply: number;
  byPly: Map<number, AnalyzedMove>;
  onJump: (p: number) => void;
}) {
  const rows: { no: number; w?: Move; b?: Move }[] = [];
  for (const m of moves) {
    const no = Math.ceil(m.ply / 2);
    const last = rows[rows.length - 1];
    if (m.color === 'black' && last && last.no === no && !last.b) last.b = m;
    else rows.push(m.color === 'white' ? { no, w: m } : { no, b: m });
  }
  const cell = (m?: Move) => {
    if (!m) return <td />;
    const a = byPly.get(m.ply);
    const badge = a && BADGE[a.classification];
    return (
      <td
        className={`mv ${m.ply === ply ? 'cur' : ''} ${m.by}`}
        onClick={() => onJump(m.ply)}
        title={`${m.by} · ${m.timeMs} ms${a ? ` · ${a.classification} · eval ${fmtEval(a.evalCp, a.mateIn)}` : ''}`}
      >
        {m.san}
        {badge && <span className={`cls ${a!.classification}`}> {badge}</span>}
      </td>
    );
  };
  return (
    <div className="movelist">
      <table>
        <tbody>
          <tr>
            <td className="muted">0.</td>
            <td className={`mv ${ply === 0 ? 'cur' : ''}`} onClick={() => onJump(0)} colSpan={2}>
              start
            </td>
          </tr>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="muted">{r.no}.</td>
              {cell(r.w)}
              {cell(r.b)}
            </tr>
          ))}
        </tbody>
      </table>
      {moves.length === 0 && <p className="muted">No moves yet.</p>}
    </div>
  );
}

function AnalysisSection({
  match,
  analysis,
  status,
  error,
  sanAt,
  onJump,
  onRerun,
}: {
  match: Match;
  analysis?: Analysis;
  status?: string;
  error?: string;
  sanAt: (p: number) => string;
  onJump: (p: number) => void;
  onRerun: () => void;
}) {
  if (isActive(match.status)) return null;
  const s = analysis?.summary;
  return (
    <section>
      <h3>
        Analysis <span className="muted">({status ?? 'unknown'})</span>{' '}
        <button onClick={onRerun} disabled={status === 'pending' || status === 'running'}>
          Re-run
        </button>
      </h3>
      {error && <p className="error">Analysis: {error}</p>}
      {(status === 'pending' || status === 'running') && <p className="muted">Analysis in progress… (refreshing)</p>}
      {s && (
        <p>
          {s.opening && <>Opening: {s.opening} · </>}
          Accuracy — ours: {s.engineAccuracy ?? '-'} · Stockfish: {s.stockfishAccuracy ?? '-'}
          {s.decisivePly ? (
            <>
              {' '}
              · decisive:{' '}
              <a className="jump" onClick={() => onJump(s.decisivePly!)}>
                {sanAt(s.decisivePly)}
              </a>
            </>
          ) : null}
          {analysis?.analyzer && (
            <span className="muted">
              {' '}
              · {analysis.analyzer.engine} depth {analysis.analyzer.depth}
            </span>
          )}
        </p>
      )}
      <div className="reports">
        <Report title="GM coach" report={analysis?.reports?.gmCoach} sanAt={sanAt} onJump={onJump} />
        <Report title="Engine developer" report={analysis?.reports?.engineDev} sanAt={sanAt} onJump={onJump} />
      </div>
    </section>
  );
}

function Report({
  title,
  report,
  sanAt,
  onJump,
}: {
  title: string;
  report?: AgentReport;
  sanAt: (p: number) => string;
  onJump: (p: number) => void;
}) {
  const PlyLink = ({ p }: { p: number }) => (
    <a className="jump" onClick={() => onJump(p)}>
      {sanAt(p)}
    </a>
  );
  return (
    <div className="panel report">
      <h4>
        {title} <span className="muted">({report?.status ?? 'not available'})</span>
      </h4>
      {report?.summary && <p className="pre">{report.summary}</p>}
      {!!report?.keyMoments?.length && (
        <>
          <b>Key moments</b>
          <ul>
            {report.keyMoments.map((k, i) => (
              <li key={i}>
                <PlyLink p={k.ply} />: <span className="pre">{k.comment}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!report?.suggestions?.length && (
        <>
          <b>Suggestions</b>
          <ul>
            {report.suggestions.map((sg, i) => (
              <li key={i}>
                <span className={`tag prio-${sg.priority}`}>{sg.priority}</span> <span className="tag">{sg.category}</span>{' '}
                <b>{sg.title}</b>
                <div className="pre">{sg.detail}</div>
                {!!sg.relatedPlies?.length && (
                  <div className="muted">
                    Related:{' '}
                    {sg.relatedPlies.map((p, j) => (
                      <span key={p}>
                        {j > 0 && ', '}
                        <PlyLink p={p} />
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
