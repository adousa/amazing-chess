use amazing_chess::position::Position;
use amazing_chess::search::{Limits, Searcher, Shared, MATE_BOUND};
use amazing_chess::tt::TT;
use std::sync::Arc;
use std::time::Instant;

fn search(fen: &str, depth: i32) -> (String, i32) {
    let tt = Arc::new(TT::new(16));
    let shared = Arc::new(Shared::new(1));
    let mut s = Searcher::new(0, tt.clone(), shared);
    s.silent = true;
    let pos = Position::from_fen(fen).unwrap();
    let r = s.think(&pos, &Limits { depth: Some(depth), ..Default::default() }, Instant::now(), None, None);
    (r.best.to_uci(), r.score)
}

#[test]
fn mate_in_one() {
    let (m, s) = search("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", 4);
    assert_eq!(m, "d1d8");
    assert!(s >= MATE_BOUND);
}

#[test]
fn mate_in_two() {
    // Classic: 1.Qxh7+?? no — 1.Qd8+ Kxd8?? ... Use known puzzle positions.
    let cases = [
        // mate in 2
        ("r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 0", "d5f6"),
        ("6k1/pp4p1/2p5/2bp4/8/P5Pb/1P3rrP/2BRRN1K b - - 0 1", "g2g1"),
    ];
    for (fen, best) in cases {
        let (m, s) = search(fen, 8);
        assert_eq!(m, best, "{}", fen);
        assert!(s >= MATE_BOUND, "{} score {}", fen, s);
    }
}

#[test]
fn mate_in_three() {
    let cases = [
        ("r1b1kb1r/pppp1ppp/5q2/4n3/3KP3/2N3PN/PPP4P/R1BQ1B1R b kq - 0 1", "f8c5"),
        ("r5rk/5p1p/5R2/4B3/8/8/7P/7K w - - 0 1", "f6a6"),
    ];
    for (fen, best) in cases {
        let (m, s) = search(fen, 10);
        assert_eq!(m, best, "{}", fen);
        assert!(s >= MATE_BOUND, "{} score {}", fen, s);
    }
}

#[test]
fn stalemate_and_mate_roots() {
    let (m, _) = search("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", 3);
    assert_eq!(m, "0000"); // stalemate: no legal move
    let (m, _) = search("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1", 3);
    assert_eq!(m, "0000"); // checkmated
}

#[test]
fn time_limits_respect_cap() {
    use amazing_chess::search::time_limits;
    let l = Limits { movetime: Some(5000), ..Default::default() };
    let (soft, hard) = time_limits(&l, 0, 150, 5000);
    assert_eq!(hard, Some(4850));
    assert!(soft.unwrap() < 4850);
    // a long clock must still be capped at the per-move maximum
    let l = Limits { wtime: Some(600_000), btime: Some(600_000), ..Default::default() };
    let (_, hard) = time_limits(&l, 0, 150, 5000);
    assert!(hard.unwrap() <= 4850);
    // no cap: depth-only search has no time limit
    let l = Limits { depth: Some(5), ..Default::default() };
    assert_eq!(time_limits(&l, 0, 150, 5000), (None, None));
}
