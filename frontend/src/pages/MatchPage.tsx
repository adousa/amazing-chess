import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { MusicPlayer } from '../components/MusicPlayer';
import { capturedByPly, describeMove, START_FEN, type MoveStyle } from '../chess';
import { fmtDate, fmtEval } from '../util';

// three.js is only downloaded when a match is opened
const SealStage = lazy(() => import('../components/SealStage').then((m) => ({ default: m.SealStage })));
const ExpeditionStage = lazy(() => import('../components/ExpeditionStage').then((m) => ({ default: m.ExpeditionStage })));

type ViewMode = 'shoulder' | 'above' | '2d';
type Theme = 'expedition' | 'seal';
const VIEW_KEY = 'ac.view';
const THEME_KEY = 'ac.theme';
const DUELS_KEY = 'ac.duels';
const MUSIC_KEY = 'ac.music';
/** Soundtrack for the Expedition stage: the official upload, played through YouTube's embed. */
// (A fan-made compilation of the battle themes; if it is ever taken down, the official upload of
// "Lumière" is videoId 'zmvsw2ILX5k' on Sandfall Interactive's channel.)
const MUSIC = { videoId: 'Jgcp7ou9Xbs', title: 'Battle themes', credit: 'Clair Obscur: Expedition 33 OST (music by Lorien Testard) · via YouTube' };
/** How long each beat of the Expedition prologue is on screen (ms), long enough to read. */
const BEATS_MS = [7000, 7500, 7000, 7000];
const BEAT_AT = BEATS_MS.map((_, i) => BEATS_MS.slice(0, i).reduce((a, b) => a + b, 0));
const LAST_BEAT_AT = BEATS_MS.reduce((a, b) => a + b, 0);
const PROLOGUE_MS = LAST_BEAT_AT + 4000;
const load = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: not remembered */
  }
};
const savedView = (): ViewMode => {
  const v = load(VIEW_KEY);
  return v === 'above' || v === '2d' ? v : 'shoulder';
};

/** How each stage names the two sides and tells the story. */
const CAST: Record<Theme, { us: string; them: string; versus: string; result: Record<string, string>; style: MoveStyle; views: Record<ViewMode, string> }> = {
  seal: {
    us: 'The Knight',
    them: 'Death',
    versus: 'plays chess with',
    result: { win: 'The Knight has won.', loss: 'Death has won.', draw: 'Neither of them wins. A draw.' },
    style: 'plain',
    views: { shoulder: 'Shoulder', above: 'Above', '2d': '2D' },
  },
  expedition: {
    us: 'The Expedition',
    them: 'The Paintress',
    versus: 'marches against',
    result: {
      win: 'The Paintress falls. The number climbs, and Lumière lives longer.',
      loss: 'The Paintress paints over the Expedition.',
      draw: 'Neither side falls. The number stays on the Monolith.',
    },
    style: 'battle',
    views: { shoulder: 'Battle', above: 'Above', '2d': '2D' },
  },
};
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
  const [view, setView] = useState<ViewMode>(savedView);
  const [intro, setIntro] = useState(true);
  /** Highest Stockfish Elo ever beaten: in the story, how long Lumière's people may now live. */
  const [lifespan, setLifespan] = useState<number | null>();
  const [stepMs, setStepMs] = useState(1300);
  const [theme, setTheme] = useState<Theme>(() => (load(THEME_KEY) === 'seal' ? 'seal' : 'expedition'));
  const [duels, setDuels] = useState(() => load(DUELS_KEY) !== 'off');
  const [music, setMusic] = useState(() => load(MUSIC_KEY) !== 'off');
  const [cameraReset, setCameraReset] = useState(0);
  // autoplay waits for a duel to finish before the next move
  const busyUntil = useRef(0);
  const chooseView = (v: ViewMode) => {
    setView(v);
    save(VIEW_KEY, v);
  };
  const chooseTheme = (t: Theme) => {
    setTheme(t);
    save(THEME_KEY, t);
  };
  const toggleMusic = () => {
    setMusic((m) => {
      save(MUSIC_KEY, m ? 'off' : 'on');
      return !m;
    });
  };
  const toggleDuels = () => {
    setDuels((d) => {
      save(DUELS_KEY, d ? 'off' : 'on');
      return !d;
    });
  };
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), load(THEME_KEY) === 'seal' ? 3800 : PROLOGUE_MS);
    api
      .getLadder()
      .then((l) => setLifespan(l.highestEloBeaten ?? null))
      .catch(() => setLifespan(null));
    return () => clearTimeout(t);
  }, [id]);

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
        setStepMs(e.repeat ? 0 : 1300);
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
    const wait = Math.max(speed, busyUntil.current - performance.now() + 250);
    const t = setTimeout(() => {
      setStepMs(Math.min(speed * 0.85, 1600));
      goto(ply + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [autoplay, ply, n, speed, goto]);

  const startFen = match?.startFen ?? START_FEN;
  const captured = useMemo(() => capturedByPly(moves, startFen), [moves, startFen]);

  const byPly = useMemo(() => {
    const m = new Map<number, AnalyzedMove>();
    for (const a of analysis?.moves ?? []) m.set(a.ply, a);
    return m;
  }, [analysis]);

  if (error) return <p className="error">Error: {error}</p>;
  if (!match) return <p>Loading…</p>;

  const cur = ply > 0 ? moves[ply - 1] : undefined;
  const fen = cur?.fenAfter ?? startFen;
  const engineName = `${match.engine?.name ?? 'AmazingChess'} v${match.engineVersion}`;
  const sfName = `Stockfish ${match.stockfishElo}`;
  const white = match.engineColor === 'white' ? engineName : sfName;
  const black = match.engineColor === 'white' ? sfName : engineName;
  const orientation = (match.engineColor === 'black') !== flipped ? 'black' : 'white';
  const curA = cur ? byPly.get(cur.ply) : undefined;
  const nextBest = byPly.get(ply + 1)?.bestMoveUci;
  const sanAt = (p: number) => {
    const m = moves[p - 1];
    return m ? `${Math.ceil(p / 2)}.${m.color === 'black' ? '..' : ''} ${m.san}` : `ply ${p}`;
  };
  const cast = CAST[theme];
  const KNIGHT = cast.us;
  const DEATH = cast.them;
  const who = (m?: Move) => (m?.by === 'engine' ? KNIGHT : DEATH);
  const active = isActive(match.status);
  const thinkingSide = active && thinking ? (thinking.side as 'engine' | 'stockfish') : null;
  const atEnd = !active && ply === n && !!match.outcome;
  const step = (p: number, ms = 1300) => {
    setAutoplay(false);
    setStepMs(ms);
    goto(p);
  };
  const liveMs = live && follow ? 1500 : stepMs;

  const overlay = (
    <>
      <div className="stage-name far">
        <span className="who">{DEATH}</span>
        <span className="what">{sfName}</span>
      </div>
      <div className="stage-name near">
        <span className="who">{KNIGHT}</span>
        <span className="what">{engineName}</span>
      </div>
      <div className="stage-status">
        {live && active && <span className="tag live">live</span>}
        {thinkingSide && (
          <span className="thinking">
            {thinkingSide === 'engine' ? KNIGHT : DEATH} is thinking
            {thinking?.thinking.depth ? ` · depth ${thinking.thinking.depth}` : ''}
          </span>
        )}
        <span className="plyno">
          {ply}/{n}
        </span>
      </div>
      {cur && !intro && (
        <div className="subtitle" key={cur.ply}>
          <div>{describeMove(moves, cur.ply, startFen, who(cur), cast.style)}</div>
          <div className="sub2">
            {sanAt(cur.ply)}
            {curA && BADGE[curA.classification] && <span className={`cls ${curA.classification}`}> {BADGE[curA.classification]} {curA.classification}</span>}
          </div>
        </div>
      )}
      {intro && theme === 'expedition' && (
        <Prologue
          elo={match.stockfishElo}
          lifespan={lifespan ?? null}
          date={fmtDate(match.startedAt ?? match.createdAt)}
          onSkip={() => setIntro(false)}
        />
      )}
      {intro && theme !== 'expedition' && (
        <div className="titlecard">
          <div className="t1">{KNIGHT}</div>
          <div className="t2">{cast.versus}</div>
          <div className="t1">{DEATH}</div>
          <div className="t3">
            {engineName} against Stockfish at Elo {match.stockfishElo} · {fmtDate(match.startedAt ?? match.createdAt)}
          </div>
        </div>
      )}
      {atEnd && !intro && (
        <div className="titlecard ending">
          <div className="t1">{cast.result[match.outcome!]}</div>
          <div className="t3">
            {match.result} {match.termination && <>· by {match.termination}</>}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className={`match theme-${theme}`}>
      <div className="match-head">
        <h2>
          {white} <span className="vs">vs</span> {black}
        </h2>
        <p className="muted">
          <b>{match.result ?? '*'}</b> {match.outcome && <span className={`tag ${match.outcome}`}>{match.outcome}</span>}{' '}
          {match.termination && <span>by {match.termination}</span>} · {match.status} · {fmtDate(match.startedAt ?? match.createdAt)} ·{' '}
          <a href={pgnUrl(match.id)} download={`${match.id}.pgn`}>
            PGN
          </a>
          {active && (
            <>
              {' '}
              · <button onClick={() => api.abortMatch(match.id).catch((e: Error) => alert(e.message))}>Abort</button>
            </>
          )}
        </p>
      </div>

      <div className="replay">
        <div className="replay-main">
          {view === '2d' ? (
            <div className="board2d">
              <Board fen={fen} lastMoveUci={cur?.uci} orientation={orientation} arrowUci={nextBest} size={520} />
            </div>
          ) : theme === 'expedition' ? (
            <Suspense fallback={<div className="stage exp" />}>
              <ExpeditionStage
                moves={moves}
                ply={ply}
                startFen={startFen}
                captured={captured[ply] ?? { w: [], b: [] }}
                ourColor={match.engineColor}
                view={view}
                animMs={liveMs}
                cinematic={duels}
                cameraReset={cameraReset}
                monolith={String(match.stockfishElo)}
                thinking={thinkingSide}
                onAnimate={(ms) => (busyUntil.current = performance.now() + ms)}
                onUnsupported={() => chooseView('2d')}
              >
                {overlay}
              </ExpeditionStage>
            </Suspense>
          ) : (
            <Suspense fallback={<div className="stage" />}>
              <SealStage
                moves={moves}
                ply={ply}
                startFen={startFen}
                captured={captured[ply] ?? { w: [], b: [] }}
                ourColor={match.engineColor}
                view={view}
                animMs={liveMs}
                thinking={thinkingSide}
                onUnsupported={() => chooseView('2d')}
              >
                {overlay}
              </SealStage>
            </Suspense>
          )}
          <div className="controls">
            <button onClick={() => step(0)} title="Start (Home)">⏮</button>
            <button onClick={() => step(ply - 1)} title="Back (←)">◀</button>
            <button onClick={() => step(ply + 1)} title="Forward (→)">▶</button>
            <button onClick={() => step(n)} title="End (End)">⏭</button>
            <button className="primary" onClick={() => (ply >= n ? (goto(0), setAutoplay(true)) : setAutoplay((a) => !a))}>
              {autoplay ? 'Pause' : 'Play'}
            </button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Autoplay speed">
              <option value={3000}>slow</option>
              <option value={2000}>calm</option>
              <option value={1000}>brisk</option>
              <option value={500}>fast</option>
            </select>
            <span className="spacer" />
            <div className="seg" role="group" aria-label="View">
              {(['shoulder', 'above', '2d'] as const).map((v) => (
                <button key={v} className={view === v ? 'on' : ''} onClick={() => chooseView(v)}>
                  {cast.views[v]}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Stage">
              {(['expedition', 'seal'] as const).map((t) => (
                <button key={t} className={theme === t ? 'on' : ''} onClick={() => chooseTheme(t)}>
                  {t === 'expedition' ? 'Expedition' : 'Seventh Seal'}
                </button>
              ))}
            </div>
            {theme === 'expedition' && view === 'shoulder' && (
              <button onClick={() => setCameraReset((n) => n + 1)} title="Drag to orbit, right-drag or shift-drag to pan, scroll to zoom. Your view is remembered.">
                Reset camera
              </button>
            )}
            {theme === 'expedition' && view !== '2d' && (
              <button className={duels ? 'on' : ''} onClick={toggleDuels} title="Cinematic duel camera and slow motion for captures">
                Duels {duels ? 'on' : 'off'}
              </button>
            )}
            {theme === 'expedition' && (
              <button className={music ? 'on' : ''} onClick={toggleMusic} title="Play the soundtrack while the game plays">
                Music {music ? 'on' : 'off'}
              </button>
            )}
            {view === '2d' && <button onClick={() => setFlipped((f) => !f)}>Flip</button>}
          </div>
        </div>

        <div className="side">
          <MoveList moves={moves} ply={ply} byPly={byPly} onJump={(p) => step(p, 0)} />
          {byPly.size > 0 && <EvalGraph analysis={[...byPly.values()]} plies={n} ply={ply} onJump={(p) => step(p, 0)} />}
          {cur && (
            <div className="panel">
              <b>{sanAt(cur.ply)}</b> by {who(cur)} in {(cur.timeMs / 1000).toFixed(1)} s
              {cur.thinking && (
                <div className="muted">
                  depth {cur.thinking.depth} · score {fmtEval(cur.thinking.scoreCp, cur.thinking.mateIn)} (mover)
                  {cur.thinking.nps ? ` · ${Math.round(cur.thinking.nps / 1000)} knps` : ''}
                </div>
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
          {thinking && active && (
            <div className="panel muted">
              {thinking.side === 'engine' ? KNIGHT : DEATH}: depth {thinking.thinking.depth ?? '?'} · score{' '}
              {fmtEval(thinking.thinking.scoreCp, thinking.thinking.mateIn)}
              {thinking.thinking.nodes ? ` · ${thinking.thinking.nodes} nodes` : ''}
              {thinking.thinking.pv?.length ? ` · pv ${thinking.thinking.pv.slice(0, 6).join(' ')}` : ''}
            </div>
          )}
          <p className="muted small">
            ← → step · Home / End ·{' '}
            {theme === 'expedition' ? 'every capture is fought out as a duel. Drag the stage to orbit, right-drag to pan, scroll to zoom.' : 'the players play each move forward.'}
          </p>
        </div>
      </div>

      <AnalysisSection
        match={match}
        analysis={analysis}
        status={aStatus}
        error={analysisError}
        sanAt={sanAt}
        onJump={(p) => step(p, 0)}
        onRerun={() => api.rerunAnalysis(match.id).then(setAnalysis).catch((e: Error) => alert(e.message))}
      />
      {theme === 'expedition' && music && (
        <section className="soundtrack">
          <h3>Soundtrack</h3>
          <MusicPlayer {...MUSIC} playing={autoplay || (live && follow && active)} />
        </section>
      )}
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

/**
 * The Expedition prologue: five beats before the game begins, in our own words. The Paintress's
 * number is a limit on how long Lumière's people ("petals") may live; every Expedition that beats
 * her raises it. The limit shown is the highest Stockfish Elo ever beaten; this year's Expedition
 * sails for the Elo of this match.
 */
function Prologue({ elo, lifespan, date, onSkip }: { elo: number; lifespan: number | null; date: string; onSkip: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') onSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);
  const beat = (i: number) => ({ animationDelay: `${BEAT_AT[i]}ms`, animationDuration: `${BEATS_MS[i]}ms` });
  return (
    <div className="prologue" onClick={onSkip} role="dialog" aria-label="Prologue">
      <div className="beat" style={beat(0)}>
        <p className="kicker">Lumière</p>
        <p className="line">Once every year, the Paintress wakes and paints a number on her Monolith.</p>
        <p className="line dim">No petal of Lumière may live a year beyond it.</p>
      </div>
      <div className="beat" style={beat(1)}>
        <p className="line">But whenever an Expedition beats her, the number climbs, and every petal lives a little longer.</p>
      </div>
      <div className="beat" style={beat(2)}>
        {lifespan ? (
          <>
            <p className="kicker">Thanks to those who sailed before</p>
            <p className="line">the petals of Lumière may now live</p>
            <p className="number">{lifespan}</p>
            <p className="line dim">years.</p>
          </>
        ) : (
          <>
            <p className="kicker">Every Expedition so far</p>
            <p className="line">has fallen. The number has never moved.</p>
          </>
        )}
      </div>
      <div className="beat" style={beat(3)}>
        <p className="kicker">This year the Expedition sails for</p>
        <p className="number small">{elo}</p>
        <p className="line">Ivory and gold, spear and rapier, and a mind of their own making.</p>
      </div>
      <div className="beat last" style={{ animationDelay: `${LAST_BEAT_AT}ms` }}>
        <p className="question">Will this be the year Lumière wins?</p>
        <p className="kicker">The board is set · {date}</p>
      </div>
      <button className="skip" onClick={onSkip}>
        Skip ›
      </button>
    </div>
  );
}
