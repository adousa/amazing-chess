use amazing_chess::movegen::perft;
use amazing_chess::position::Position;

const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
const POS3: &str = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1";
const POS4: &str = "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1";
const POS4_MIRROR: &str = "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1";
const POS5: &str = "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8";
const POS6: &str = "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10";

fn check(fen: &str, expected: &[u64]) {
    let pos = Position::from_fen(fen).unwrap();
    for (i, &n) in expected.iter().enumerate() {
        assert_eq!(perft(&pos, i as u32 + 1), n, "perft({}) of {}", i + 1, fen);
    }
}

#[test]
fn perft_startpos() {
    check(START, &[20, 400, 8_902, 197_281, 4_865_609]);
}

#[test]
fn perft_kiwipete() {
    check(KIWIPETE, &[48, 2_039, 97_862, 4_085_603]);
}

#[test]
fn perft_pos3() {
    check(POS3, &[14, 191, 2_812, 43_238, 674_624, 11_030_083]);
}

#[test]
fn perft_pos4() {
    check(POS4, &[6, 264, 9_467, 422_333, 15_833_292]);
    check(POS4_MIRROR, &[6, 264, 9_467, 422_333]);
}

#[test]
fn perft_pos5() {
    check(POS5, &[44, 1_486, 62_379, 2_103_487]);
}

#[test]
fn perft_pos6() {
    check(POS6, &[46, 2_079, 89_890, 3_894_594]);
}

#[test]
#[ignore]
fn perft_deep_startpos_d6() {
    assert_eq!(perft(&Position::from_fen(START).unwrap(), 6), 119_060_324);
}

#[test]
#[ignore]
fn perft_deep_kiwipete_d5() {
    assert_eq!(perft(&Position::from_fen(KIWIPETE).unwrap(), 5), 193_690_690);
}

#[test]
#[ignore]
fn perft_deep_pos5_pos6_d5() {
    assert_eq!(perft(&Position::from_fen(POS5).unwrap(), 5), 89_941_194);
    assert_eq!(perft(&Position::from_fen(POS6).unwrap(), 5), 164_075_551);
}
