use amazing_chess::movegen::generate_legal;
use amazing_chess::position::Position;
use amazing_chess::types::*;

const FENS: [&str; 5] = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
];

#[test]
fn fen_roundtrip() {
    for fen in FENS {
        assert_eq!(Position::from_fen(fen).unwrap().to_fen(), fen);
    }
}

/// Incremental hash / PST must equal a from-scratch recomputation along random games.
#[test]
fn incremental_state_matches_scratch() {
    let mut seed = 0x1234_5678u64;
    for fen in FENS {
        for _game in 0..20 {
            let mut pos = Position::from_fen(fen).unwrap();
            for _ply in 0..200 {
                let mut list = MoveList::new();
                generate_legal(&pos, &mut list);
                if list.len == 0 {
                    break;
                }
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                let m = list.moves[(seed % list.len as u64) as usize];
                pos.make_move(m);
                assert_eq!(pos.hash, pos.compute_hash());
                let fresh = Position::from_fen(&pos.to_fen()).unwrap();
                assert_eq!(pos.hash, fresh.hash, "hash mismatch at {}", pos.to_fen());
                assert_eq!(pos.psq_mg, fresh.psq_mg);
                assert_eq!(pos.psq_eg, fresh.psq_eg);
                assert_eq!(pos.phase, fresh.phase);
                assert_eq!(pos.checkers, fresh.checkers);
            }
        }
    }
}

#[test]
fn see_basic() {
    // Rxe5 wins a pawn defended by nothing
    let p = Position::from_fen("1k1r4/1pp4p/p7/4p3/8/P5P1/1PP4P/2K1R3 w - - 0 1").unwrap();
    let m = p.parse_uci_move("e1e5").unwrap();
    assert!(p.see_ge(m, 100));
    assert!(!p.see_ge(m, 101));
    // Nxe5 loses the knight for a pawn (defended by knight and bishop)
    let p = Position::from_fen("1k1r3q/1ppn3p/p4b2/4p3/8/P2N2P1/1PP1R1BP/2K1Q3 w - - 0 1").unwrap();
    let m = p.parse_uci_move("d3e5").unwrap();
    assert!(!p.see_ge(m, 0));
}

#[test]
fn insufficient_material() {
    assert!(Position::from_fen("8/8/4k3/8/8/3K4/8/8 w - - 0 1").unwrap().is_insufficient_material());
    assert!(Position::from_fen("8/8/4k3/8/8/3KB3/8/8 w - - 0 1").unwrap().is_insufficient_material());
    assert!(!Position::from_fen("8/8/2k5/8/8/3KR3/8/8 w - - 0 1").unwrap().is_insufficient_material());
}
