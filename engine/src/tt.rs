//! Lock-free shared transposition table (key XOR data verification).

use crate::types::Move;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

pub const BOUND_NONE: u8 = 0;
pub const BOUND_UPPER: u8 = 1;
pub const BOUND_LOWER: u8 = 2;
pub const BOUND_EXACT: u8 = 3;

#[derive(Clone, Copy, Debug)]
pub struct TTEntry {
    pub mv: Move,
    pub score: i32,
    pub eval: i32,
    pub depth: i32,
    pub bound: u8,
}

struct Slot {
    key: AtomicU64,
    data: AtomicU64,
}

pub struct TT {
    slots: Vec<Slot>,
    age: AtomicU8,
}

#[inline(always)]
fn pack(mv: Move, score: i32, eval: i32, depth: i32, bound: u8, age: u8) -> u64 {
    (mv.0 as u64)
        | (((score as i16) as u16 as u64) << 16)
        | (((eval as i16) as u16 as u64) << 32)
        | (((depth.clamp(-1, 254) + 1) as u8 as u64) << 48)
        | (((bound & 3) | (age << 2)) as u64) << 56
}

impl TT {
    pub fn new(mb: usize) -> TT {
        let n = (mb.max(1) * 1024 * 1024) / std::mem::size_of::<Slot>();
        let mut slots = Vec::with_capacity(n);
        for _ in 0..n {
            slots.push(Slot { key: AtomicU64::new(0), data: AtomicU64::new(0) });
        }
        TT { slots, age: AtomicU8::new(0) }
    }

    pub fn clear(&self) {
        for s in &self.slots {
            s.key.store(0, Ordering::Relaxed);
            s.data.store(0, Ordering::Relaxed);
        }
        self.age.store(0, Ordering::Relaxed);
    }

    pub fn new_search(&self) {
        let a = self.age.load(Ordering::Relaxed);
        self.age.store((a + 1) & 63, Ordering::Relaxed);
    }

    #[inline(always)]
    fn index(&self, key: u64) -> usize {
        ((key as u128 * self.slots.len() as u128) >> 64) as usize
    }

    #[inline(always)]
    pub fn prefetch(&self, _key: u64) {}

    #[inline]
    pub fn probe(&self, key: u64) -> Option<TTEntry> {
        let s = unsafe { self.slots.get_unchecked(self.index(key)) };
        let data = s.data.load(Ordering::Relaxed);
        let k = s.key.load(Ordering::Relaxed);
        if k ^ data != key || data == 0 {
            return None;
        }
        Some(TTEntry {
            mv: Move(data as u16),
            score: (data >> 16) as u16 as i16 as i32,
            eval: (data >> 32) as u16 as i16 as i32,
            depth: ((data >> 48) & 0xFF) as i32 - 1,
            bound: ((data >> 56) & 3) as u8,
        })
    }

    #[inline]
    pub fn store(&self, key: u64, mv: Move, score: i32, eval: i32, depth: i32, bound: u8) {
        let s = unsafe { self.slots.get_unchecked(self.index(key)) };
        let old_data = s.data.load(Ordering::Relaxed);
        let old_key = s.key.load(Ordering::Relaxed) ^ old_data;
        let age = self.age.load(Ordering::Relaxed);
        let old_depth = ((old_data >> 48) & 0xFF) as i32 - 1;
        let old_age = ((old_data >> 58) & 63) as u8;
        let same = old_key == key && old_data != 0;
        // Replacement: prefer entries from the current search with more depth,
        // but always accept exact bounds and anything replacing stale entries.
        if bound != BOUND_EXACT && old_age == age && old_data != 0 {
            if same && old_depth >= depth + 4 {
                return;
            }
            if !same && old_depth > depth + 3 {
                return;
            }
        }
        let mv = if mv.is_none() && same { Move(old_data as u16) } else { mv };
        let data = pack(mv, score, eval, depth, bound, age);
        s.key.store(key ^ data, Ordering::Relaxed);
        s.data.store(data, Ordering::Relaxed);
    }

    /// Permille of entries written in the current search.
    pub fn hashfull(&self) -> usize {
        let age = self.age.load(Ordering::Relaxed);
        let n = self.slots.len().min(1000);
        let mut used = 0;
        for s in &self.slots[..n] {
            let d = s.data.load(Ordering::Relaxed);
            if d != 0 && ((d >> 58) & 63) as u8 == age {
                used += 1;
            }
        }
        used * 1000 / n.max(1)
    }
}
