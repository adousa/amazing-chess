//! Board state, FEN parsing, copy-make move execution, attack queries,
//! legality testing and static exchange evaluation.

use crate::bitboard::*;
use crate::eval::{psq_eg, psq_mg, PHASE_INC};
use crate::types::*;

pub const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

pub const CASTLE_WK: u8 = 1;
pub const CASTLE_WQ: u8 = 2;
pub const CASTLE_BK: u8 = 4;
pub const CASTLE_BQ: u8 = 8;

/// For each square: the castling rights that survive a move from/to it.
static CASTLE_MASK: [u8; 64] = {
    let mut m = [15u8; 64];
    m[0] = 15 & !CASTLE_WQ; // a1
    m[4] = 15 & !(CASTLE_WK | CASTLE_WQ); // e1
    m[7] = 15 & !CASTLE_WK; // h1
    m[56] = 15 & !CASTLE_BQ; // a8
    m[60] = 15 & !(CASTLE_BK | CASTLE_BQ); // e8
    m[63] = 15 & !CASTLE_BK; // h8
    m
};

/// Piece values used by SEE and move ordering.
pub const SEE_VALUE: [i32; 6] = [100, 320, 330, 500, 900, 20000];

#[derive(Clone, Copy)]
pub struct Position {
    pub by_type: [u64; 6],
    pub by_color: [u64; 2],
    pub board: [u8; 64],
    pub stm: usize,
    pub castling: u8,
    pub ep: u8,
    pub halfmove: u16,
    pub fullmove: u16,
    pub hash: u64,
    /// Incremental PeSTO material+PST (White minus Black).
    pub psq_mg: i32,
    pub psq_eg: i32,
    pub phase: i32,
    /// Pieces giving check to the side to move.
    pub checkers: u64,
}

impl Position {
    pub fn startpos() -> Position {
        Position::from_fen(START_FEN).unwrap()
    }

    fn empty() -> Position {
        Position {
            by_type: [0; 6],
            by_color: [0; 2],
            board: [NO_PIECE; 64],
            stm: WHITE,
            castling: 0,
            ep: NO_SQ,
            halfmove: 0,
            fullmove: 1,
            hash: 0,
            psq_mg: 0,
            psq_eg: 0,
            phase: 0,
            checkers: 0,
        }
    }

    pub fn from_fen(fen: &str) -> Result<Position, String> {
        init();
        let mut p = Position::empty();
        let parts: Vec<&str> = fen.split_whitespace().collect();
        if parts.len() < 4 {
            return Err(format!("bad FEN (need at least 4 fields): {}", fen));
        }
        let mut rank = 7i32;
        let mut file = 0i32;
        for c in parts[0].chars() {
            match c {
                '/' => {
                    rank -= 1;
                    file = 0;
                }
                '1'..='8' => file += c as i32 - '0' as i32,
                _ => {
                    let color = if c.is_ascii_uppercase() { WHITE } else { BLACK };
                    let pt = match c.to_ascii_lowercase() {
                        'p' => PAWN,
                        'n' => KNIGHT,
                        'b' => BISHOP,
                        'r' => ROOK,
                        'q' => QUEEN,
                        'k' => KING,
                        _ => return Err(format!("bad piece char '{}'", c)),
                    };
                    if !(0..8).contains(&rank) || !(0..8).contains(&file) {
                        return Err("bad FEN board".into());
                    }
                    p.put_piece(make_piece(color, pt), (rank * 8 + file) as usize);
                    file += 1;
                }
            }
        }
        p.stm = match parts[1] {
            "w" => WHITE,
            "b" => BLACK,
            _ => return Err("bad side to move".into()),
        };
        for c in parts[2].chars() {
            match c {
                'K' => p.castling |= CASTLE_WK,
                'Q' => p.castling |= CASTLE_WQ,
                'k' => p.castling |= CASTLE_BK,
                'q' => p.castling |= CASTLE_BQ,
                '-' => {}
                _ => return Err("bad castling field".into()),
            }
        }
        // Drop castling rights that are inconsistent with the board.
        let wk = p.board[4] == make_piece(WHITE, KING);
        let bk = p.board[60] == make_piece(BLACK, KING);
        if !(wk && p.board[7] == make_piece(WHITE, ROOK)) {
            p.castling &= !CASTLE_WK;
        }
        if !(wk && p.board[0] == make_piece(WHITE, ROOK)) {
            p.castling &= !CASTLE_WQ;
        }
        if !(bk && p.board[63] == make_piece(BLACK, ROOK)) {
            p.castling &= !CASTLE_BK;
        }
        if !(bk && p.board[56] == make_piece(BLACK, ROOK)) {
            p.castling &= !CASTLE_BQ;
        }
        if parts[3] != "-" {
            let sq = parse_square(parts[3]).ok_or("bad ep square")?;
            p.ep = sq as u8;
        }
        p.halfmove = parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
        p.fullmove = parts.get(5).and_then(|s| s.parse().ok()).unwrap_or(1);
        if popcount(p.pieces(WHITE, KING)) != 1 || popcount(p.pieces(BLACK, KING)) != 1 {
            return Err("each side needs exactly one king".into());
        }
        // Only keep an ep square if a pawn can actually capture there.
        if p.ep != NO_SQ {
            let ep = p.ep as usize;
            if pawn_attacks(p.stm ^ 1, ep) & p.pieces(p.stm, PAWN) == 0 {
                p.ep = NO_SQ;
            }
        }
        p.hash = p.compute_hash();
        p.checkers = p.attackers_to(p.king_sq(p.stm), p.occupied()) & p.by_color[p.stm ^ 1];
        // The side not to move must not be in check.
        if p.attackers_to(p.king_sq(p.stm ^ 1), p.occupied()) & p.by_color[p.stm] != 0 {
            return Err("side not to move is in check".into());
        }
        Ok(p)
    }

    pub fn to_fen(&self) -> String {
        let mut s = String::new();
        for rank in (0..8).rev() {
            let mut empty = 0;
            for file in 0..8 {
                let pc = self.board[rank * 8 + file];
                if pc == NO_PIECE {
                    empty += 1;
                } else {
                    if empty > 0 {
                        s.push((b'0' + empty) as char);
                        empty = 0;
                    }
                    let c = ['p', 'n', 'b', 'r', 'q', 'k'][piece_type(pc)];
                    s.push(if piece_color(pc) == WHITE { c.to_ascii_uppercase() } else { c });
                }
            }
            if empty > 0 {
                s.push((b'0' + empty) as char);
            }
            if rank > 0 {
                s.push('/');
            }
        }
        s.push_str(if self.stm == WHITE { " w " } else { " b " });
        if self.castling == 0 {
            s.push('-');
        } else {
            if self.castling & CASTLE_WK != 0 {
                s.push('K');
            }
            if self.castling & CASTLE_WQ != 0 {
                s.push('Q');
            }
            if self.castling & CASTLE_BK != 0 {
                s.push('k');
            }
            if self.castling & CASTLE_BQ != 0 {
                s.push('q');
            }
        }
        s.push(' ');
        if self.ep == NO_SQ {
            s.push('-');
        } else {
            s.push_str(&square_name(self.ep as usize));
        }
        s.push_str(&format!(" {} {}", self.halfmove, self.fullmove));
        s
    }

    pub fn compute_hash(&self) -> u64 {
        let mut h = 0u64;
        for sq in 0..64 {
            let pc = self.board[sq];
            if pc != NO_PIECE {
                h ^= z_piece(pc, sq);
            }
        }
        h ^= z_castle(self.castling);
        if self.ep != NO_SQ {
            h ^= z_ep(file_of(self.ep as usize));
        }
        if self.stm == BLACK {
            h ^= z_side();
        }
        h
    }

    #[inline(always)]
    fn put_piece(&mut self, pc: u8, sq: Square) {
        let b = bb(sq);
        let (c, pt) = (piece_color(pc), piece_type(pc));
        self.by_type[pt] |= b;
        self.by_color[c] |= b;
        self.board[sq] = pc;
        self.hash ^= z_piece(pc, sq);
        let sign = if c == WHITE { 1 } else { -1 };
        self.psq_mg += sign * psq_mg(pc, sq);
        self.psq_eg += sign * psq_eg(pc, sq);
        self.phase += PHASE_INC[pt];
    }

    #[inline(always)]
    fn remove_piece(&mut self, sq: Square) {
        let pc = self.board[sq];
        let b = bb(sq);
        let (c, pt) = (piece_color(pc), piece_type(pc));
        self.by_type[pt] ^= b;
        self.by_color[c] ^= b;
        self.board[sq] = NO_PIECE;
        self.hash ^= z_piece(pc, sq);
        let sign = if c == WHITE { 1 } else { -1 };
        self.psq_mg -= sign * psq_mg(pc, sq);
        self.psq_eg -= sign * psq_eg(pc, sq);
        self.phase -= PHASE_INC[pt];
    }

    #[inline(always)]
    fn move_piece(&mut self, from: Square, to: Square) {
        let pc = self.board[from];
        let b = bb(from) | bb(to);
        let (c, pt) = (piece_color(pc), piece_type(pc));
        self.by_type[pt] ^= b;
        self.by_color[c] ^= b;
        self.board[from] = NO_PIECE;
        self.board[to] = pc;
        self.hash ^= z_piece(pc, from) ^ z_piece(pc, to);
        let sign = if c == WHITE { 1 } else { -1 };
        self.psq_mg += sign * (psq_mg(pc, to) - psq_mg(pc, from));
        self.psq_eg += sign * (psq_eg(pc, to) - psq_eg(pc, from));
    }

    #[inline(always)]
    pub fn occupied(&self) -> u64 {
        self.by_color[0] | self.by_color[1]
    }
    #[inline(always)]
    pub fn pieces(&self, color: usize, pt: usize) -> u64 {
        self.by_color[color] & self.by_type[pt]
    }
    #[inline(always)]
    pub fn king_sq(&self, color: usize) -> Square {
        lsb(self.pieces(color, KING))
    }
    #[inline(always)]
    pub fn in_check(&self) -> bool {
        self.checkers != 0
    }
    #[inline(always)]
    pub fn piece_on(&self, sq: Square) -> u8 {
        self.board[sq]
    }

    /// All pieces (both colours) attacking `sq` given occupancy `occ`.
    #[inline(always)]
    pub fn attackers_to(&self, sq: Square, occ: u64) -> u64 {
        (pawn_attacks(WHITE, sq) & self.pieces(BLACK, PAWN))
            | (pawn_attacks(BLACK, sq) & self.pieces(WHITE, PAWN))
            | (knight_attacks(sq) & self.by_type[KNIGHT])
            | (king_attacks(sq) & self.by_type[KING])
            | (bishop_attacks(sq, occ) & (self.by_type[BISHOP] | self.by_type[QUEEN]))
            | (rook_attacks(sq, occ) & (self.by_type[ROOK] | self.by_type[QUEEN]))
    }

    #[inline(always)]
    pub fn is_attacked(&self, sq: Square, by: usize, occ: u64) -> bool {
        let them = self.by_color[by];
        (pawn_attacks(by ^ 1, sq) & self.by_type[PAWN] & them) != 0
            || (knight_attacks(sq) & self.by_type[KNIGHT] & them) != 0
            || (king_attacks(sq) & self.by_type[KING] & them) != 0
            || (bishop_attacks(sq, occ) & (self.by_type[BISHOP] | self.by_type[QUEEN]) & them) != 0
            || (rook_attacks(sq, occ) & (self.by_type[ROOK] | self.by_type[QUEEN]) & them) != 0
    }

    /// Own pieces pinned to our king (side to move).
    pub fn pinned(&self) -> u64 {
        let us = self.stm;
        let them = us ^ 1;
        let ksq = self.king_sq(us);
        let occ = self.occupied();
        let mut pinned = 0u64;
        let mut snipers = (rook_attacks(ksq, 0) & (self.pieces(them, ROOK) | self.pieces(them, QUEEN)))
            | (bishop_attacks(ksq, 0) & (self.pieces(them, BISHOP) | self.pieces(them, QUEEN)));
        while snipers != 0 {
            let s = pop_lsb(&mut snipers);
            let b = between(ksq, s) & occ;
            if b != 0 && !more_than_one(b) {
                pinned |= b & self.by_color[us];
            }
        }
        pinned
    }

    /// Legality test for a pseudo-legal move (castling is fully verified at generation).
    #[inline]
    pub fn is_legal(&self, m: Move, pinned: u64) -> bool {
        let us = self.stm;
        let them = us ^ 1;
        let from = m.from();
        let to = m.to();
        let ksq = self.king_sq(us);
        if m.is_ep() {
            let cap = if us == WHITE { to - 8 } else { to + 8 };
            let occ = (self.occupied() ^ bb(from) ^ bb(cap)) | bb(to);
            let att = self.attackers_to(ksq, occ) & self.by_color[them] & !bb(cap);
            return att == 0;
        }
        if from == ksq {
            if m.is_castle() {
                return true;
            }
            return !self.is_attacked(to, them, self.occupied() ^ bb(from));
        }
        if self.checkers != 0 {
            if more_than_one(self.checkers) {
                return false;
            }
            let c = lsb(self.checkers);
            if (between(ksq, c) | self.checkers) & bb(to) == 0 {
                return false;
            }
        }
        if pinned & bb(from) != 0 && line(ksq, from) & bb(to) == 0 {
            return false;
        }
        true
    }

    /// Execute a move in place. Returns nothing; use copy-make (`let mut c = *pos; c.make_move(m)`).
    #[inline]
    pub fn make_move(&mut self, m: Move) {
        let us = self.stm;
        let them = us ^ 1;
        let from = m.from();
        let to = m.to();
        let flag = m.flag();
        let pc = self.board[from];
        let pt = piece_type(pc);

        self.hash ^= z_castle(self.castling);
        if self.ep != NO_SQ {
            self.hash ^= z_ep(file_of(self.ep as usize));
            self.ep = NO_SQ;
        }
        self.halfmove += 1;

        if m.is_capture() {
            let cap_sq = if flag == FLAG_EP {
                if us == WHITE {
                    to - 8
                } else {
                    to + 8
                }
            } else {
                to
            };
            self.remove_piece(cap_sq);
            self.halfmove = 0;
        }

        if m.is_promotion() {
            self.remove_piece(from);
            self.put_piece(make_piece(us, m.promo_piece()), to);
        } else {
            self.move_piece(from, to);
        }

        if pt == PAWN {
            self.halfmove = 0;
            if flag == FLAG_DOUBLE_PUSH {
                let ep_sq = if us == WHITE { from + 8 } else { from - 8 };
                if pawn_attacks(us, ep_sq) & self.pieces(them, PAWN) != 0 {
                    self.ep = ep_sq as u8;
                    self.hash ^= z_ep(file_of(ep_sq));
                }
            }
        } else if flag == FLAG_KING_CASTLE {
            let (rf, rt) = if us == WHITE { (7, 5) } else { (63, 61) };
            self.move_piece(rf, rt);
        } else if flag == FLAG_QUEEN_CASTLE {
            let (rf, rt) = if us == WHITE { (0, 3) } else { (56, 59) };
            self.move_piece(rf, rt);
        }

        self.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
        self.hash ^= z_castle(self.castling);

        self.stm = them;
        self.hash ^= z_side();
        if us == BLACK {
            self.fullmove += 1;
        }
        self.checkers = self.attackers_to(self.king_sq(them), self.occupied()) & self.by_color[us];
    }

    /// Null move (pass). Only valid when not in check.
    #[inline]
    pub fn make_null(&mut self) {
        if self.ep != NO_SQ {
            self.hash ^= z_ep(file_of(self.ep as usize));
            self.ep = NO_SQ;
        }
        self.stm ^= 1;
        self.hash ^= z_side();
        self.halfmove += 1;
        self.checkers = 0;
    }

    /// Does the side to move have any non-pawn, non-king material?
    #[inline]
    pub fn has_non_pawn_material(&self, color: usize) -> bool {
        self.by_color[color] & !(self.by_type[PAWN] | self.by_type[KING]) != 0
    }

    /// Dead-draw material (K v K, K+minor v K, K+B v K+B same-coloured bishops).
    pub fn is_insufficient_material(&self) -> bool {
        if self.by_type[PAWN] | self.by_type[ROOK] | self.by_type[QUEEN] != 0 {
            return false;
        }
        let minors = self.by_type[KNIGHT] | self.by_type[BISHOP];
        if popcount(minors) <= 1 {
            return true;
        }
        if self.by_type[KNIGHT] == 0 {
            let b = self.by_type[BISHOP];
            if b & DARK_SQUARES == 0 || b & !DARK_SQUARES == 0 {
                return true;
            }
        }
        false
    }

    /// Static exchange evaluation: is the material outcome of `m` >= `threshold`?
    pub fn see_ge(&self, m: Move, threshold: i32) -> bool {
        if m.is_castle() || m.is_ep() || m.is_promotion() {
            return 0 >= threshold;
        }
        let from = m.from();
        let to = m.to();
        let captured = self.board[to];
        let mut swap = if captured == NO_PIECE { 0 } else { SEE_VALUE[piece_type(captured)] } - threshold;
        if swap < 0 {
            return false;
        }
        swap = SEE_VALUE[piece_type(self.board[from])] - swap;
        if swap <= 0 {
            return true;
        }
        let mut occ = self.occupied() ^ bb(from) ^ bb(to);
        let mut stm = piece_color(self.board[from]);
        let mut attackers = self.attackers_to(to, occ);
        let bishops = self.by_type[BISHOP] | self.by_type[QUEEN];
        let rooks = self.by_type[ROOK] | self.by_type[QUEEN];
        let mut res = 1i32;
        loop {
            stm ^= 1;
            attackers &= occ;
            let stm_att = attackers & self.by_color[stm];
            if stm_att == 0 {
                break;
            }
            res ^= 1;
            let mut b;
            b = stm_att & self.by_type[PAWN];
            if b != 0 {
                swap = SEE_VALUE[PAWN] - swap;
                if swap < res {
                    break;
                }
                occ ^= bb(lsb(b));
                attackers |= bishop_attacks(to, occ) & bishops;
                continue;
            }
            b = stm_att & self.by_type[KNIGHT];
            if b != 0 {
                swap = SEE_VALUE[KNIGHT] - swap;
                if swap < res {
                    break;
                }
                occ ^= bb(lsb(b));
                continue;
            }
            b = stm_att & self.by_type[BISHOP];
            if b != 0 {
                swap = SEE_VALUE[BISHOP] - swap;
                if swap < res {
                    break;
                }
                occ ^= bb(lsb(b));
                attackers |= bishop_attacks(to, occ) & bishops;
                continue;
            }
            b = stm_att & self.by_type[ROOK];
            if b != 0 {
                swap = SEE_VALUE[ROOK] - swap;
                if swap < res {
                    break;
                }
                occ ^= bb(lsb(b));
                attackers |= rook_attacks(to, occ) & rooks;
                continue;
            }
            b = stm_att & self.by_type[QUEEN];
            if b != 0 {
                swap = SEE_VALUE[QUEEN] - swap;
                if swap < res {
                    break;
                }
                occ ^= bb(lsb(b));
                attackers |= (bishop_attacks(to, occ) & bishops) | (rook_attacks(to, occ) & rooks);
                continue;
            }
            // King: can only capture if the opponent has no attackers left.
            return if attackers & !self.by_color[stm] != 0 { res ^ 1 != 0 } else { res != 0 };
        }
        res != 0
    }

    /// Parse a UCI move string against the legal moves of this position.
    pub fn parse_uci_move(&self, s: &str) -> Option<Move> {
        let mut list = MoveList::new();
        crate::movegen::generate_legal(self, &mut list);
        let found = list.iter().copied().find(|m| m.to_uci() == s);
        found
    }
}
