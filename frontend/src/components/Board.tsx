import { useEffect, useRef } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import { Chess, validateFen } from 'chess.js';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';

export interface BoardProps {
  fen: string;
  /** UCI of the move that led to `fen` (for last-move highlight). */
  lastMoveUci?: string;
  orientation: 'white' | 'black';
  /** Optional arrow, e.g. best move in UCI. */
  arrowUci?: string;
  size?: number;
}

const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';
const sq = (uci: string, i: number) => uci.slice(i, i + 2) as Key;

/** Read-only chessground board driven entirely by props. */
export function Board({ fen, lastMoveUci, orientation, arrowUci, size = 480 }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const cg = useRef<Api | null>(null);

  useEffect(() => {
    if (!el.current) return;
    cg.current = Chessground(el.current, { viewOnly: true, coordinates: true, animation: { enabled: true, duration: 200 } });
    return () => {
      cg.current?.destroy();
      cg.current = null;
    };
  }, []);

  const valid = validateFen(fen).ok;

  useEffect(() => {
    let check = false;
    let turnColor: 'white' | 'black' = 'white';
    try {
      const c = new Chess(fen);
      check = c.inCheck();
      turnColor = c.turn() === 'w' ? 'white' : 'black';
    } catch {
      /* invalid FEN: still let chessground try to render the placement */
    }
    const shapes: DrawShape[] =
      arrowUci && arrowUci.length >= 4 ? [{ orig: sq(arrowUci, 0), dest: sq(arrowUci, 2), brush: 'green' }] : [];
    cg.current?.set({
      fen: valid ? fen : EMPTY_FEN,
      orientation,
      turnColor,
      check: check ? turnColor : false,
      lastMove: lastMoveUci && lastMoveUci.length >= 4 ? [sq(lastMoveUci, 0), sq(lastMoveUci, 2)] : undefined,
    });
    cg.current?.setAutoShapes(shapes);
  }, [fen, valid, lastMoveUci, orientation, arrowUci]);

  return (
    <div>
      <div ref={el} style={{ width: size, height: size }} />
      {!valid && <p className="error">Invalid FEN from API: {fen}</p>}
    </div>
  );
}
