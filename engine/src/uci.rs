//! UCI protocol front-end. The search runs on a separate thread so that
//! `stop`, `isready` and `quit` are handled while thinking.

use crate::movegen::perft_divide;
use crate::position::{Position, START_FEN};
use crate::search::{time_limits, Limits, Searcher, Shared};
use crate::tt::TT;
use crate::types::*;
use std::io::BufRead;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEFAULT_HASH: usize = 64;
const MAX_HASH: usize = 65536;
const MAX_THREADS: usize = 64;
const DEFAULT_CONTEMPT: i32 = 20;
const DEFAULT_OVERHEAD: u64 = 150;
const DEFAULT_MAX_MOVE_TIME: u64 = 5000;
const SEARCH_STACK: usize = 64 * 1024 * 1024;

pub struct Engine {
    pos: Position,
    /// Hashes of all positions before `pos` in the game (for repetition detection).
    keys: Vec<u64>,
    tt: Arc<TT>,
    threads: usize,
    contempt: i32,
    overhead: u64,
    max_move_time: u64,
    searchers: Vec<Searcher>,
    shared: Arc<Shared>,
    handle: Option<JoinHandle<Vec<Searcher>>>,
    infinite: bool,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Engine {
        let tt = Arc::new(TT::new(DEFAULT_HASH));
        let shared = Arc::new(Shared::new(1));
        Engine {
            pos: Position::startpos(),
            keys: Vec::new(),
            tt: tt.clone(),
            threads: 1,
            contempt: DEFAULT_CONTEMPT,
            overhead: DEFAULT_OVERHEAD,
            max_move_time: DEFAULT_MAX_MOVE_TIME,
            searchers: vec![Searcher::new(0, tt, shared.clone())],
            shared,
            handle: None,
            infinite: false,
        }
    }

    fn wait(&mut self) {
        if let Some(h) = self.handle.take() {
            self.searchers = h.join().expect("search thread panicked");
        }
    }

    fn stop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.wait();
    }

    fn print_id() {
        println!("id name {} {}", crate::NAME, crate::VERSION);
        println!("id author {}", crate::AUTHOR);
        println!("option name Hash type spin default {} min 1 max {}", DEFAULT_HASH, MAX_HASH);
        println!("option name Threads type spin default 1 min 1 max {}", MAX_THREADS);
        println!("option name Contempt type spin default {} min -200 max 200", DEFAULT_CONTEMPT);
        println!("option name Move Overhead type spin default {} min 0 max 5000", DEFAULT_OVERHEAD);
        println!("option name Max Move Time type spin default {} min 0 max 3600000", DEFAULT_MAX_MOVE_TIME);
        println!("option name Clear Hash type button");
        println!("uciok");
    }

    fn set_option(&mut self, tokens: &[&str]) {
        // setoption name <id...> [value <x...>]
        let name_i = tokens.iter().position(|&t| t == "name");
        let value_i = tokens.iter().position(|&t| t == "value");
        let name = match name_i {
            Some(i) => tokens[i + 1..value_i.unwrap_or(tokens.len())].join(" ").to_lowercase(),
            None => return,
        };
        let value = value_i.map(|i| tokens[i + 1..].join(" ")).unwrap_or_default();
        match name.as_str() {
            "hash" => {
                if let Ok(mb) = value.trim().parse::<usize>() {
                    self.stop();
                    let mb = mb.clamp(1, MAX_HASH);
                    self.tt = Arc::new(TT::new(mb));
                }
            }
            "threads" => {
                if let Ok(n) = value.trim().parse::<usize>() {
                    self.stop();
                    self.threads = n.clamp(1, MAX_THREADS);
                }
            }
            "contempt" => {
                if let Ok(c) = value.trim().parse::<i32>() {
                    self.contempt = c.clamp(-200, 200);
                }
            }
            "move overhead" => {
                if let Ok(v) = value.trim().parse::<u64>() {
                    self.overhead = v.min(5000);
                }
            }
            "max move time" => {
                if let Ok(v) = value.trim().parse::<u64>() {
                    self.max_move_time = v;
                }
            }
            "clear hash" => {
                self.stop();
                self.tt.clear();
            }
            _ => println!("info string unknown option '{}'", name),
        }
    }

    fn set_position(&mut self, tokens: &[&str]) {
        let mut i = 1;
        let mut pos;
        if tokens.get(1) == Some(&"startpos") {
            pos = Position::startpos();
            i = 2;
        } else if tokens.get(1) == Some(&"fen") {
            let end = tokens.iter().position(|&t| t == "moves").unwrap_or(tokens.len());
            let fen = tokens[2..end].join(" ");
            match Position::from_fen(&fen) {
                Ok(p) => pos = p,
                Err(e) => {
                    println!("info string invalid fen: {}", e);
                    return;
                }
            }
            i = end;
        } else {
            pos = Position::from_fen(START_FEN).unwrap();
        }
        let mut keys = Vec::new();
        if tokens.get(i) == Some(&"moves") {
            for mv in &tokens[i + 1..] {
                match pos.parse_uci_move(mv) {
                    Some(m) => {
                        keys.push(pos.hash);
                        pos.make_move(m);
                    }
                    None => {
                        println!("info string illegal move '{}' ignored (and the rest)", mv);
                        break;
                    }
                }
            }
        }
        self.pos = pos;
        self.keys = keys;
    }

    fn go(&mut self, tokens: &[&str], start: Instant) {
        self.wait();
        let mut limits = Limits::default();
        let mut i = 1;
        let num = |i: usize| -> Option<u64> { tokens.get(i + 1).and_then(|v| v.parse::<i64>().ok()).map(|v| v.max(0) as u64) };
        while i < tokens.len() {
            match tokens[i] {
                "perft" => {
                    let d = num(i).unwrap_or(1) as u32;
                    let t = Instant::now();
                    let n = if d == 0 { 1 } else { perft_divide(&self.pos, d) };
                    let ms = t.elapsed().as_millis().max(1) as u64;
                    println!("\nNodes searched: {}  ({} ms, {} nps)\n", n, ms, n * 1000 / ms);
                    return;
                }
                "depth" => limits.depth = num(i).map(|v| v as i32),
                "nodes" => limits.nodes = num(i),
                "movetime" => limits.movetime = num(i),
                "wtime" => limits.wtime = num(i),
                "btime" => limits.btime = num(i),
                "winc" => limits.winc = num(i),
                "binc" => limits.binc = num(i),
                "movestogo" => limits.movestogo = num(i),
                "infinite" | "ponder" => {
                    limits.infinite = true;
                    i += 1;
                    continue;
                }
                _ => {
                    i += 1;
                    continue;
                }
            }
            i += 2;
        }

        self.infinite = limits.infinite;
        let shared = Arc::new(Shared::new(self.threads));
        self.shared = shared.clone();
        self.tt.new_search();
        let mut searchers = std::mem::take(&mut self.searchers);
        searchers.truncate(self.threads);
        while searchers.len() < self.threads {
            searchers.push(Searcher::new(searchers.len(), self.tt.clone(), shared.clone()));
        }
        for (id, s) in searchers.iter_mut().enumerate() {
            s.id = id;
            s.set_shared(self.tt.clone(), shared.clone());
            s.contempt = self.contempt;
            s.keys.clear();
            s.keys.extend_from_slice(&self.keys);
            s.silent = id != 0;
        }
        let pos = self.pos;
        let (soft, hard) = time_limits(&limits, pos.stm, self.overhead, self.max_move_time);
        let handle = std::thread::Builder::new()
            .name("search-main".into())
            .stack_size(SEARCH_STACK)
            .spawn(move || {
                let helper_limits = Limits { depth: limits.depth, infinite: true, ..Default::default() };
                let (main, helpers) = searchers.split_at_mut(1);
                let res = std::thread::scope(|sc| {
                    for h in helpers.iter_mut() {
                        let hl = &helper_limits;
                        std::thread::Builder::new()
                            .stack_size(SEARCH_STACK)
                            .spawn_scoped(sc, move || {
                                h.think(&pos, hl, start, None, None);
                            })
                            .expect("spawn helper");
                    }
                    let res = main[0].think(&pos, &limits, start, soft, hard);
                    if limits.infinite {
                        // UCI: never send bestmove in infinite/ponder mode before `stop`
                        while !shared.stop.load(Ordering::Relaxed) {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                    }
                    shared.stop.store(true, Ordering::SeqCst);
                    res
                });
                let mut best = res.best;
                if best.is_none() {
                    // never emit a null move when a legal move exists
                    let mut l = MoveList::new();
                    crate::movegen::generate_legal(&pos, &mut l);
                    if l.len > 0 {
                        best = l.moves[0];
                    }
                }
                println!("bestmove {}", best.to_uci());
                searchers
            })
            .expect("spawn search thread");
        self.handle = Some(handle);
    }

    /// Handle one command line. Returns false on `quit`.
    pub fn handle(&mut self, line: &str) -> bool {
        let start = Instant::now();
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(&cmd) = tokens.first() else { return true };
        match cmd {
            "uci" => Self::print_id(),
            "isready" => println!("readyok"),
            "ucinewgame" => {
                self.stop();
                self.tt.clear();
                for s in &mut self.searchers {
                    s.clear();
                }
                self.pos = Position::startpos();
                self.keys.clear();
            }
            "setoption" => self.set_option(&tokens),
            "position" => {
                self.stop();
                self.set_position(&tokens);
            }
            "go" => self.go(&tokens, start),
            "stop" => self.stop(),
            "ponderhit" => {}
            "quit" => {
                self.stop();
                return false;
            }
            "d" => {
                println!("{}", self.pos.to_fen());
                println!("hash {:016x}", self.pos.hash);
            }
            "eval" => println!("eval {} (side to move)", crate::eval::evaluate(&self.pos)),
            "wait" => self.wait(),
            _ => println!("info string unknown command '{}'", cmd),
        }
        true
    }
}

pub fn run() {
    let mut engine = Engine::new();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if !engine.handle(line.trim()) {
            return;
        }
    }
    // EOF: let a timed search finish (piped usage), but stop infinite ones.
    if engine.infinite {
        engine.stop();
    }
    engine.wait();
}
