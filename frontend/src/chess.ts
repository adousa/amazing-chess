// Client-side chess helpers over the contract's Move list (captures, subtitles).
import { Chess } from 'chess.js';
import type { Move } from './api/client';
import type { Captured } from './scene/SealScene';
import type { PieceType } from './scene/pieces';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const NAME: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export const fenBefore = (moves: Move[], ply: number, startFen: string) => (ply >= 2 ? moves[ply - 2].fenAfter : startFen);

function play(fen: string, uci: string) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return null;
  }
}

/** capturedAt[p] = pieces off the board after ply p (index 0 = start position). */
export function capturedByPly(moves: Move[], startFen: string): Captured[] {
  const out: Captured[] = [{ w: [], b: [] }];
  moves.forEach((m, i) => {
    const prev = out[i];
    const next: Captured = { w: [...prev.w], b: [...prev.b] };
    const mv = play(fenBefore(moves, i + 1, startFen), m.uci);
    if (mv?.captured) next[mv.color === 'w' ? 'b' : 'w'].push(mv.captured as PieceType);
    out.push(next);
  });
  return out;
}

/** A spoken-style subtitle: "Death takes the pawn on e4 with the knight. Check." */
export function describeMove(moves: Move[], ply: number, startFen: string, who: string): string {
  const m = moves[ply - 1];
  if (!m) return '';
  const mv = play(fenBefore(moves, ply, startFen), m.uci);
  if (!mv) return `${who} plays ${m.san}.`;
  let s: string;
  if (mv.flags.includes('k')) s = `${who} castles on the king's side`;
  else if (mv.flags.includes('q')) s = `${who} castles on the queen's side`;
  else if (mv.captured) s = `${who} takes the ${NAME[mv.captured]} on ${mv.to} with the ${NAME[mv.piece]}`;
  else s = `${who} moves the ${NAME[mv.piece]} to ${mv.to}`;
  if (mv.promotion) s += `, and it becomes a ${NAME[mv.promotion]}`;
  return s + (m.san.includes('#') ? '. Checkmate.' : m.san.includes('+') ? '. Check.' : '.');
}
