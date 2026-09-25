//! Pseudo-legal move generation (+ legal filter) and perft.

use crate::bitboard::*;
use crate::position::*;
use crate::types::*;

/// Generate pseudo-legal moves. If `noisy_only`, only captures and queen promotions.
/// Castling moves are always fully legal when generated.
pub fn generate(pos: &Position, list: &mut MoveList, noisy_only: bool) {
    let us = pos.stm;
    let them = us ^ 1;
    let occ = pos.occupied();
    let own = pos.by_color[us];
    let enemy = pos.by_color[them];
    let targets = if noisy_only { enemy } else { !own };

    // ---- Pawns ----
    let pawns = pos.pieces(us, PAWN);
    let (up, promo_rank, third_rank): (i32, u64, u64) =
        if us == WHITE { (8, RANK_8, RANK_3) } else { (-8, RANK_1, RANK_6) };
    let shift = |b: u64, d: i32| -> u64 {
        if d > 0 {
            b << d
        } else {
            b >> (-d)
        }
    };
    let empty = !occ;
    let single = shift(pawns, up) & empty;
    let double = shift(single & third_rank, up) & empty;
    // captures towards file-a side (west) and file-h side (east)
    let (west, east) = if us == WHITE {
        (((pawns & !FILE_A) << 7) & enemy, ((pawns & !FILE_H) << 9) & enemy)
    } else {
        (((pawns & !FILE_A) >> 9) & enemy, ((pawns & !FILE_H) >> 7) & enemy)
    };
    let (west_d, east_d) = if us == WHITE { (7, 9) } else { (-9, -7) };

    // promotions
    let mut b = single & promo_rank;
    while b != 0 {
        let to = pop_lsb(&mut b);
        let from = (to as i32 - up) as usize;
        list.push(Move::new(from, to, FLAG_PROMO + 3));
        if !noisy_only {
            list.push(Move::new(from, to, FLAG_PROMO));
            list.push(Move::new(from, to, FLAG_PROMO + 1));
            list.push(Move::new(from, to, FLAG_PROMO + 2));
        }
    }
    for (caps, d) in [(west, west_d), (east, east_d)] {
        let mut b = caps & promo_rank;
        while b != 0 {
            let to = pop_lsb(&mut b);
            let from = (to as i32 - d) as usize;
            list.push(Move::new(from, to, FLAG_PROMO_CAPTURE + 3));
            if !noisy_only {
                list.push(Move::new(from, to, FLAG_PROMO_CAPTURE));
                list.push(Move::new(from, to, FLAG_PROMO_CAPTURE + 1));
                list.push(Move::new(from, to, FLAG_PROMO_CAPTURE + 2));
            }
        }
        let mut b = caps & !promo_rank;
        while b != 0 {
            let to = pop_lsb(&mut b);
            let from = (to as i32 - d) as usize;
            list.push(Move::new(from, to, FLAG_CAPTURE));
        }
    }
    if pos.ep != NO_SQ {
        let ep = pos.ep as usize;
        let mut b = pawn_attacks(them, ep) & pawns;
        while b != 0 {
            let from = pop_lsb(&mut b);
            list.push(Move::new(from, ep, FLAG_EP));
        }
    }
    if !noisy_only {
        let mut b = single & !promo_rank;
        while b != 0 {
            let to = pop_lsb(&mut b);
            list.push(Move::new((to as i32 - up) as usize, to, FLAG_QUIET));
        }
        let mut b = double;
        while b != 0 {
            let to = pop_lsb(&mut b);
            list.push(Move::new((to as i32 - 2 * up) as usize, to, FLAG_DOUBLE_PUSH));
        }
    }

    // ---- Pieces ----
    for pt in KNIGHT..=KING {
        let mut pcs = pos.pieces(us, pt);
        while pcs != 0 {
            let from = pop_lsb(&mut pcs);
            let mut att = piece_attacks(pt, from, occ) & targets;
            while att != 0 {
                let to = pop_lsb(&mut att);
                let flag = if enemy & bb(to) != 0 { FLAG_CAPTURE } else { FLAG_QUIET };
                list.push(Move::new(from, to, flag));
            }
        }
    }

    // ---- Castling ----
    if !noisy_only && pos.castling != 0 && pos.checkers == 0 {
        if us == WHITE {
            if pos.castling & CASTLE_WK != 0
                && occ & (bb(5) | bb(6)) == 0
                && !pos.is_attacked(5, them, occ)
                && !pos.is_attacked(6, them, occ)
            {
                list.push(Move::new(4, 6, FLAG_KING_CASTLE));
            }
            if pos.castling & CASTLE_WQ != 0
                && occ & (bb(1) | bb(2) | bb(3)) == 0
                && !pos.is_attacked(3, them, occ)
                && !pos.is_attacked(2, them, occ)
            {
                list.push(Move::new(4, 2, FLAG_QUEEN_CASTLE));
            }
        } else {
            if pos.castling & CASTLE_BK != 0
                && occ & (bb(61) | bb(62)) == 0
                && !pos.is_attacked(61, them, occ)
                && !pos.is_attacked(62, them, occ)
            {
                list.push(Move::new(60, 62, FLAG_KING_CASTLE));
            }
            if pos.castling & CASTLE_BQ != 0
                && occ & (bb(57) | bb(58) | bb(59)) == 0
                && !pos.is_attacked(59, them, occ)
                && !pos.is_attacked(58, them, occ)
            {
                list.push(Move::new(60, 58, FLAG_QUEEN_CASTLE));
            }
        }
    }
}

/// Generate fully legal moves.
pub fn generate_legal(pos: &Position, list: &mut MoveList) {
    let mut pseudo = MoveList::new();
    generate(pos, &mut pseudo, false);
    let pinned = pos.pinned();
    list.len = 0;
    for &m in pseudo.iter() {
        if pos.is_legal(m, pinned) {
            list.push(m);
        }
    }
}

pub fn perft(pos: &Position, depth: u32) -> u64 {
    let mut list = MoveList::new();
    generate(pos, &mut list, false);
    let pinned = pos.pinned();
    if depth == 1 {
        return list.iter().filter(|&&m| pos.is_legal(m, pinned)).count() as u64;
    }
    let mut nodes = 0;
    for &m in list.iter() {
        if !pos.is_legal(m, pinned) {
            continue;
        }
        let mut child = *pos;
        child.make_move(m);
        nodes += perft(&child, depth - 1);
    }
    nodes
}

/// Perft with per-move breakdown printed to stdout. Returns total.
pub fn perft_divide(pos: &Position, depth: u32) -> u64 {
    let mut list = MoveList::new();
    generate_legal(pos, &mut list);
    let mut total = 0;
    for &m in list.iter() {
        let n = if depth <= 1 {
            1
        } else {
            let mut child = *pos;
            child.make_move(m);
            perft(&child, depth - 1)
        };
        println!("{}: {}", m.to_uci(), n);
        total += n;
    }
    total
}
