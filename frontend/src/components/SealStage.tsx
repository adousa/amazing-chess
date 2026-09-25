import { useEffect, useRef, type ReactNode } from 'react';
import type { Move } from '../api/client';
import { fenBefore } from '../chess';
import { SealScene, type Captured, type Side, type View } from '../scene/SealScene';

export interface SealStageProps {
  moves: Move[];
  ply: number;
  startFen: string;
  captured: Captured;
  ourColor: Side;
  view: View;
  /** Duration of the move animation when stepping one ply forward; 0 = snap. */
  animMs: number;
  thinking: 'engine' | 'stockfish' | null;
  /** Called when WebGL is not available, so the page can fall back to the 2D board. */
  onUnsupported: () => void;
  children?: ReactNode;
}

/** The Seventh Seal beach with the two players; one ply forward is played out by hand. */
export function SealStage({ moves, ply, startFen, captured, ourColor, view, animMs, thinking, onUnsupported, children }: SealStageProps) {
  const el = useRef<HTMLDivElement>(null);
  const scene = useRef<SealScene | null>(null);
  const shown = useRef<{ ply: number; color: Side } | null>(null);

  useEffect(() => {
    try {
      scene.current = new SealScene(el.current!);
      if (import.meta.env.DEV) (window as unknown as { __seal?: SealScene }).__seal = scene.current;
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

  const cur = ply > 0 ? moves[ply - 1] : undefined;
  const fen = cur?.fenAfter ?? startFen;
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    const prev = shown.current;
    s.setOrientation(ourColor);
    if (prev && prev.color === ourColor && ply === prev.ply + 1 && cur && animMs > 0) {
      s.playMove(fenBefore(moves, ply, startFen), cur.uci, cur.fenAfter, captured, animMs);
    } else {
      s.setPosition(fen, captured, cur?.uci);
    }
    shown.current = { ply, color: ourColor };
    // captured/moves are derived from the same data as fen/ply
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, fen, ourColor]);

  return (
    <div className="stage">
      <div className="stage-canvas" ref={el} />
      {children}
    </div>
  );
}
