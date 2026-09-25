use amazing_chess::{bench, bitboard, movegen, position::Position, uci};
use std::time::Instant;

fn main() {
    bitboard::init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("perft") => {
            let depth: u32 = args.get(1).and_then(|d| d.parse().ok()).unwrap_or(5);
            let fen = if args.len() > 2 { args[2..].join(" ") } else { amazing_chess::position::START_FEN.to_string() };
            let pos = match Position::from_fen(&fen) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("error: {}", e);
                    std::process::exit(1);
                }
            };
            let t = Instant::now();
            let n = if depth == 0 { 1 } else { movegen::perft_divide(&pos, depth) };
            let ms = t.elapsed().as_millis().max(1) as u64;
            println!("\nNodes searched: {}", n);
            println!("Time: {} ms  ({} nps)", ms, n * 1000 / ms);
        }
        Some("bench") => {
            let depth: i32 = args.get(1).and_then(|d| d.parse().ok()).unwrap_or(bench::DEFAULT_DEPTH);
            bench::run(depth);
        }
        Some("--version") | Some("version") => {
            println!("{} {}", amazing_chess::NAME, amazing_chess::VERSION);
        }
        _ => uci::run(),
    }
}
