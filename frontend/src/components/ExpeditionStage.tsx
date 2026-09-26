import { useEffect, useRef, type ReactNode } from 'react';
import type { Move } from '../api/client';
import { fenBefore } from '../chess';
import type { Captured, Side, View } from '../scene/SealScene';
import { ExpeditionScene } from '../scene/expedition/ExpeditionScene';

export interface ExpeditionStageProps {
  moves: Move[];
  ply: number;
  startFen: string;
  captured: Captured;
  ourColor: Side;
  view: View;
  /** Base duration of a move when stepping one ply forward; 0 = snap. Captures take longer. */
  animMs: number;
  /** Cut to a duel camera with slow motion for every capture. */
  cinematic: boolean;
  /** Painted on the Monolith on the horizon. */
  monolith: string;
  thinking: 'engine' | 'stockfish' | null;
  /** Bump to put the Battle camera back to its default (and forget the saved one). */
  cameraReset?: number;
  /** Reports how long the move that just started will take to play out (ms). */
  onAnimate?: (ms: number) => void;
  onUnsupported: () => void;
  children?: ReactNode;
}

/** The Expedition battlefield: armed pieces, and every capture is a duel. */
export function ExpeditionStage(props: ExpeditionStageProps) {
  const { moves, ply, startFen, captured, ourColor, view, animMs, cinematic, monolith, thinking, cameraReset, onAnimate, onUnsupported, children } = props;
  const el = useRef<HTMLDivElement>(null);
  const scene = useRef<ExpeditionScene | null>(null);
  const shown = useRef<{ ply: number; color: Side } | null>(null);

  useEffect(() => {
    try {
      scene.current = new ExpeditionScene(el.current!);
      if (import.meta.env.DEV) (window as unknown as { __exp?: ExpeditionScene }).__exp = scene.current;
    } catch (e) {
      console.error('WebGL scene failed', e);
      onUnsupported();
    }
    return () => {
      scene.current?.dispose();
      scene.current = null;
      shown.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => scene.current?.setView(view), [view]);
  useEffect(() => scene.current?.setThinking(thinking), [thinking]);
  useEffect(() => scene.current?.setCinematic(cinematic), [cinematic]);
  useEffect(() => scene.current?.setMonolith(monolith), [monolith]);
  const resetSeen = useRef(cameraReset);
  useEffect(() => {
    if (cameraReset === resetSeen.current) return;
    resetSeen.current = cameraReset;
    scene.current?.resetCamera();
  }, [cameraReset]);

  const cur = ply > 0 ? moves[ply - 1] : undefined;
  const fen = cur?.fenAfter ?? startFen;
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    const prev = shown.current;
    s.setOrientation(ourColor);
    let ms = 0;
    if (prev && prev.color === ourColor && ply === prev.ply + 1 && cur && animMs > 0) {
      ms = s.playMove(fenBefore(moves, ply, startFen), cur.uci, cur.fenAfter, captured, animMs);
    } else {
      s.setPosition(fen, captured, cur?.uci);
    }
    onAnimate?.(ms);
    shown.current = { ply, color: ourColor };
    // captured/moves are derived from the same data as fen/ply
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, fen, ourColor]);

  return (
    <div className="stage exp">
      <div className="stage-canvas" ref={el} />
      {children}
    </div>
  );
}
