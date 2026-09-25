//! `bench`: fixed-depth search over a set of positions (regression / speed check).

use crate::position::Position;
use crate::search::{Limits, Searcher, Shared};
use crate::tt::TT;
use std::sync::Arc;
use std::time::Instant;

pub const DEFAULT_DEPTH: i32 = 12;

pub const BENCH_FENS: [&str; 12] = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    "r1bq1rk1/pp2bppp/2n2n2/3p4/3P4/2NB1N2/PP3PPP/R1BQ1RK1 w - - 0 10",
    "2r2rk1/pp1bqppp/2n1pn2/3p4/2PP4/1PN1PN2/P2B1PPP/R2QR1K1 b - - 0 13",
    "r1b2rk1/2q1bppp/p2p1n2/np2p3/3PP3/5N1P/PPBN1PP1/R1BQR1K1 w - - 0 13",
    "8/8/4k3/3p4/3P4/4K3/8/8 w - - 0 1",
    "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
    "8/k7/3p4/p2P1p2/P2P1P2/8/8/K7 w - - 0 1",
];

pub fn run(depth: i32) {
    crate::bitboard::init();
    let tt = Arc::new(TT::new(16));
    let shared = Arc::new(Shared::new(1));
    let mut s = Searcher::new(0, tt.clone(), shared.clone());
    s.silent = true;
    let limits = Limits { depth: Some(depth), ..Default::default() };
    let t = Instant::now();
    let mut total = 0u64;
    for (i, fen) in BENCH_FENS.iter().enumerate() {
        let pos = Position::from_fen(fen).unwrap();
        tt.new_search();
        let r = s.think(&pos, &limits, Instant::now(), None, None);
        println!("position {:2}: bestmove {:6} score {:6} nodes {}", i + 1, r.best.to_uci(), r.score, r.nodes);
        total += r.nodes;
    }
    let ms = t.elapsed().as_millis().max(1) as u64;
    println!("===========================");
    println!("Total time (ms) : {}", ms);
    println!("Nodes searched  : {}", total);
    println!("Nodes/second    : {}", total * 1000 / ms);
}
