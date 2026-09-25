//! Search: iterative deepening, aspiration windows, PVS negamax alpha-beta
//! with TT, null-move / reverse-futility / futility / late-move / SEE pruning,
//! LMR, check extensions, killers + countermove + (continuation) history,
//! quiescence search, repetition / 50-move / insufficient-material draws with
//! contempt, and optional Lazy SMP helper threads.

use crate::eval::evaluate;
use crate::movegen::{generate, generate_legal};
use crate::position::{Position, SEE_VALUE};
use crate::tt::*;
use crate::types::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_PLY: usize = 128;
pub const INF: i32 = 32001;
pub const MATE: i32 = 32000;
pub const MATE_BOUND: i32 = MATE - MAX_PLY as i32;
const EVAL_NONE: i32 = -INF;

#[derive(Clone, Debug, Default)]
pub struct Limits {
    pub depth: Option<i32>,
    pub nodes: Option<u64>,
    pub movetime: Option<u64>,
    pub wtime: Option<u64>,
    pub btime: Option<u64>,
    pub winc: Option<u64>,
    pub binc: Option<u64>,
    pub movestogo: Option<u64>,
    pub infinite: bool,
}

/// State shared by all search threads of one `go`.
pub struct Shared {
    pub stop: AtomicBool,
    pub nodes: Vec<AtomicU64>,
}

impl Shared {
    pub fn new(threads: usize) -> Shared {
        Shared { stop: AtomicBool::new(false), nodes: (0..threads).map(|_| AtomicU64::new(0)).collect() }
    }
    pub fn total_nodes(&self) -> u64 {
        self.nodes.iter().map(|n| n.load(Ordering::Relaxed)).sum()
    }
}

#[derive(Clone, Copy, Default)]
struct StackEntry {
    eval: i32,
    mv: Move,
    piece: u8, // moved piece, NO_PIECE for null move / none
}

const CONT_SIZE: usize = 12 * 64 * 12 * 64;

pub struct SearchResult {
    pub best: Move,
    pub score: i32,
    pub depth: i32,
    pub nodes: u64,
}

pub struct Searcher {
    pub id: usize,
    history: Box<[[[i32; 64]; 64]; 2]>,
    cont_hist: Box<[i16]>,
    counter: Box<[[Move; 64]; 12]>,
    killers: [[Move; 2]; MAX_PLY + 2],
    stack: [StackEntry; MAX_PLY + 4],
    pv: Box<[[Move; MAX_PLY + 1]; MAX_PLY + 1]>,
    pv_len: [usize; MAX_PLY + 1],
    pub keys: Vec<u64>,
    nodes: u64,
    seldepth: usize,
    stopped: bool,
    start: Instant,
    hard: Option<Duration>,
    node_limit: Option<u64>,
    root_stm: usize,
    pub contempt: i32,
    root_best: Move,
    root_best_score: i32,
    shared: Arc<Shared>,
    tt: Arc<TT>,
    pub silent: bool,
}

static LMR: std::sync::OnceLock<[[i32; 64]; 64]> = std::sync::OnceLock::new();

fn lmr_table() -> &'static [[i32; 64]; 64] {
    LMR.get_or_init(|| {
        let mut t = [[0i32; 64]; 64];
        for (d, row) in t.iter_mut().enumerate().skip(1) {
            for (m, v) in row.iter_mut().enumerate().skip(1) {
                *v = (0.75 + (d as f64).ln() * (m as f64).ln() / 2.25) as i32;
            }
        }
        t
    })
}

#[inline(always)]
fn score_to_tt(s: i32, ply: usize) -> i32 {
    if s >= MATE_BOUND {
        s + ply as i32
    } else if s <= -MATE_BOUND {
        s - ply as i32
    } else {
        s
    }
}
#[inline(always)]
fn score_from_tt(s: i32, ply: usize) -> i32 {
    if s >= MATE_BOUND {
        s - ply as i32
    } else if s <= -MATE_BOUND {
        s + ply as i32
    } else {
        s
    }
}

#[inline(always)]
fn cont_index(prev_pc: u8, prev_to: Square, pc: u8, to: Square) -> usize {
    ((prev_pc as usize * 64 + prev_to) * 12 + pc as usize) * 64 + to
}

pub fn format_score(score: i32) -> String {
    if score >= MATE_BOUND {
        format!("mate {}", (MATE - score + 1) / 2)
    } else if score <= -MATE_BOUND {
        format!("mate -{}", (MATE + score) / 2)
    } else {
        format!("cp {}", score)
    }
}

/// Compute (soft, hard) time limits in milliseconds. `max_move_ms` (0 = off)
/// caps the hard limit of clock/movetime searches (competition rule: <= 5 s/move).
pub fn time_limits(limits: &Limits, stm: usize, overhead: u64, max_move_ms: u64) -> (Option<u64>, Option<u64>) {
    let mut limits = limits.clone();
    if max_move_ms > 0 && (limits.movetime.is_some() || limits.wtime.is_some() || limits.btime.is_some()) {
        limits.movetime = Some(limits.movetime.map_or(max_move_ms, |m| m.min(max_move_ms)));
    }
    let limits = &limits;
    let mut soft: Option<u64> = None;
    let mut hard: Option<u64> = None;
    if let Some(mt) = limits.movetime {
        let h = if mt > 2 * overhead { mt - overhead } else { (mt / 2).max(1) };
        hard = Some(h);
        soft = Some(h * 60 / 100);
    }
    let (time, inc) = if stm == WHITE { (limits.wtime, limits.winc) } else { (limits.btime, limits.binc) };
    if let Some(t) = time {
        let inc = inc.unwrap_or(0);
        let avail = t.saturating_sub(overhead).max(1);
        let mtg = limits.movestogo.unwrap_or(25).clamp(1, 60);
        let (s, h) = if mtg == 1 {
            (avail * 70 / 100, avail * 85 / 100)
        } else {
            let s = (avail / mtg + inc * 3 / 4).min(avail * 45 / 100);
            let h = (s * 3).min(avail * 70 / 100);
            (s, h.max(s))
        };
        soft = Some(soft.map_or(s, |x| x.min(s)));
        hard = Some(hard.map_or(h, |x| x.min(h)));
    }
    (soft.map(|s| s.max(1)), hard.map(|h| h.max(1)))
}

impl Searcher {
    pub fn new(id: usize, tt: Arc<TT>, shared: Arc<Shared>) -> Searcher {
        Searcher {
            id,
            history: Box::new([[[0; 64]; 64]; 2]),
            cont_hist: vec![0i16; CONT_SIZE].into_boxed_slice(),
            counter: Box::new([[Move::NONE; 64]; 12]),
            killers: [[Move::NONE; 2]; MAX_PLY + 2],
            stack: [StackEntry { eval: EVAL_NONE, mv: Move::NONE, piece: NO_PIECE }; MAX_PLY + 4],
            pv: Box::new([[Move::NONE; MAX_PLY + 1]; MAX_PLY + 1]),
            pv_len: [0; MAX_PLY + 1],
            keys: Vec::with_capacity(1024),
            nodes: 0,
            seldepth: 0,
            stopped: false,
            start: Instant::now(),
            hard: None,
            node_limit: None,
            root_stm: WHITE,
            contempt: 0,
            root_best: Move::NONE,
            root_best_score: 0,
            shared,
            tt,
            silent: false,
        }
    }

    pub fn set_shared(&mut self, tt: Arc<TT>, shared: Arc<Shared>) {
        self.tt = tt;
        self.shared = shared;
    }

    pub fn clear(&mut self) {
        *self.history = [[[0; 64]; 64]; 2];
        self.cont_hist.iter_mut().for_each(|x| *x = 0);
        *self.counter = [[Move::NONE; 64]; 12];
        self.killers = [[Move::NONE; 2]; MAX_PLY + 2];
    }

    #[inline]
    fn check_time(&mut self) {
        self.shared.nodes[self.id].store(self.nodes, Ordering::Relaxed);
        if self.shared.stop.load(Ordering::Relaxed) {
            self.stopped = true;
            return;
        }
        if self.id == 0 {
            if let Some(h) = self.hard {
                if self.start.elapsed() >= h {
                    self.stopped = true;
                }
            }
            if let Some(n) = self.node_limit {
                if self.shared.total_nodes() >= n {
                    self.stopped = true;
                }
            }
            if self.stopped {
                self.shared.stop.store(true, Ordering::Relaxed);
            }
        }
    }

    #[inline]
    fn draw_score(&self, pos: &Position) -> i32 {
        if pos.stm == self.root_stm {
            -self.contempt
        } else {
            self.contempt
        }
    }

    #[inline]
    fn is_repetition(&self, pos: &Position) -> bool {
        let n = self.keys.len();
        let limit = (pos.halfmove as usize).min(n);
        let mut i = 2;
        while i <= limit {
            if self.keys[n - i] == pos.hash {
                return true;
            }
            i += 2;
        }
        false
    }

    /// Run a search. `start` is when the `go` command was received.
    pub fn think(
        &mut self,
        root: &Position,
        limits: &Limits,
        start: Instant,
        soft_ms: Option<u64>,
        hard_ms: Option<u64>,
    ) -> SearchResult {
        self.start = start;
        self.hard = hard_ms.map(Duration::from_millis);
        self.node_limit = limits.nodes;
        self.stopped = false;
        self.nodes = 0;
        self.root_stm = root.stm;
        self.killers = [[Move::NONE; 2]; MAX_PLY + 2];
        let is_main = self.id == 0;

        let mut legal = MoveList::new();
        generate_legal(root, &mut legal);
        if legal.len == 0 {
            if is_main && !self.silent {
                let s = if root.in_check() { -MATE } else { 0 };
                println!("info depth 0 score {}", format_score(s));
            }
            return SearchResult { best: Move::NONE, score: 0, depth: 0, nodes: 0 };
        }
        let mut best = legal.moves[0];
        if let Some(e) = self.tt.probe(root.hash) {
            if legal.iter().any(|&m| m == e.mv) {
                best = e.mv;
            }
        }
        let mut best_score = 0;
        let mut completed_depth = 0;
        let max_depth = limits.depth.unwrap_or(MAX_PLY as i32 - 4).clamp(1, MAX_PLY as i32 - 4);
        let timed = !limits.infinite && (soft_ms.is_some() || hard_ms.is_some());
        let mut prev_best = Move::NONE;
        let mut stability = 0;
        let mut prev_score = 0;

        // Helper threads start at different depths for diversity.
        let first_depth = if is_main { 1 } else { 1 + (self.id as i32 % 2) };
        let mut depth = first_depth;
        while depth <= max_depth {
            self.seldepth = 0;
            self.root_best = Move::NONE;
            let score = self.aspiration(root, depth, prev_score);
            if self.stopped {
                // accept a fully searched move from the partial iteration
                if !self.root_best.is_none() && completed_depth > 0 {
                    best = self.root_best;
                    best_score = self.root_best_score;
                }
                break;
            }
            completed_depth = depth;
            if !self.pv[0][0].is_none() {
                best = self.pv[0][0];
            }
            best_score = score;
            if is_main && !self.silent {
                self.print_info(depth, score);
            }
            if best == prev_best {
                stability += 1;
            } else {
                stability = 0;
            }
            prev_best = best;

            if is_main && timed {
                if legal.len == 1 {
                    break;
                }
                if let Some(soft) = soft_ms {
                    let elapsed = self.start.elapsed().as_millis() as u64;
                    // extend a bit when the score drops, shrink when the best move is stable
                    let mut scale = 100u64;
                    if depth > 6 && score < prev_score - 40 {
                        scale = 160;
                    } else if stability >= 6 {
                        scale = 80;
                    }
                    let lim = soft * scale / 100;
                    let lim = match hard_ms {
                        Some(h) => lim.min(h),
                        None => lim,
                    };
                    if elapsed >= lim {
                        break;
                    }
                }
            }
            if !limits.infinite && best_score.abs() >= MATE_BOUND && depth >= 8 && is_main {
                // mate found and confirmed at reasonable depth
                let mate_ply = MATE - best_score.abs();
                if depth > mate_ply + 4 {
                    break;
                }
            }
            prev_score = score;
            depth += 1;
        }
        self.shared.nodes[self.id].store(self.nodes, Ordering::Relaxed);
        SearchResult { best, score: best_score, depth: completed_depth, nodes: self.nodes }
    }

    fn print_info(&self, depth: i32, score: i32) {
        let elapsed = self.start.elapsed();
        let ms = elapsed.as_millis() as u64;
        let nodes = self.shared.total_nodes().max(self.nodes);
        let nps = if ms > 0 { nodes * 1000 / ms } else { nodes * 1000 };
        let mut pv = String::new();
        for m in &self.pv[0][..self.pv_len[0]] {
            pv.push(' ');
            pv.push_str(&m.to_uci());
        }
        println!(
            "info depth {} seldepth {} multipv 1 score {} nodes {} nps {} hashfull {} time {} pv{}",
            depth,
            self.seldepth.max(depth as usize),
            format_score(score),
            nodes,
            nps,
            self.tt.hashfull(),
            ms,
            pv
        );
    }

    fn aspiration(&mut self, root: &Position, depth: i32, prev: i32) -> i32 {
        let mut delta = 18;
        let (mut alpha, mut beta) = if depth >= 5 && prev.abs() < MATE_BOUND {
            ((prev - delta).max(-INF), (prev + delta).min(INF))
        } else {
            (-INF, INF)
        };
        loop {
            let score = self.negamax(root, depth, alpha, beta, 0, false);
            if self.stopped {
                return score;
            }
            if score <= alpha {
                beta = (alpha + beta) / 2;
                alpha = (score - delta).max(-INF);
            } else if score >= beta {
                beta = (score + delta).min(INF);
            } else {
                return score;
            }
            delta += delta / 2 + 5;
            if delta > 1000 {
                alpha = -INF;
                beta = INF;
            }
        }
    }

    #[inline]
    fn quiet_score(&self, pos: &Position, m: Move, ply: usize) -> i32 {
        let pc = pos.board[m.from()];
        let to = m.to();
        let mut s = self.history[pos.stm][m.from()][to];
        for back in [1usize, 2] {
            if ply >= back {
                let e = &self.stack[ply - back];
                if e.piece != NO_PIECE {
                    s += self.cont_hist[cont_index(e.piece, e.mv.to(), pc, to)] as i32;
                }
            }
        }
        s
    }

    fn score_moves(&self, pos: &Position, list: &mut MoveList, tt_move: Move, ply: usize) {
        let killers = self.killers[ply];
        let counter = if ply > 0 && self.stack[ply - 1].piece != NO_PIECE {
            let e = &self.stack[ply - 1];
            self.counter[e.piece as usize][e.mv.to()]
        } else {
            Move::NONE
        };
        for i in 0..list.len {
            let m = list.moves[i];
            list.scores[i] = if m == tt_move {
                1_000_000_000
            } else if m.is_tactical() {
                let victim = if m.is_ep() {
                    PAWN
                } else {
                    let pc = pos.board[m.to()];
                    if pc == NO_PIECE {
                        6
                    } else {
                        piece_type(pc)
                    }
                };
                let vval = if victim == 6 { 0 } else { SEE_VALUE[victim] };
                let attacker = piece_type(pos.board[m.from()]);
                let base = vval * 16 - SEE_VALUE[attacker] / 16;
                if m.is_promotion() {
                    if m.promo_piece() == QUEEN {
                        600_000_000 + base
                    } else {
                        -900_000_000 + base
                    }
                } else if pos.see_ge(m, -20) {
                    500_000_000 + base
                } else {
                    -500_000_000 + base
                }
            } else if m == killers[0] {
                400_000_000
            } else if m == killers[1] {
                390_000_000
            } else if m == counter {
                380_000_000
            } else {
                self.quiet_score(pos, m, ply)
            };
        }
    }

    #[inline]
    fn update_quiet_stats(&mut self, pos: &Position, best: Move, quiets: &[Move], depth: i32, ply: usize) {
        let bonus = (depth * depth * 16 + 32 * depth).min(1600);
        let stm = pos.stm;
        let apply = |h: &mut i32, b: i32| {
            *h += b - *h * b.abs() / 16384;
        };
        let apply16 = |h: &mut i16, b: i32| {
            let v = *h as i32;
            *h = (v + b - v * b.abs() / 16384) as i16;
        };
        let prev: [(u8, Square); 2] = [
            if ply >= 1 { (self.stack[ply - 1].piece, self.stack[ply - 1].mv.to()) } else { (NO_PIECE, 0) },
            if ply >= 2 { (self.stack[ply - 2].piece, self.stack[ply - 2].mv.to()) } else { (NO_PIECE, 0) },
        ];
        for &q in quiets.iter().chain(std::iter::once(&best)) {
            let b = if q == best { bonus } else { -bonus };
            apply(&mut self.history[stm][q.from()][q.to()], b);
            let pc = pos.board[q.from()];
            for &(ppc, pto) in &prev {
                if ppc != NO_PIECE {
                    apply16(&mut self.cont_hist[cont_index(ppc, pto, pc, q.to())], b);
                }
            }
        }
        if self.killers[ply][0] != best {
            self.killers[ply][1] = self.killers[ply][0];
            self.killers[ply][0] = best;
        }
        if ply >= 1 && self.stack[ply - 1].piece != NO_PIECE {
            let e = self.stack[ply - 1];
            self.counter[e.piece as usize][e.mv.to()] = best;
        }
    }

    fn negamax(
        &mut self,
        pos: &Position,
        mut depth: i32,
        mut alpha: i32,
        mut beta: i32,
        ply: usize,
        cut_node: bool,
    ) -> i32 {
        let pv_node = beta - alpha > 1;
        let root = ply == 0;
        self.pv_len[ply] = ply;
        let in_check = pos.in_check();
        if in_check {
            depth += 1; // check extension
        }
        if depth <= 0 {
            return self.qsearch(pos, alpha, beta, ply);
        }
        self.nodes += 1;
        if self.nodes & 2047 == 0 {
            self.check_time();
        }
        if self.stopped {
            return 0;
        }
        if ply > self.seldepth {
            self.seldepth = ply;
        }

        if !root {
            if pos.halfmove >= 100 && !in_check {
                return self.draw_score(pos);
            }
            if pos.is_insufficient_material() || self.is_repetition(pos) {
                return self.draw_score(pos);
            }
            if ply >= MAX_PLY - 1 {
                return if in_check { 0 } else { evaluate(pos) };
            }
            // mate distance pruning
            alpha = alpha.max(-MATE + ply as i32);
            beta = beta.min(MATE - ply as i32 - 1);
            if alpha >= beta {
                return alpha;
            }
        }

        // ---- Transposition table ----
        let tte = self.tt.probe(pos.hash);
        let mut tt_move = Move::NONE;
        let mut tt_score = 0;
        let mut tt_bound = BOUND_NONE;
        if let Some(e) = tte {
            tt_move = e.mv;
            tt_score = score_from_tt(e.score, ply);
            tt_bound = e.bound;
            if !pv_node && e.depth >= depth {
                match e.bound {
                    BOUND_EXACT => return tt_score,
                    BOUND_LOWER if tt_score >= beta => return tt_score,
                    BOUND_UPPER if tt_score <= alpha => return tt_score,
                    _ => {}
                }
            }
        }

        // ---- Static evaluation ----
        let raw_eval;
        let mut eval;
        if in_check {
            raw_eval = EVAL_NONE;
            eval = EVAL_NONE;
        } else {
            raw_eval = match tte {
                Some(e) if e.eval != EVAL_NONE => e.eval,
                _ => evaluate(pos),
            };
            eval = raw_eval;
            if tte.is_some()
                && tt_score.abs() < MATE_BOUND
                && ((tt_bound == BOUND_LOWER && tt_score > eval)
                    || (tt_bound == BOUND_UPPER && tt_score < eval)
                    || tt_bound == BOUND_EXACT)
            {
                eval = tt_score;
            }
        }
        self.stack[ply].eval = raw_eval;
        let improving = !in_check
            && ply >= 2
            && (self.stack[ply - 2].eval == EVAL_NONE || raw_eval > self.stack[ply - 2].eval);
        self.killers[ply + 1] = [Move::NONE; 2];

        if !pv_node && !in_check {
            // ---- Reverse futility pruning ----
            if depth <= 8
                && eval.abs() < MATE_BOUND
                && eval - (80 * depth - if improving { 70 } else { 0 }) >= beta
            {
                return eval;
            }
            // ---- Null-move pruning (not in pawn-only endings: zugzwang guard) ----
            if depth >= 3
                && eval >= beta
                && ply >= 1
                && self.stack[ply - 1].piece != NO_PIECE
                && pos.has_non_pawn_material(pos.stm)
                && beta.abs() < MATE_BOUND
            {
                let r = 3 + depth / 3 + ((eval - beta) / 200).min(3);
                let mut child = *pos;
                child.make_null();
                self.stack[ply].mv = Move::NONE;
                self.stack[ply].piece = NO_PIECE;
                self.keys.push(pos.hash);
                let s = -self.negamax(&child, depth - r, -beta, -beta + 1, ply + 1, !cut_node);
                self.keys.pop();
                if self.stopped {
                    return 0;
                }
                if s >= beta {
                    return if s >= MATE_BOUND { beta } else { s };
                }
            }
        }

        // ---- Internal iterative reduction ----
        if depth >= 4 && tt_move.is_none() && (pv_node || cut_node) {
            depth -= 1;
        }

        let mut list = MoveList::new();
        generate(pos, &mut list, false);
        self.score_moves(pos, &mut list, tt_move, ply);
        let pinned = pos.pinned();

        let mut best_score = -INF;
        let mut best_move = Move::NONE;
        let mut moves_searched = 0usize;
        let mut quiets: [Move; 64] = [Move::NONE; 64];
        let mut n_quiets = 0usize;
        let mut skip_quiets = false;
        let orig_alpha = alpha;
        let lmr = lmr_table();

        for i in 0..list.len {
            let m = list.pick(i);
            if !pos.is_legal(m, pinned) {
                continue;
            }
            let is_quiet = !m.is_tactical();
            if is_quiet && skip_quiets {
                continue;
            }
            let hist = if is_quiet { self.quiet_score(pos, m, ply) } else { 0 };

            // ---- Move-loop pruning ----
            if !root && best_score > -MATE_BOUND && pos.has_non_pawn_material(pos.stm) {
                if is_quiet {
                    let lmp = (3 + depth * depth) / if improving { 1 } else { 2 };
                    if !in_check && depth <= 8 && moves_searched as i32 >= lmp {
                        skip_quiets = true;
                        continue;
                    }
                    if !in_check && depth <= 8 && eval + 100 + 90 * depth <= alpha {
                        skip_quiets = true;
                        continue;
                    }
                    if depth <= 3 && hist < -2000 * depth && moves_searched > 0 {
                        continue;
                    }
                    if depth <= 8 && !pos.see_ge(m, -60 * depth) {
                        continue;
                    }
                } else if depth <= 8 && !pos.see_ge(m, -100 * depth) {
                    continue;
                }
            }

            let mut child = *pos;
            child.make_move(m);
            let gives_check = child.in_check();
            self.stack[ply].mv = m;
            self.stack[ply].piece = pos.board[m.from()];
            self.keys.push(pos.hash);

            let new_depth = depth - 1;
            let mut score;
            if moves_searched == 0 {
                score = -self.negamax(&child, new_depth, -beta, -alpha, ply + 1, !pv_node && !cut_node);
            } else {
                // ---- Late move reductions ----
                let mut r = 0;
                if depth >= 3 && moves_searched >= 1 + (pv_node as usize) {
                    r = lmr[(depth as usize).min(63)][moves_searched.min(63)];
                    if is_quiet {
                        if !pv_node {
                            r += 1;
                        }
                        if !improving {
                            r += 1;
                        }
                        if cut_node {
                            r += 1;
                        }
                        if m == self.killers[ply][0] || m == self.killers[ply][1] {
                            r -= 1;
                        }
                        r -= hist / 8000;
                    } else {
                        // bad captures only (good ones scored above quiets)
                        if list.scores[i] > 0 {
                            r = 0;
                        } else {
                            r = r / 2;
                        }
                    }
                    if gives_check || in_check {
                        r -= 1;
                    }
                    r = r.clamp(0, new_depth - 1);
                    r = r.max(0);
                }
                score = -self.negamax(&child, new_depth - r, -alpha - 1, -alpha, ply + 1, true);
                if score > alpha && r > 0 {
                    score = -self.negamax(&child, new_depth, -alpha - 1, -alpha, ply + 1, !cut_node);
                }
                if score > alpha && score < beta {
                    score = -self.negamax(&child, new_depth, -beta, -alpha, ply + 1, false);
                }
            }
            self.keys.pop();
            if self.stopped {
                return 0;
            }
            moves_searched += 1;

            if score > best_score {
                best_score = score;
                if score > alpha {
                    best_move = m;
                    alpha = score;
                    // update PV
                    self.pv[ply][ply] = m;
                    let child_len = self.pv_len[ply + 1].max(ply + 1);
                    for j in (ply + 1)..child_len {
                        self.pv[ply][j] = self.pv[ply + 1][j];
                    }
                    self.pv_len[ply] = child_len;
                    if root {
                        self.root_best = m;
                        self.root_best_score = score;
                    }
                    if score >= beta {
                        if is_quiet {
                            self.update_quiet_stats(pos, m, &quiets[..n_quiets], depth, ply);
                        }
                        break;
                    }
                }
            }
            if is_quiet && m != best_move && n_quiets < 64 {
                quiets[n_quiets] = m;
                n_quiets += 1;
            }
        }

        if moves_searched == 0 {
            return if in_check { -MATE + ply as i32 } else { self.draw_score(pos) };
        }

        let bound = if best_score >= beta {
            BOUND_LOWER
        } else if alpha > orig_alpha {
            BOUND_EXACT
        } else {
            BOUND_UPPER
        };
        self.tt.store(pos.hash, best_move, score_to_tt(best_score, ply), raw_eval, depth, bound);
        best_score
    }

    fn qsearch(&mut self, pos: &Position, mut alpha: i32, beta: i32, ply: usize) -> i32 {
        self.nodes += 1;
        if self.nodes & 2047 == 0 {
            self.check_time();
        }
        if self.stopped {
            return 0;
        }
        self.pv_len[ply] = ply;
        if ply > self.seldepth {
            self.seldepth = ply;
        }
        let in_check = pos.in_check();
        if ply >= MAX_PLY - 1 {
            return if in_check { 0 } else { evaluate(pos) };
        }
        if pos.is_insufficient_material() {
            return self.draw_score(pos);
        }

        let tte = self.tt.probe(pos.hash);
        let mut tt_move = Move::NONE;
        if let Some(e) = tte {
            tt_move = e.mv;
            let s = score_from_tt(e.score, ply);
            match e.bound {
                BOUND_EXACT => return s,
                BOUND_LOWER if s >= beta => return s,
                BOUND_UPPER if s <= alpha => return s,
                _ => {}
            }
        }

        let mut best_score;
        let raw_eval;
        if in_check {
            best_score = -INF;
            raw_eval = EVAL_NONE;
        } else {
            raw_eval = match tte {
                Some(e) if e.eval != EVAL_NONE => e.eval,
                _ => evaluate(pos),
            };
            best_score = raw_eval;
            if best_score >= beta {
                return best_score;
            }
            if best_score > alpha {
                alpha = best_score;
            }
        }
        let stand_pat = best_score;

        let mut list = MoveList::new();
        generate(pos, &mut list, !in_check);
        self.score_moves(pos, &mut list, tt_move, ply);
        let pinned = pos.pinned();
        let mut best_move = Move::NONE;
        let mut legal = 0;
        let orig_alpha = alpha;

        for i in 0..list.len {
            let m = list.pick(i);
            if !pos.is_legal(m, pinned) {
                continue;
            }
            legal += 1;
            if !in_check {
                // delta pruning
                if !m.is_promotion() {
                    let victim = if m.is_ep() { PAWN } else { piece_type(pos.board[m.to()]) };
                    if stand_pat + SEE_VALUE[victim] + 200 <= alpha {
                        continue;
                    }
                }
                if !pos.see_ge(m, 0) {
                    continue;
                }
            } else if best_score > -MATE_BOUND && !m.is_tactical() && legal > 2 {
                // in check: after a couple of evasions, skip quiet evasions that lose material
                if !pos.see_ge(m, 0) {
                    continue;
                }
            }
            let mut child = *pos;
            child.make_move(m);
            let score = -self.qsearch(&child, -beta, -alpha, ply + 1);
            if self.stopped {
                return 0;
            }
            if score > best_score {
                best_score = score;
                if score > alpha {
                    alpha = score;
                    best_move = m;
                    if score >= beta {
                        break;
                    }
                }
            }
        }
        if in_check && legal == 0 {
            return -MATE + ply as i32;
        }
        let bound = if best_score >= beta {
            BOUND_LOWER
        } else if alpha > orig_alpha {
            BOUND_EXACT
        } else {
            BOUND_UPPER
        };
        self.tt.store(pos.hash, best_move, score_to_tt(best_score, ply), raw_eval, 0, bound);
        best_score
    }
}
