//! Evaluation: PeSTO tapered material + piece-square tables (incrementally
//! maintained in `Position`) plus cheap handcrafted terms: bishop pair, pawn
//! structure, passed pawns, rooks on open files, mobility, king safety,
//! endgame scaling and a "mop-up" term for converting won pawnless endings.

use crate::bitboard::*;
use crate::position::Position;
use crate::types::*;

pub const PHASE_INC: [i32; 6] = [0, 1, 1, 2, 4, 0];

const MG_VALUE: [i32; 6] = [82, 337, 365, 477, 1025, 0];
const EG_VALUE: [i32; 6] = [94, 281, 297, 512, 936, 0];

// PeSTO tables, a8 = index 0 (rank 8 first), from White's point of view.
#[rustfmt::skip]
const MG_PST: [[i32; 64]; 6] = [
    [ // pawn
      0,   0,   0,   0,   0,   0,  0,   0,
     98, 134,  61,  95,  68, 126, 34, -11,
     -6,   7,  26,  31,  65,  56, 25, -20,
    -14,  13,   6,  21,  23,  12, 17, -23,
    -27,  -2,  -5,  12,  17,   6, 10, -25,
    -26,  -4,  -4, -10,   3,   3, 33, -12,
    -35,  -1, -20, -23, -15,  24, 38, -22,
      0,   0,   0,   0,   0,   0,  0,   0,
    ],
    [ // knight
    -167, -89, -34, -49,  61, -97, -15, -107,
     -73, -41,  72,  36,  23,  62,   7,  -17,
     -47,  60,  37,  65,  84, 129,  73,   44,
      -9,  17,  19,  53,  37,  69,  18,   22,
     -13,   4,  16,  13,  28,  19,  21,   -8,
     -23,  -9,  12,  10,  19,  17,  25,  -16,
     -29, -53, -12,  -3,  -1,  18, -14,  -19,
    -105, -21, -58, -33, -17, -28, -19,  -23,
    ],
    [ // bishop
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21,
    ],
    [ // rook
     32,  42,  32,  51, 63,  9,  31,  43,
     27,  32,  58,  62, 80, 67,  26,  44,
     -5,  19,  26,  36, 17, 45,  61,  16,
    -24, -11,   7,  26, 24, 35,  -8, -20,
    -36, -26, -12,  -1,  9, -7,   6, -23,
    -45, -25, -16, -17,  3,  0,  -5, -33,
    -44, -16, -20,  -9, -1, 11,  -6, -71,
    -19, -13,   1,  17, 16,  7, -37, -26,
    ],
    [ // queen
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50,
    ],
    [ // king
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49,  -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14,
    ],
];

#[rustfmt::skip]
const EG_PST: [[i32; 64]; 6] = [
    [ // pawn
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0,
    ],
    [ // knight
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
    ],
    [ // bishop
    -14, -21, -11,  -8, -7,  -9, -17, -24,
     -8,  -4,   7, -12, -3, -13,  -4, -14,
      2,  -8,   0,  -1, -2,   6,   0,   4,
     -3,   9,  12,   9, 14,  10,   3,   2,
     -6,   3,  13,  19,  7,  10,  -3,  -9,
    -12,  -3,   8,  10, 13,   3,  -7, -15,
    -14, -18,  -7,  -1,  4,  -9, -15, -27,
    -23,  -9, -23,  -5, -9, -16,  -5, -17,
    ],
    [ // rook
    13, 10, 18, 15, 12,  12,   8,   5,
    11, 13, 13, 11, -3,   3,   8,   3,
     7,  7,  7,  5,  4,  -3,  -5,  -3,
     4,  3, 13,  1,  2,   1,  -1,   2,
     3,  5,  8,  4, -5,  -6,  -8, -11,
    -4,  0, -5, -1, -7, -12,  -8, -16,
    -6, -6,  0,  2, -9,  -9, -11,  -3,
    -9,  2,  3, -1, -5, -13,   4, -20,
    ],
    [ // queen
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  39,  23,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41,
    ],
    [ // king
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43,
    ],
];

const fn build(pst: &[[i32; 64]; 6], val: &[i32; 6]) -> [[i32; 64]; 12] {
    let mut t = [[0i32; 64]; 12];
    let mut pt = 0;
    while pt < 6 {
        let mut sq = 0;
        while sq < 64 {
            // White piece on a1-indexed `sq` uses row-flipped index; Black uses `sq` directly.
            t[pt][sq] = val[pt] + pst[pt][sq ^ 56];
            t[pt + 6][sq] = val[pt] + pst[pt][sq];
            sq += 1;
        }
        pt += 1;
    }
    t
}

static MG_TABLE: [[i32; 64]; 12] = build(&MG_PST, &MG_VALUE);
static EG_TABLE: [[i32; 64]; 12] = build(&EG_PST, &EG_VALUE);

/// Material + PST (from the piece owner's point of view).
#[inline(always)]
pub fn psq_mg(pc: u8, sq: Square) -> i32 {
    MG_TABLE[pc as usize][sq]
}
#[inline(always)]
pub fn psq_eg(pc: u8, sq: Square) -> i32 {
    EG_TABLE[pc as usize][sq]
}

// ---------------------------------------------------------------------------
// Extra terms (mg, eg)
// ---------------------------------------------------------------------------
const BISHOP_PAIR: (i32, i32) = (25, 50);
const PASSED_MG: [i32; 8] = [0, 0, 0, 5, 15, 30, 50, 0];
const PASSED_EG: [i32; 8] = [0, 5, 10, 20, 35, 60, 90, 0];
const DOUBLED: (i32, i32) = (-8, -18);
const ISOLATED: (i32, i32) = (-10, -10);
const ROOK_OPEN: (i32, i32) = (25, 10);
const ROOK_SEMI: (i32, i32) = (12, 6);
const TEMPO: i32 = 12;
// mobility per safe square relative to an average count
const MOB_CENTER: [i32; 6] = [0, 4, 6, 7, 13, 0];
const MOB_MG: [i32; 6] = [0, 4, 4, 2, 1, 0];
const MOB_EG: [i32; 6] = [0, 4, 5, 4, 2, 0];
// king safety: attack units per attacked zone square, and scaling by attacker count
const KS_UNITS: [i32; 6] = [0, 20, 20, 40, 80, 0];
const KS_WEIGHT: [i32; 8] = [0, 0, 50, 75, 88, 94, 97, 99];

/// Simple non-pawn material count used for scaling decisions.
const NPM_VALUE: [i32; 6] = [0, 325, 325, 500, 900, 0];

#[inline]
fn npm(pos: &Position, c: usize) -> i32 {
    let mut s = 0;
    for pt in KNIGHT..=QUEEN {
        s += NPM_VALUE[pt] * popcount(pos.pieces(c, pt)) as i32;
    }
    s
}

#[inline]
fn manhattan(a: Square, b: Square) -> i32 {
    (file_of(a) as i32 - file_of(b) as i32).abs() + (rank_of(a) as i32 - rank_of(b) as i32).abs()
}

#[inline]
fn center_distance(sq: Square) -> i32 {
    let f = file_of(sq) as i32;
    let r = rank_of(sq) as i32;
    (if f < 4 { 3 - f } else { f - 4 }) + (if r < 4 { 3 - r } else { r - 4 })
}

/// Squares in front of a pawn (same and adjacent files) that must be free of
/// enemy pawns for it to be passed.
#[inline]
fn passed_mask(color: usize, sq: Square) -> u64 {
    let f = file_of(sq);
    let mut files = file_bb(f);
    if f > 0 {
        files |= file_bb(f - 1);
    }
    if f < 7 {
        files |= file_bb(f + 1);
    }
    let r = rank_of(sq);
    if color == WHITE {
        if r >= 7 {
            0
        } else {
            files & (!0u64 << ((r + 1) * 8))
        }
    } else if r == 0 {
        0
    } else {
        files & ((1u64 << (r * 8)) - 1)
    }
}

/// Evaluate one side: returns (mg, eg) from `us` point of view (non-PST terms).
#[inline]
fn eval_side(pos: &Position, us: usize, attacks_them_pawns: u64) -> (i32, i32) {
    let them = us ^ 1;
    let occ = pos.occupied();
    let own = pos.by_color[us];
    let my_pawns = pos.pieces(us, PAWN);
    let their_pawns = pos.pieces(them, PAWN);
    let mut mg = 0;
    let mut eg = 0;

    if popcount(pos.pieces(us, BISHOP)) >= 2 {
        mg += BISHOP_PAIR.0;
        eg += BISHOP_PAIR.1;
    }

    // Pawn structure
    let mut p = my_pawns;
    while p != 0 {
        let sq = pop_lsb(&mut p);
        let f = file_of(sq);
        let mut adj = 0u64;
        if f > 0 {
            adj |= file_bb(f - 1);
        }
        if f < 7 {
            adj |= file_bb(f + 1);
        }
        if adj & my_pawns == 0 {
            mg += ISOLATED.0;
            eg += ISOLATED.1;
        }
        if passed_mask(us, sq) & their_pawns == 0 {
            // not passed if an own pawn is directly in front (count only the front-most)
            let front = if us == WHITE {
                file_bb(f) & (!0u64 << ((rank_of(sq) + 1).min(7) * 8))
            } else {
                file_bb(f) & ((1u64 << (rank_of(sq) * 8)) - 1)
            };
            if front & my_pawns == 0 {
                let rr = relative_rank(us, sq);
                mg += PASSED_MG[rr];
                eg += PASSED_EG[rr];
                // bonus if the stop square is free, extra in the endgame
                let stop = if us == WHITE { sq + 8 } else { sq - 8 };
                if stop < 64 && occ & bb(stop) == 0 {
                    eg += PASSED_EG[rr] / 4;
                }
                // king proximity in the endgame
                let their_k = pos.king_sq(them);
                let my_k = pos.king_sq(us);
                if stop < 64 {
                    eg += (manhattan(their_k, stop) - manhattan(my_k, stop)) * (rr as i32) * 2;
                }
            }
        }
    }
    for f in 0..8 {
        let n = popcount(my_pawns & file_bb(f)) as i32;
        if n > 1 {
            mg += DOUBLED.0 * (n - 1);
            eg += DOUBLED.1 * (n - 1);
        }
    }

    // Pieces: mobility, rook files, king attacks
    let their_king = pos.king_sq(them);
    let king_zone = king_attacks(their_king) | bb(their_king);
    let king_zone = king_zone
        | if them == WHITE { king_zone << 8 } else { king_zone >> 8 };
    let safe = !own & !attacks_them_pawns;
    let mut ks_units = 0;
    let mut ks_count = 0;
    for pt in KNIGHT..=QUEEN {
        let mut pcs = pos.pieces(us, pt);
        while pcs != 0 {
            let sq = pop_lsb(&mut pcs);
            let att = match pt {
                KNIGHT => knight_attacks(sq),
                // x-ray through own queens/rooks for sliders
                BISHOP => bishop_attacks(sq, occ ^ pos.pieces(us, QUEEN)),
                ROOK => rook_attacks(sq, occ ^ pos.pieces(us, QUEEN) ^ pos.pieces(us, ROOK)),
                _ => queen_attacks(sq, occ),
            };
            let mob = popcount(att & safe) as i32 - MOB_CENTER[pt];
            mg += mob * MOB_MG[pt];
            eg += mob * MOB_EG[pt];
            let z = att & king_zone;
            if z != 0 {
                ks_count += 1;
                ks_units += KS_UNITS[pt] * popcount(z) as i32;
            }
            if pt == ROOK {
                let fb = file_bb(file_of(sq));
                if fb & my_pawns == 0 {
                    if fb & their_pawns == 0 {
                        mg += ROOK_OPEN.0;
                        eg += ROOK_OPEN.1;
                    } else {
                        mg += ROOK_SEMI.0;
                        eg += ROOK_SEMI.1;
                    }
                }
            }
        }
    }
    if pos.pieces(us, QUEEN) != 0 {
        let w = KS_WEIGHT[ks_count.min(7)];
        mg += ks_units * w / 100 / 2;
    }
    (mg, eg)
}

/// Static evaluation in centipawns from the side to move's point of view.
pub fn evaluate(pos: &Position) -> i32 {
    let wp = pos.pieces(WHITE, PAWN);
    let bp = pos.pieces(BLACK, PAWN);
    let w_patt = pawn_attacks_bb(WHITE, wp);
    let b_patt = pawn_attacks_bb(BLACK, bp);

    let (wmg, weg) = eval_side(pos, WHITE, b_patt);
    let (bmg, beg) = eval_side(pos, BLACK, w_patt);
    let mg = pos.psq_mg + wmg - bmg;
    let eg = pos.psq_eg + weg - beg;
    let phase = pos.phase.min(24);
    let mut score = (mg * phase + eg * (24 - phase)) / 24;

    // Endgame scaling and mop-up (score is White-relative here).
    let strong = if score > 0 { WHITE } else { BLACK };
    let weak = strong ^ 1;
    let s_npm = npm(pos, strong);
    let w_npm = npm(pos, weak);
    let s_pawns = pos.pieces(strong, PAWN);
    if s_pawns == 0 {
        let only_knights = pos.pieces(strong, KNIGHT) != 0
            && s_npm == NPM_VALUE[KNIGHT] * popcount(pos.pieces(strong, KNIGHT)) as i32;
        if s_npm - w_npm < 400 || (only_knights && s_npm <= 650 && w_npm == 0 && pos.pieces(weak, PAWN) == 0) {
            score /= 8;
        }
    }
    if pos.pieces(weak, PAWN) == 0 && s_npm - w_npm >= 400 && w_npm <= 500 {
        let wk = pos.king_sq(weak);
        let sk = pos.king_sq(strong);
        let mop = 12 * center_distance(wk) + 5 * (14 - manhattan(wk, sk));
        score += if strong == WHITE { mop } else { -mop };
    }
    // Opposite-coloured bishops with only pawns otherwise: drawish.
    if phase <= 2
        && popcount(pos.pieces(WHITE, BISHOP)) == 1
        && popcount(pos.pieces(BLACK, BISHOP)) == 1
        && pos.by_type[KNIGHT] | pos.by_type[ROOK] | pos.by_type[QUEEN] == 0
    {
        let wb = pos.pieces(WHITE, BISHOP) & DARK_SQUARES != 0;
        let bb_ = pos.pieces(BLACK, BISHOP) & DARK_SQUARES != 0;
        if wb != bb_ {
            score /= 2;
        }
    }
    // Approach the 50-move rule: shrink the evaluation.
    if pos.halfmove > 20 {
        score = score * (120 - pos.halfmove as i32).max(0) / 100;
    }

    let stm_score = if pos.stm == WHITE { score } else { -score };
    stm_score + TEMPO
}
