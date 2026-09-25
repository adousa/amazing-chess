//! Basic types: colours, pieces, squares and the packed 16-bit move.

pub type Bitboard = u64;
pub type Square = usize; // 0 = a1, 7 = h1, 56 = a8, 63 = h8

pub const WHITE: usize = 0;
pub const BLACK: usize = 1;

pub const PAWN: usize = 0;
pub const KNIGHT: usize = 1;
pub const BISHOP: usize = 2;
pub const ROOK: usize = 3;
pub const QUEEN: usize = 4;
pub const KING: usize = 5;

/// Coloured piece code = colour * 6 + piece type. `NO_PIECE` marks an empty square.
pub const NO_PIECE: u8 = 12;

#[inline(always)]
pub fn make_piece(color: usize, pt: usize) -> u8 {
    (color * 6 + pt) as u8
}
#[inline(always)]
pub fn piece_type(pc: u8) -> usize {
    (pc % 6) as usize
}
#[inline(always)]
pub fn piece_color(pc: u8) -> usize {
    (pc / 6) as usize
}

pub const NO_SQ: u8 = 64;

#[inline(always)]
pub fn file_of(sq: Square) -> usize {
    sq & 7
}
#[inline(always)]
pub fn rank_of(sq: Square) -> usize {
    sq >> 3
}
/// Rank from the point of view of `color` (0 = own back rank).
#[inline(always)]
pub fn relative_rank(color: usize, sq: Square) -> usize {
    if color == WHITE {
        sq >> 3
    } else {
        7 - (sq >> 3)
    }
}

pub fn square_name(sq: Square) -> String {
    let f = (b'a' + file_of(sq) as u8) as char;
    let r = (b'1' + rank_of(sq) as u8) as char;
    format!("{}{}", f, r)
}

pub fn parse_square(s: &str) -> Option<Square> {
    let b = s.as_bytes();
    if b.len() != 2 {
        return None;
    }
    if !(b'a'..=b'h').contains(&b[0]) || !(b'1'..=b'8').contains(&b[1]) {
        return None;
    }
    Some(((b[1] - b'1') as usize) * 8 + (b[0] - b'a') as usize)
}

// ---------------------------------------------------------------------------
// Move encoding: bits 0-5 from, 6-11 to, 12-15 flags.
// ---------------------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Hash)]
pub struct Move(pub u16);

pub const FLAG_QUIET: u16 = 0;
pub const FLAG_DOUBLE_PUSH: u16 = 1;
pub const FLAG_KING_CASTLE: u16 = 2;
pub const FLAG_QUEEN_CASTLE: u16 = 3;
pub const FLAG_CAPTURE: u16 = 4;
pub const FLAG_EP: u16 = 5;
pub const FLAG_PROMO: u16 = 8; // + (promo piece - KNIGHT)
pub const FLAG_PROMO_CAPTURE: u16 = 12; // + (promo piece - KNIGHT)

impl Move {
    pub const NONE: Move = Move(0);

    #[inline(always)]
    pub fn new(from: Square, to: Square, flag: u16) -> Move {
        Move((from as u16) | ((to as u16) << 6) | (flag << 12))
    }
    #[inline(always)]
    pub fn from(self) -> Square {
        (self.0 & 63) as usize
    }
    #[inline(always)]
    pub fn to(self) -> Square {
        ((self.0 >> 6) & 63) as usize
    }
    #[inline(always)]
    pub fn flag(self) -> u16 {
        self.0 >> 12
    }
    #[inline(always)]
    pub fn is_none(self) -> bool {
        self.0 == 0
    }
    #[inline(always)]
    pub fn is_capture(self) -> bool {
        self.flag() & 4 != 0
    }
    #[inline(always)]
    pub fn is_promotion(self) -> bool {
        self.flag() & 8 != 0
    }
    /// Captures and promotions ("noisy" moves).
    #[inline(always)]
    pub fn is_tactical(self) -> bool {
        self.flag() & 12 != 0
    }
    #[inline(always)]
    pub fn is_castle(self) -> bool {
        let f = self.flag();
        f == FLAG_KING_CASTLE || f == FLAG_QUEEN_CASTLE
    }
    #[inline(always)]
    pub fn is_ep(self) -> bool {
        self.flag() == FLAG_EP
    }
    /// Promotion piece type (only valid if `is_promotion`).
    #[inline(always)]
    pub fn promo_piece(self) -> usize {
        ((self.flag() & 3) as usize) + KNIGHT
    }

    pub fn to_uci(self) -> String {
        if self.is_none() {
            return "0000".to_string();
        }
        let mut s = format!("{}{}", square_name(self.from()), square_name(self.to()));
        if self.is_promotion() {
            s.push(['n', 'b', 'r', 'q'][self.promo_piece() - KNIGHT]);
        }
        s
    }
}

/// Fixed-capacity move list (no heap allocation).
pub struct MoveList {
    pub moves: [Move; 256],
    pub scores: [i32; 256],
    pub len: usize,
}

impl MoveList {
    #[inline(always)]
    pub fn new() -> MoveList {
        MoveList { moves: [Move::NONE; 256], scores: [0; 256], len: 0 }
    }
    #[inline(always)]
    pub fn push(&mut self, m: Move) {
        self.moves[self.len] = m;
        self.len += 1;
    }
    #[inline(always)]
    pub fn iter(&self) -> impl Iterator<Item = &Move> {
        self.moves[..self.len].iter()
    }
    /// Selection sort step: bring the best-scored remaining move to index `i`.
    #[inline(always)]
    pub fn pick(&mut self, i: usize) -> Move {
        let mut best = i;
        let mut best_score = self.scores[i];
        for j in (i + 1)..self.len {
            if self.scores[j] > best_score {
                best_score = self.scores[j];
                best = j;
            }
        }
        if best != i {
            self.moves.swap(i, best);
            self.scores.swap(i, best);
        }
        self.moves[i]
    }
}

impl Default for MoveList {
    fn default() -> Self {
        Self::new()
    }
}
