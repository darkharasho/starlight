//! Pointer scan and rescan (D20): find module-relative pointer paths to a heap address.
//!
//! A reverse index of every 8-aligned qword that points into scannable memory is built once, then
//! the scan walks back from the target one level at a time, CE-style.
use crate::cleanup::{Owner, Teardown};
use crate::process::Target;
use crate::rpc::RpcError;
use crate::{maps, mem, modules, pointer, regions};
use serde::{Serialize, Serializer};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const DEFAULT_DEPTH: u8 = 5;
pub const MAX_DEPTH: u8 = 7;
pub const DEFAULT_OFFSET: u64 = 0x1000;
pub const MAX_OFFSET: u64 = 0x10000;
pub const DEFAULT_RESULTS: usize = 10_000;
pub const MAX_RESULTS: usize = 100_000;
/// Entries kept to expand at each level.
const FRONTIER_CAP: usize = 100_000;
/// Index entries (16 bytes each) before the scan gives up as too big.
const INDEX_CAP: usize = 50_000_000;
/// Bytes read per `process_vm_readv` call while indexing.
const CHUNK: u64 = 4 << 20;
const PAGE: u64 = 4096;

#[derive(Debug, Clone)]
pub struct Opts {
    pub max_depth: u8,
    pub max_offset: u64,
    pub max_results: usize,
    /// Only let paths end in these modules (by name); `None` means any.
    pub modules: Option<Vec<String>>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { max_depth: DEFAULT_DEPTH, max_offset: DEFAULT_OFFSET, max_results: DEFAULT_RESULTS, modules: None }
    }
}

/// `addr = module_base + base`, then `addr = read_u64(addr) + off` for each offset: exactly
/// `pointer::resolve`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Path {
    pub module: String,
    #[serde(serialize_with = "ser_hex")]
    pub base: u64,
    #[serde(serialize_with = "ser_hex_vec")]
    pub offsets: Vec<u64>,
}

fn ser_hex<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format!("{v:#x}"))
}

fn ser_hex_vec<S: Serializer>(v: &[u64], s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(v.iter().map(|o| format!("{o:#x}")))
}

/// A module image a path may end in.
#[derive(Debug, Clone)]
pub struct ModuleRange {
    pub name: String,
    pub base: u64,
    pub end: u64,
}

fn exited(t: &Target) -> RpcError {
    RpcError::process_not_found(format!("pid {} has exited", t.pid))
}

fn module_ranges(t: &Target, only: &Option<Vec<String>>) -> Result<Vec<ModuleRange>, RpcError> {
    let mut v: Vec<ModuleRange> = modules::list(t)?
        .into_iter()
        .filter(|m| only.as_ref().map_or(true, |names| names.iter().any(|n| n.eq_ignore_ascii_case(&m.name))))
        .map(|m| ModuleRange { name: m.name, base: m.base, end: m.base.saturating_add(m.size) })
        .collect();
    v.sort_by_key(|m| m.base);
    Ok(v)
}

/// Scan `t` for paths to `target`.
/// The second value is true if the frontier cap or `max_results` cut the results short.
pub fn scan(t: &Target, target: u64, opts: &Opts) -> Result<(Vec<Path>, bool), RpcError> {
    if t.exited() {
        return Err(exited(t));
    }
    let maps = maps::read(t.pid).map_err(|e| match e.raw_os_error() {
        Some(libc::ENOENT) | Some(libc::ESRCH) => exited(t),
        _ => RpcError::read_failed(format!("cannot read maps of pid {}: {e}", t.pid)),
    })?;
    let ranges = regions::scannable(&maps);
    let mods = module_ranges(t, &opts.modules)?;
    let paths = scan_with(&ranges, &mods, |a, n| mem::read_bytes(t, a, n).ok(), target, opts, INDEX_CAP)?;
    if t.exited() {
        return Err(exited(t));
    }
    Ok(paths)
}

/// Core of `scan` over an abstract memory: `ranges` are the regions to index (and the only places
/// a pointer may point), `mods` (sorted by base) the images that end a path.
pub fn scan_with(
    ranges: &[(u64, u64)],
    mods: &[ModuleRange],
    read: impl Fn(u64, usize) -> Option<Vec<u8>>,
    target: u64,
    opts: &Opts,
    index_cap: usize,
) -> Result<(Vec<Path>, bool), RpcError> {
    let mut ranges = ranges.to_vec();
    ranges.sort_unstable();
    let index = build_index(&ranges, &read, index_cap)?;
    Ok(walk(&index, mods, target, opts))
}

fn in_ranges(ranges: &[(u64, u64)], v: u64) -> bool {
    let i = ranges.partition_point(|r| r.0 <= v);
    i > 0 && v < ranges[i - 1].1
}

/// `(value, location)` of every aligned qword whose value points into `ranges`, sorted.
fn build_index(ranges: &[(u64, u64)], read: &impl Fn(u64, usize) -> Option<Vec<u8>>, cap: usize) -> Result<Vec<(u64, u64)>, RpcError> {
    let (Some(lo), Some(hi)) = (ranges.first().map(|r| r.0), ranges.iter().map(|r| r.1).max()) else {
        return Ok(vec![]);
    };
    let mut index: Vec<(u64, u64)> = Vec::new();
    let mut add = |base: u64, buf: &[u8]| -> Result<(), RpcError> {
        for (i, q) in buf.chunks_exact(8).enumerate() {
            let v = u64::from_le_bytes(q.try_into().unwrap());
            if v >= lo && v < hi && in_ranges(ranges, v) {
                if index.len() >= cap {
                    return Err(RpcError::invalid_params("too much memory to pointer scan: the process has too many pointers; try a smaller max_depth or a more specific target"));
                }
                index.push((v, base + i as u64 * 8));
            }
        }
        Ok(())
    };
    for &(start, end) in ranges {
        // Locations are 8-aligned absolute addresses.
        let mut a = start.checked_add(7).map_or(start, |x| x & !7);
        while a < end {
            let n = CHUNK.min(end - a) & !7;
            if n == 0 {
                break;
            }
            match read(a, n as usize) {
                Some(buf) => add(a, &buf)?,
                None => {
                    // Part of the chunk is unreadable: salvage it page by page.
                    let mut p = a;
                    while p < a + n {
                        let m = (PAGE - p % PAGE).min(a + n - p) & !7;
                        if m > 0 {
                            if let Some(buf) = read(p, m as usize) {
                                add(p, &buf)?;
                            }
                        }
                        p += (PAGE - p % PAGE).max(8);
                    }
                }
            }
            a += n;
        }
    }
    index.sort_unstable();
    Ok(index)
}

fn walk(index: &[(u64, u64)], mods: &[ModuleRange], target: u64, opts: &Opts) -> (Vec<Path>, bool) {
    let module_of = |loc: u64| -> Option<&ModuleRange> {
        let i = mods.partition_point(|m| m.base <= loc);
        (i > 0 && loc < mods[i - 1].end).then(|| &mods[i - 1])
    };
    let mut results: Vec<Path> = vec![];
    let mut truncated = false;
    let mut visited: HashSet<u64> = HashSet::from([target]);
    // `(address to find pointers to, offsets of the chain from here to the target)`
    let mut frontier: Vec<(u64, Vec<u64>)> = vec![(target, vec![])];
    'levels: for depth in 1..=opts.max_depth {
        let mut next: Vec<(u64, Vec<u64>)> = vec![];
        for (addr, chain) in &frontier {
            let lo = addr.saturating_sub(opts.max_offset);
            let from = index.partition_point(|e| e.0 < lo);
            for &(value, loc) in index[from..].iter().take_while(|e| e.0 <= *addr) {
                let hit = module_of(loc);
                // Decide before allocating the chain: most index hits are neither.
                if hit.is_none() && (depth >= opts.max_depth || visited.contains(&loc)) {
                    continue;
                }
                if hit.is_none() && next.len() >= FRONTIER_CAP {
                    truncated = true;
                    continue;
                }
                let mut offsets = Vec::with_capacity(chain.len() + 1);
                offsets.push(addr - value);
                offsets.extend_from_slice(chain);
                if let Some(m) = hit {
                    results.push(Path { module: m.name.clone(), base: loc - m.base, offsets });
                    if results.len() >= opts.max_results {
                        truncated = true;
                        break 'levels;
                    }
                } else {
                    visited.insert(loc);
                    next.push((loc, offsets));
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    results.sort_by(|a, b| {
        let key = |p: &Path| (p.offsets.len(), p.offsets.iter().fold(0u64, |s, o| s.saturating_add(*o)));
        key(a).cmp(&key(b)).then_with(|| (&a.module, a.base, &a.offsets).cmp(&(&b.module, b.base, &b.offsets)))
    });
    (results, truncated)
}

struct Session {
    paths: Mutex<Vec<Path>>,
    /// The last address the paths were known to resolve to (the scan's target, then the latest
    /// successful rescan's); `rescan` without an address uses it.
    address: AtomicU64,
    token: AtomicU64,
}

/// Pointer-scan sessions of one connection. They belong to the connection, not a handle, so a
/// rescan can run against a new handle after the game restarts.
pub struct PointerScans {
    owner: Arc<Owner>,
    inner: Arc<Mutex<(u32, HashMap<u32, Arc<Session>>)>>,
}

impl PointerScans {
    pub fn new(owner: Arc<Owner>) -> Self {
        PointerScans { owner, inner: Arc::new(Mutex::new((0, HashMap::new()))) }
    }

    /// Scan `t` for paths to `address` and keep them as a session. Returns `(id, count, truncated)`.
    pub fn start(&self, t: &Target, address: u64, opts: &Opts) -> Result<(u32, u64, bool), RpcError> {
        let (paths, truncated) = scan(t, address, opts)?;
        let count = paths.len() as u64;
        let session = Arc::new(Session { paths: Mutex::new(paths), address: AtomicU64::new(address), token: AtomicU64::new(0) });
        let id = {
            let mut g = self.inner.lock().unwrap();
            g.0 += 1;
            let id = g.0;
            g.1.insert(id, session.clone());
            id
        };
        let inner = self.inner.clone();
        let token = self.owner.add(None, Teardown::Scan, Box::new(move || {
            inner.lock().unwrap().1.remove(&id);
        }));
        session.token.store(token, Ordering::Relaxed);
        Ok((id, count, truncated))
    }

    fn get(&self, id: u32) -> Result<Arc<Session>, RpcError> {
        self.inner.lock().unwrap().1.get(&id).cloned().ok_or_else(|| RpcError::unknown_id(format!("unknown pointer scan: {id}")))
    }

    /// The count, and paths `offset .. offset + limit`.
    pub fn results(&self, id: u32, offset: u64, limit: usize) -> Result<(u64, Vec<Path>), RpcError> {
        let s = self.get(id)?;
        let paths = s.paths.lock().unwrap();
        let from = usize::try_from(offset).unwrap_or(usize::MAX).min(paths.len());
        Ok((paths.len() as u64, paths[from..].iter().take(limit).cloned().collect()))
    }

    /// Keep only the paths that still resolve to `address` (default: the session's last good
    /// target) in `t`. Returns the new count. A rescan that keeps nothing returns 0 and leaves the
    /// session's paths and target as they were, so a rescan at a bad moment (the game still
    /// loading, a wrong address) never throws the results away.
    pub fn rescan(&self, id: u32, t: &Target, address: Option<u64>) -> Result<u64, RpcError> {
        let s = self.get(id)?;
        let want = address.unwrap_or_else(|| s.address.load(Ordering::Relaxed));
        if t.exited() {
            return Err(exited(t));
        }
        let old: Vec<Path> = s.paths.lock().unwrap().clone();
        let mods = modules::list(t)?;
        let kept: Vec<Path> = old
            .into_iter()
            .filter(|p| {
                let Some(m) = modules::find(&mods, &p.module) else { return false };
                pointer::resolve(t, m.base.wrapping_add(p.base), &p.offsets, 8).map_or(false, |a| a == want)
            })
            .collect();
        if t.exited() {
            return Err(exited(t));
        }
        let count = kept.len() as u64;
        if count == 0 {
            return Ok(0);
        }
        *s.paths.lock().unwrap() = kept;
        s.address.store(want, Ordering::Relaxed);
        Ok(count)
    }

    pub fn end(&self, id: u32) -> Result<(), RpcError> {
        let s = self.inner.lock().unwrap().1.remove(&id).ok_or_else(|| RpcError::unknown_id(format!("unknown pointer scan: {id}")))?;
        self.owner.remove(s.token.load(Ordering::Relaxed));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sparse memory: qwords at the given addresses, everything else unreadable zeros.
    fn mem(words: &[(u64, u64)]) -> impl Fn(u64, usize) -> Option<Vec<u8>> + '_ {
        move |addr, len| {
            let mut b = vec![0u8; len];
            for &(a, v) in words {
                if a >= addr && a + 8 <= addr + len as u64 {
                    b[(a - addr) as usize..(a - addr) as usize + 8].copy_from_slice(&v.to_le_bytes());
                }
            }
            Some(b)
        }
    }

    fn mods() -> Vec<ModuleRange> {
        vec![ModuleRange { name: "game".into(), base: 0x40_0000, end: 0x40_1000 }]
    }

    fn run(words: &[(u64, u64)], target: u64, opts: Opts) -> Vec<Path> {
        scan_with(&[(0x40_0000, 0x40_1000), (0x1_0000, 0x2_0000)], &mods(), mem(words), target, &opts, INDEX_CAP).unwrap().0
    }

    #[test]
    fn three_level_chain_ends_in_the_module() {
        // game+0x10 -> 0x10000 ; [0x10000+0x20] -> 0x11000 ; [0x11000+0x8] -> 0x12000 ; target 0x12000+0x4
        let words = [(0x40_0010, 0x1_0000), (0x1_0020, 0x1_1000), (0x1_1008, 0x1_2000)];
        let p = run(&words, 0x1_2004, Opts::default());
        assert_eq!(p, vec![Path { module: "game".into(), base: 0x10, offsets: vec![0x20, 0x8, 0x4] }]);
    }

    #[test]
    fn depth_limit_drops_deeper_paths() {
        let words = [(0x40_0010, 0x1_0000), (0x1_0020, 0x1_1000), (0x1_1008, 0x1_2000)];
        let opts = Opts { max_depth: 2, ..Opts::default() };
        assert!(run(&words, 0x1_2004, opts).is_empty());
        let opts = Opts { max_depth: 3, ..Opts::default() };
        assert_eq!(run(&words, 0x1_2004, opts).len(), 1);
    }

    #[test]
    fn a_cycle_does_not_loop_and_still_finds_the_way_out() {
        // A(0x10000+0x10) -> B ; B(0x11000+0x10) -> A ; module -> A ; target inside B
        let words = [(0x1_0010, 0x1_1000), (0x1_1010, 0x1_0000), (0x40_0000, 0x1_0000)];
        let p = run(&words, 0x1_1008, Opts { max_depth: 7, ..Opts::default() });
        assert_eq!(p, vec![Path { module: "game".into(), base: 0, offsets: vec![0x10, 0x8] }]);
    }

    #[test]
    fn max_offset_cuts_distant_pointers() {
        let words = [(0x40_0000, 0x1_0000)];
        let near = Opts { max_offset: 0x100, ..Opts::default() };
        assert!(run(&words, 0x1_0200, near.clone()).is_empty());
        assert_eq!(run(&words, 0x1_0100, near).len(), 1);
    }

    #[test]
    fn max_results_caps_output_and_shallow_paths_sort_first() {
        let words = [(0x40_0000, 0x1_0000), (0x40_0008, 0x1_0008), (0x1_0100, 0x1_0010), (0x40_0010, 0x1_0100)];
        let all = run(&words, 0x1_0010, Opts::default());
        assert!(all.len() >= 3);
        assert!(all.windows(2).all(|w| w[0].offsets.len() <= w[1].offsets.len()));
        let one = run(&words, 0x1_0010, Opts { max_results: 1, ..Opts::default() });
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn unreadable_chunks_are_salvaged_per_page() {
        let words = [(0x40_0000u64, 0x1_0000u64)];
        let m = mem(&words);
        // Reads that span more than a page fail; single pages succeed.
        let p = scan_with(&[(0x40_0000, 0x40_1000), (0x1_0000, 0x1_4000)], &mods(), |a, n| if n > 4096 { None } else { m(a, n) }, 0x1_0008, &Opts::default(), INDEX_CAP).unwrap().0;
        assert_eq!(p.len(), 1);
    }

    #[test]
    fn over_the_index_cap_is_too_much_memory() {
        let words = [(0x40_0000, 0x1_0000), (0x40_0008, 0x1_0008), (0x40_0010, 0x1_0010)];
        let e = scan_with(&[(0x40_0000, 0x40_1000), (0x1_0000, 0x2_0000)], &mods(), mem(&words), 0x1_0000, &Opts::default(), 2).unwrap_err();
        assert_eq!(e.code, -32602);
        assert!(e.message.contains("too much memory"), "{}", e.message);
    }

    #[test]
    fn truncated_reports_a_max_results_cut() {
        let words = [(0x40_0000, 0x1_0000), (0x40_0008, 0x1_0008)];
        let go = |max_results| scan_with(&[(0x40_0000, 0x40_1000), (0x1_0000, 0x2_0000)], &mods(), mem(&words), 0x1_0010, &Opts { max_results, ..Opts::default() }, INDEX_CAP).unwrap();
        let (p, cut) = go(1);
        assert_eq!((p.len(), cut), (1, true));
        let (p, cut) = go(10);
        assert_eq!((p.len(), cut), (2, false));
    }

    #[test]
    fn paths_serialize_with_hex_offsets() {
        let v = serde_json::to_value(Path { module: "g".into(), base: 0x20, offsets: vec![0x18, 0x10] }).unwrap();
        assert_eq!(v, serde_json::json!({"module": "g", "base": "0x20", "offsets": ["0x18", "0x10"]}));
    }
}
