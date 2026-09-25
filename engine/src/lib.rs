//! AmazingChess — our own UCI chess engine.
pub mod bench;
pub mod bitboard;
pub mod eval;
pub mod movegen;
pub mod position;
pub mod search;
pub mod tt;
pub mod types;
pub mod uci;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const NAME: &str = "AmazingChess";
pub const AUTHOR: &str = "amazing-chess team";
