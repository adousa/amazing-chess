//! Bitboard helpers, precomputed attack tables and magic bitboards.
//!
//! All tables are generated once at startup by [`init`] (magics are found with a
//! fixed-seed PRNG, so start-up is deterministic and takes a few milliseconds).
#![allow(static_mut_refs)]

use crate::types::*;
use std::sync::Once;

pub const FILE_A: u64 = 0x0101_0101_0101_0101;
pub const FILE_H: u64 = FILE_A << 7;
pub const RANK_1: u64 = 0xFF;
pub const RANK_2: u64 = RANK_1 << 8;
pub const RANK_3: u64 = RANK_1 << 16;
pub const RANK_6: u64 = RANK_1 << 40;
pub const RANK_7: u64 = RANK_1 << 48;
pub const RANK_8: u64 = RANK_1 << 56;
pub const DARK_SQUARES: u64 = 0xAA55_AA55_AA55_AA55;

#[inline(always)]
pub fn bb(sq: Square) -> u64 {
    1u64 << sq
}
#[inline(always)]
pub fn lsb(b: u64) -> Square {
    b.trailing_zeros() as usize
}
#[inline(always)]
pub fn pop_lsb(b: &mut u64) -> Square {
    let s = b.trailing_zeros() as usize;
    *b &= *b - 1;
    s
}
#[inline(always)]
pub fn popcount(b: u64) -> u32 {
    b.count_ones()
}
#[inline(always)]
pub fn more_than_one(b: u64) -> bool {
    b & b.wrapping_sub(1) != 0
}
#[inline(always)]
pub fn file_bb(f: usize) -> u64 {
    FILE_A << f
}

#[derive(Clone, Copy)]
struct Magic {
    mask: u64,
    magic: u64,
    shift: u32,
    offset: usize,
}

const EMPTY_MAGIC: Magic = Magic { mask: 0, magic: 0, shift: 0, offset: 0 };

static INIT: Once = Once::new();

static mut KNIGHT_ATT: [u64; 64] = [0; 64];
static mut KING_ATT: [u64; 64] = [0; 64];
static mut PAWN_ATT: [[u64; 64]; 2] = [[0; 64]; 2];
static mut BETWEEN: [[u64; 64]; 64] = [[0; 64]; 64];
static mut LINE: [[u64; 64]; 64] = [[0; 64]; 64];
static mut ROOK_MAGICS: [Magic; 64] = [EMPTY_MAGIC; 64];
static mut BISHOP_MAGICS: [Magic; 64] = [EMPTY_MAGIC; 64];
static mut ROOK_TABLE: [u64; 102_400] = [0; 102_400];
static mut BISHOP_TABLE: [u64; 5_248] = [0; 5_248];

// Zobrist keys
static mut Z_PIECE: [[u64; 64]; 12] = [[0; 64]; 12];
static mut Z_CASTLE: [u64; 16] = [0; 16];
static mut Z_EP: [u64; 8] = [0; 8];
static mut Z_SIDE: u64 = 0;

/// Initialise all global tables. Safe to call many times.
pub fn init() {
    INIT.call_once(|| unsafe { init_tables() });
}

#[inline(always)]
pub fn knight_attacks(sq: Square) -> u64 {
    unsafe { KNIGHT_ATT[sq] }
}
#[inline(always)]
pub fn king_attacks(sq: Square) -> u64 {
    unsafe { KING_ATT[sq] }
}
#[inline(always)]
pub fn pawn_attacks(color: usize, sq: Square) -> u64 {
    unsafe { PAWN_ATT[color][sq] }
}
/// Squares strictly between two aligned squares (0 if not aligned).
#[inline(always)]
pub fn between(a: Square, b: Square) -> u64 {
    unsafe { BETWEEN[a][b] }
}
/// Full line through two aligned squares (0 if not aligned).
#[inline(always)]
pub fn line(a: Square, b: Square) -> u64 {
    unsafe { LINE[a][b] }
}
#[inline(always)]
pub fn rook_attacks(sq: Square, occ: u64) -> u64 {
    unsafe {
        let m = ROOK_MAGICS.get_unchecked(sq);
        let idx = (((occ & m.mask).wrapping_mul(m.magic)) >> m.shift) as usize;
        *ROOK_TABLE.get_unchecked(m.offset + idx)
    }
}
#[inline(always)]
pub fn bishop_attacks(sq: Square, occ: u64) -> u64 {
    unsafe {
        let m = BISHOP_MAGICS.get_unchecked(sq);
        let idx = (((occ & m.mask).wrapping_mul(m.magic)) >> m.shift) as usize;
        *BISHOP_TABLE.get_unchecked(m.offset + idx)
    }
}
#[inline(always)]
pub fn queen_attacks(sq: Square, occ: u64) -> u64 {
    rook_attacks(sq, occ) | bishop_attacks(sq, occ)
}
/// Attacks of a non-pawn piece type from `sq`.
#[inline(always)]
pub fn piece_attacks(pt: usize, sq: Square, occ: u64) -> u64 {
    match pt {
        KNIGHT => knight_attacks(sq),
        BISHOP => bishop_attacks(sq, occ),
        ROOK => rook_attacks(sq, occ),
        QUEEN => queen_attacks(sq, occ),
        KING => king_attacks(sq),
        _ => 0,
    }
}

#[inline(always)]
pub fn z_piece(pc: u8, sq: Square) -> u64 {
    unsafe { Z_PIECE[pc as usize][sq] }
}
#[inline(always)]
pub fn z_castle(rights: u8) -> u64 {
    unsafe { Z_CASTLE[rights as usize] }
}
#[inline(always)]
pub fn z_ep(file: usize) -> u64 {
    unsafe { Z_EP[file] }
}
#[inline(always)]
pub fn z_side() -> u64 {
    unsafe { Z_SIDE }
}

#[inline(always)]
pub fn shift_north(b: u64) -> u64 {
    b << 8
}
#[inline(always)]
pub fn shift_south(b: u64) -> u64 {
    b >> 8
}

/// Squares attacked by all pawns of `color` in bitboard `pawns`.
#[inline(always)]
pub fn pawn_attacks_bb(color: usize, pawns: u64) -> u64 {
    if color == WHITE {
        ((pawns & !FILE_A) << 7) | ((pawns & !FILE_H) << 9)
    } else {
        ((pawns & !FILE_A) >> 9) | ((pawns & !FILE_H) >> 7)
    }
}

// ---------------------------------------------------------------------------
// Table generation
// ---------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn sparse(&mut self) -> u64 {
        self.next() & self.next() & self.next()
    }
}

fn slide_attacks(sq: Square, occ: u64, dirs: &[(i32, i32)]) -> u64 {
    let mut att = 0u64;
    let (r0, f0) = ((sq / 8) as i32, (sq % 8) as i32);
    for &(dr, df) in dirs {
        let (mut r, mut f) = (r0 + dr, f0 + df);
        while (0..8).contains(&r) && (0..8).contains(&f) {
            let s = (r * 8 + f) as usize;
            att |= 1u64 << s;
            if occ & (1u64 << s) != 0 {
                break;
            }
            r += dr;
            f += df;
        }
    }
    att
}

const ROOK_DIRS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
const BISHOP_DIRS: [(i32, i32); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

fn relevant_mask(sq: Square, dirs: &[(i32, i32)]) -> u64 {
    let mut mask = 0u64;
    let (r0, f0) = ((sq / 8) as i32, (sq % 8) as i32);
    for &(dr, df) in dirs {
        let (mut r, mut f) = (r0 + dr, f0 + df);
        // stop before the edge square in this direction
        while (0..8).contains(&(r + dr)) && (0..8).contains(&(f + df)) {
            mask |= 1u64 << (r * 8 + f);
            r += dr;
            f += df;
        }
    }
    mask
}

unsafe fn find_magics(
    rng: &mut Rng,
    dirs: &[(i32, i32)],
    magics: &mut [Magic; 64],
    table: &mut [u64],
) {
    let mut offset = 0usize;
    let mut occs = vec![0u64; 4096];
    let mut refs = vec![0u64; 4096];
    let mut epoch = vec![0u32; 4096];
    let mut used = vec![0u64; 4096];
    let mut cur_epoch = 0u32;
    for sq in 0..64 {
        let mask = relevant_mask(sq, dirs);
        let bits = mask.count_ones();
        let size = 1usize << bits;
        // enumerate subsets (carry-rippler)
        let mut n = 0usize;
        let mut sub = 0u64;
        loop {
            occs[n] = sub;
            refs[n] = slide_attacks(sq, sub, dirs);
            n += 1;
            sub = sub.wrapping_sub(mask) & mask;
            if sub == 0 {
                break;
            }
        }
        debug_assert_eq!(n, size);
        let shift = 64 - bits;
        loop {
            let magic = rng.sparse();
            if (mask.wrapping_mul(magic) >> 56).count_ones() < 6 {
                continue;
            }
            cur_epoch += 1;
            let mut ok = true;
            for i in 0..n {
                let idx = ((occs[i].wrapping_mul(magic)) >> shift) as usize;
                if epoch[idx] != cur_epoch {
                    epoch[idx] = cur_epoch;
                    used[idx] = refs[i];
                } else if used[idx] != refs[i] {
                    ok = false;
                    break;
                }
            }
            if ok {
                magics[sq] = Magic { mask, magic, shift, offset };
                for i in 0..n {
                    let idx = ((occs[i].wrapping_mul(magic)) >> shift) as usize;
                    table[offset + idx] = refs[i];
                }
                offset += size;
                break;
            }
        }
    }
    debug_assert_eq!(offset, table.len());
}

unsafe fn init_tables() {
    for sq in 0..64usize {
        let (r, f) = ((sq / 8) as i32, (sq % 8) as i32);
        let mut n = 0u64;
        for (dr, df) in [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)] {
            let (rr, ff) = (r + dr, f + df);
            if (0..8).contains(&rr) && (0..8).contains(&ff) {
                n |= 1u64 << (rr * 8 + ff);
            }
        }
        KNIGHT_ATT[sq] = n;
        let mut k = 0u64;
        for dr in -1..=1 {
            for df in -1..=1 {
                if dr == 0 && df == 0 {
                    continue;
                }
                let (rr, ff) = (r + dr, f + df);
                if (0..8).contains(&rr) && (0..8).contains(&ff) {
                    k |= 1u64 << (rr * 8 + ff);
                }
            }
        }
        KING_ATT[sq] = k;
        let b = 1u64 << sq;
        PAWN_ATT[WHITE][sq] = ((b & !FILE_A) << 7) | ((b & !FILE_H) << 9);
        PAWN_ATT[BLACK][sq] = ((b & !FILE_A) >> 9) | ((b & !FILE_H) >> 7);
    }

    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    find_magics(&mut rng, &ROOK_DIRS, &mut ROOK_MAGICS, &mut ROOK_TABLE);
    find_magics(&mut rng, &BISHOP_DIRS, &mut BISHOP_MAGICS, &mut BISHOP_TABLE);

    for a in 0..64usize {
        for b in 0..64usize {
            if a == b {
                continue;
            }
            let bba = 1u64 << a;
            let bbb = 1u64 << b;
            if slide_attacks(a, 0, &ROOK_DIRS) & bbb != 0 {
                BETWEEN[a][b] = slide_attacks(a, bbb, &ROOK_DIRS) & slide_attacks(b, bba, &ROOK_DIRS);
                LINE[a][b] = (slide_attacks(a, 0, &ROOK_DIRS) & slide_attacks(b, 0, &ROOK_DIRS)) | bba | bbb;
            } else if slide_attacks(a, 0, &BISHOP_DIRS) & bbb != 0 {
                BETWEEN[a][b] =
                    slide_attacks(a, bbb, &BISHOP_DIRS) & slide_attacks(b, bba, &BISHOP_DIRS);
                LINE[a][b] =
                    (slide_attacks(a, 0, &BISHOP_DIRS) & slide_attacks(b, 0, &BISHOP_DIRS)) | bba | bbb;
            }
        }
    }

    let mut zr = Rng(0x1234_5678_9ABC_DEF1);
    for pc in 0..12 {
        for sq in 0..64 {
            Z_PIECE[pc][sq] = zr.next();
        }
    }
    // Castling keys: XOR of four independent per-right keys so updates compose.
    let mut per_right = [0u64; 4];
    for k in per_right.iter_mut() {
        *k = zr.next();
    }
    for rights in 0..16usize {
        let mut z = 0u64;
        for (i, k) in per_right.iter().enumerate() {
            if rights & (1 << i) != 0 {
                z ^= k;
            }
        }
        Z_CASTLE[rights] = z;
    }
    for f in 0..8 {
        Z_EP[f] = zr.next();
    }
    Z_SIDE = zr.next();
}
