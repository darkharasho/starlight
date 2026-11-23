//! Candidate storage for value scans (D18).
//!
//! `Sparse` keeps each candidate's address and its bytes at the last scan. `Dense` is for
//! `unknown` first scans: every region's bytes are snapshotted into an unlinked file and a bitmap
//! holds one bit per aligned slot. Each region's bits start on a fresh `u64` word, and a chunk's
//! slots start on a word too (`CHUNK / align` is a multiple of 64), so worker threads own
//! disjoint words.
use std::fs::File;
use std::io;
use std::os::unix::fs::FileExt;
use std::sync::Mutex;

#[cfg(not(test))]
pub const CHUNK: usize = 1 << 20;
/// Small in unit tests so chunk boundaries are exercised; still a multiple of 64 × 4096.
#[cfg(test)]
pub const CHUNK: usize = 1 << 18;

/// A dense session becomes sparse once it has at most this many candidates.
pub const SPARSE_MAX: u64 = 1_000_000;

/// Largest supported alignment: `CHUNK / align` must stay a multiple of 64.
pub const MAX_ALIGN: usize = 4096;

const THREADS: usize = 4;
/// Sparse reads batch neighbours closer than this into one read.
const SPARSE_GAP: u64 = 4096;
/// Candidates per sparse work item.
const SPARSE_JOB: usize = 1 << 16;

/// Reads `len` bytes at an address in the target, or `None` if any of them is unreadable.
pub type Reader<'a> = &'a (dyn Fn(u64, usize) -> Option<Vec<u8>> + Sync);

/// Slot shape: bytes per candidate and the step between candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub width: usize,
    pub align: usize,
}

pub enum Store {
    Sparse { addrs: Vec<u64>, prev: Vec<u8> },
    Dense { file: File, regions: Vec<(u64, u64)>, bitmap: Vec<u64>, count: u64 },
}

/// Where one region lives in the snapshot file and the bitmap.
struct Lay {
    start: u64,
    len: u64,
    file_off: u64,
    word_off: usize,
    words: usize,
    slots: u64,
}

fn slots(len: u64, g: Geometry) -> u64 {
    if len < g.width as u64 {
        0
    } else {
        (len - g.width as u64) / g.align as u64 + 1
    }
}

fn layout(regions: &[(u64, u64)], g: Geometry) -> (Vec<Lay>, usize) {
    let (mut file_off, mut word_off) = (0u64, 0usize);
    let lays = regions
        .iter()
        .map(|&(start, end)| {
            let len = end - start;
            let slots = slots(len, g);
            let words = slots.div_ceil(64) as usize;
            let l = Lay { start, len, file_off, word_off, words, slots };
            file_off += len;
            word_off += words;
            l
        })
        .collect();
    (lays, word_off)
}

fn words_per_chunk(g: Geometry) -> usize {
    CHUNK / g.align / 64
}

/// Bits of `slots` set, from the first, in `words`.
fn fill(words: &mut [u64], slots: u64) {
    for (i, w) in words.iter_mut().enumerate() {
        let left = slots.saturating_sub(i as u64 * 64);
        *w = if left >= 64 { u64::MAX } else { (1u64 << left) - 1 };
    }
}

fn popcount(words: &[u64]) -> u64 {
    words.iter().map(|w| w.count_ones() as u64).sum()
}

/// Run `f` over `jobs` on up to `THREADS` threads; results keep the jobs' order.
fn par_map<J: Send, R: Send>(jobs: Vec<J>, f: impl Fn(J) -> R + Sync) -> Vec<R> {
    let n = jobs.len();
    let queue = Mutex::new(jobs.into_iter().enumerate());
    let out: Mutex<Vec<Option<R>>> = Mutex::new((0..n).map(|_| None).collect());
    std::thread::scope(|s| {
        for _ in 0..THREADS.min(n) {
            s.spawn(|| loop {
                let Some((i, job)) = queue.lock().unwrap().next() else { break };
                let r = f(job);
                out.lock().unwrap()[i] = Some(r);
            });
        }
    });
    out.into_inner().unwrap().into_iter().map(|r| r.expect("every job ran")).collect()
}

/// A dense pass's unit of work: one chunk of one region and that chunk's bitmap words.
struct Chunk<'a> {
    lay: &'a Lay,
    /// Offset of the chunk inside its region (a multiple of `CHUNK`).
    off: u64,
    words: &'a mut [u64],
}

impl Chunk<'_> {
    /// Slots whose first byte lies in this chunk.
    fn slots(&self, g: Geometry) -> u64 {
        let first = self.off / g.align as u64;
        self.lay.slots.saturating_sub(first).min((CHUNK / g.align) as u64)
    }

    /// Bytes this chunk owns: `[off, off + CHUNK)` clipped to the region.
    fn own_len(&self) -> usize {
        (self.lay.len - self.off).min(CHUNK as u64) as usize
    }

    /// Bytes needed to test every slot: the owned bytes plus the tail of a slot straddling the end.
    fn read_len(&self, g: Geometry) -> usize {
        (self.lay.len - self.off).min((CHUNK + g.width - 1) as u64) as usize
    }
}

fn chunks<'a>(lays: &'a [Lay], bitmap: &'a mut [u64], g: Geometry) -> Vec<Chunk<'a>> {
    let mut out = vec![];
    let mut rest = bitmap;
    for lay in lays {
        let (mut mine, tail) = std::mem::take(&mut rest).split_at_mut(lay.words);
        rest = tail;
        // By bytes, not words: a last chunk may hold no slot starts yet still hold the tail of
        // a slot straddling into it, so it must be snapshotted too.
        for i in 0..lay.len.div_ceil(CHUNK as u64) {
            let n = words_per_chunk(g).min(mine.len());
            let (words, more) = std::mem::take(&mut mine).split_at_mut(n);
            mine = more;
            out.push(Chunk { lay, off: i * CHUNK as u64, words });
        }
    }
    out
}

impl Store {
    pub fn count(&self) -> u64 {
        match self {
            Store::Sparse { addrs, .. } => addrs.len() as u64,
            Store::Dense { count, .. } => *count,
        }
    }

    /// Value first scan: every aligned slot in `regions` whose bytes pass `pred`.
    pub fn first_sparse(regions: &[(u64, u64)], g: Geometry, read: Reader, pred: &(dyn Fn(&[u8]) -> bool + Sync)) -> Store {
        let mut jobs = vec![];
        for &(start, end) in regions {
            let mut off = 0;
            while start + off < end {
                jobs.push((start, end, off));
                off += CHUNK as u64;
            }
        }
        let parts = par_map(jobs, |(start, end, off)| {
            let (mut addrs, mut prev) = (vec![], vec![]);
            let len = end - start;
            let read_len = (len - off).min((CHUNK + g.width - 1) as u64) as usize;
            let Some(buf) = read(start + off, read_len) else { return (addrs, prev) };
            let mut i = 0;
            while i < CHUNK && i + g.width <= buf.len() {
                let v = &buf[i..i + g.width];
                if pred(v) {
                    addrs.push(start + off + i as u64);
                    prev.extend_from_slice(v);
                }
                i += g.align;
            }
            (addrs, prev)
        });
        let (mut addrs, mut prev) = (vec![], vec![]);
        for (a, p) in parts {
            addrs.extend(a);
            prev.extend(p);
        }
        Store::Sparse { addrs, prev }
    }

    /// Unknown first scan: snapshot `regions` into `file`; every slot that could be read is a candidate.
    pub fn first_dense(regions: &[(u64, u64)], g: Geometry, read: Reader, file: File) -> io::Result<Store> {
        let (lays, nwords) = layout(regions, g);
        let mut bitmap = vec![0u64; nwords];
        let counts = par_map(chunks(&lays, &mut bitmap, g), |c| -> io::Result<u64> {
            let Some(buf) = read(c.lay.start + c.off, c.own_len()) else { return Ok(0) };
            file.write_all_at(&buf, c.lay.file_off + c.off)?;
            let n = c.slots(g);
            fill(c.words, n);
            Ok(n)
        });
        let count = counts.into_iter().sum::<io::Result<u64>>()?;
        Ok(Store::Dense { file, regions: regions.to_vec(), bitmap, count })
    }

    /// Next scan: keep the candidates for which `pred(now, at_last_scan)` holds, and remember
    /// their current bytes. Candidates that can no longer be read are dropped. A dense store
    /// becomes sparse once it is small enough.
    pub fn next(&mut self, g: Geometry, read: Reader, pred: &(dyn Fn(&[u8], &[u8]) -> bool + Sync)) -> io::Result<()> {
        match self {
            Store::Sparse { addrs, prev } => {
                let (a, p) = next_sparse(addrs, prev, g, read, pred);
                *addrs = a;
                *prev = p;
            }
            Store::Dense { file, regions, bitmap, count } => {
                *count = next_dense(file, regions, bitmap, g, read, pred)?;
            }
        }
        self.shrink(g)
    }

    /// Convert a dense store with at most `SPARSE_MAX` candidates to sparse (closing its file).
    pub fn shrink(&mut self, g: Geometry) -> io::Result<()> {
        let Store::Dense { file, regions, bitmap, count } = self else { return Ok(()) };
        if *count > SPARSE_MAX {
            return Ok(());
        }
        let (lays, _) = layout(regions, g);
        let (mut addrs, mut prev) = (Vec::with_capacity(*count as usize), Vec::with_capacity(*count as usize * g.width));
        for c in chunks(&lays, bitmap, g) {
            if c.words.iter().all(|w| *w == 0) {
                continue;
            }
            let mut buf = vec![0u8; c.read_len(g)];
            file.read_exact_at(&mut buf, c.lay.file_off + c.off)?;
            for_each_set(c.words, |k| {
                let o = k * g.align;
                addrs.push(c.lay.start + c.off + o as u64);
                prev.extend_from_slice(&buf[o..o + g.width]);
            });
        }
        *self = Store::Sparse { addrs, prev };
        Ok(())
    }

    /// Addresses of candidates `offset .. offset + limit`, ascending.
    pub fn page(&self, g: Geometry, offset: u64, limit: usize) -> Vec<u64> {
        match self {
            Store::Sparse { addrs, .. } => {
                let from = (offset.min(addrs.len() as u64)) as usize;
                addrs[from..(from + limit).min(addrs.len())].to_vec()
            }
            Store::Dense { regions, bitmap, .. } => {
                let (lays, _) = layout(regions, g);
                let mut skip = offset;
                let mut out = vec![];
                for lay in &lays {
                    for (i, &w) in bitmap[lay.word_off..lay.word_off + lay.words].iter().enumerate() {
                        let n = w.count_ones() as u64;
                        if skip >= n {
                            skip -= n;
                            continue;
                        }
                        let mut bits = w;
                        while bits != 0 && out.len() < limit {
                            let b = bits.trailing_zeros() as u64;
                            bits &= bits - 1;
                            if skip > 0 {
                                skip -= 1;
                                continue;
                            }
                            out.push(lay.start + (i as u64 * 64 + b) * g.align as u64);
                        }
                        if out.len() >= limit {
                            return out;
                        }
                    }
                }
                out
            }
        }
    }
}

/// Call `f(k)` for each set bit `k` (slot index within these words), ascending.
fn for_each_set(words: &[u64], mut f: impl FnMut(usize)) {
    for (i, &w) in words.iter().enumerate() {
        let mut bits = w;
        while bits != 0 {
            let b = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            f(i * 64 + b);
        }
    }
}

fn next_sparse(addrs: &[u64], prev: &[u8], g: Geometry, read: Reader, pred: &(dyn Fn(&[u8], &[u8]) -> bool + Sync)) -> (Vec<u64>, Vec<u8>) {
    let w = g.width;
    let jobs: Vec<(usize, usize)> = (0..addrs.len()).step_by(SPARSE_JOB).map(|i| (i, (i + SPARSE_JOB).min(addrs.len()))).collect();
    let parts = par_map(jobs, |(from, to)| {
        let (mut out_a, mut out_p) = (vec![], vec![]);
        let mut keep = |i: usize, cur: &[u8]| {
            if pred(cur, &prev[i * w..(i + 1) * w]) {
                out_a.push(addrs[i]);
                out_p.extend_from_slice(cur);
            }
        };
        let mut i = from;
        while i < to {
            // Batch sorted neighbours into one read of at most CHUNK bytes.
            let start = addrs[i];
            let mut end = start + w as u64;
            let mut j = i + 1;
            while j < to && addrs[j] <= end + SPARSE_GAP && addrs[j] + w as u64 - start <= CHUNK as u64 {
                end = end.max(addrs[j] + w as u64);
                j += 1;
            }
            match read(start, (end - start) as usize) {
                Some(buf) => {
                    for k in i..j {
                        let o = (addrs[k] - start) as usize;
                        keep(k, &buf[o..o + w]);
                    }
                }
                // Part of the span is gone: read each candidate on its own, dropping the unreadable.
                None => {
                    for k in i..j {
                        if let Some(cur) = read(addrs[k], w) {
                            keep(k, &cur);
                        }
                    }
                }
            }
            i = j;
        }
        (out_a, out_p)
    });
    let (mut a, mut p) = (vec![], vec![]);
    for (pa, pp) in parts {
        a.extend(pa);
        p.extend(pp);
    }
    (a, p)
}

fn next_dense(
    file: &File,
    regions: &[(u64, u64)],
    bitmap: &mut [u64],
    g: Geometry,
    read: Reader,
    pred: &(dyn Fn(&[u8], &[u8]) -> bool + Sync),
) -> io::Result<u64> {
    let (lays, _) = layout(regions, g);
    let jobs = chunks(&lays, bitmap, g);
    // A slot straddling a chunk's end reads its last bytes from the next chunk, which that
    // chunk's job rewrites. Read those previous bytes before any job runs.
    let mut tails = Vec::with_capacity(jobs.len());
    for c in &jobs {
        let (own, need) = (c.own_len(), c.read_len(g));
        let mut tail = vec![0u8; need - own];
        if !tail.is_empty() {
            file.read_exact_at(&mut tail, c.lay.file_off + c.off + own as u64)?;
        }
        tails.push(tail);
    }
    // Chunks without candidates can be skipped unless a slot from the chunk before straddles
    // into them (then the file must stay current for its next comparison).
    let straddles = g.width > g.align;
    let counts = par_map(jobs.into_iter().zip(tails).collect(), |(c, tail): (Chunk, Vec<u8>)| -> io::Result<u64> {
        if !straddles && c.words.iter().all(|w| *w == 0) {
            return Ok(0);
        }
        let Some(cur) = read(c.lay.start + c.off, c.read_len(g)) else {
            c.words.fill(0);
            return Ok(0);
        };
        let own = c.own_len();
        let mut prev = vec![0u8; own];
        file.read_exact_at(&mut prev, c.lay.file_off + c.off)?;
        prev.extend_from_slice(&tail);
        for (i, word) in c.words.iter_mut().enumerate() {
            let mut bits = *word;
            while bits != 0 {
                let b = bits.trailing_zeros() as usize;
                bits &= bits - 1;
                let o = (i * 64 + b) * g.align;
                if !pred(&cur[o..o + g.width], &prev[o..o + g.width]) {
                    *word &= !(1u64 << b);
                }
            }
        }
        file.write_all_at(&cur[..own], c.lay.file_off + c.off)?;
        Ok(popcount(c.words))
    });
    counts.into_iter().sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake target: one buffer per region, with an optional unreadable region.
    struct Fake {
        regions: Vec<(u64, Vec<u8>)>,
        dead: Option<u64>,
    }

    impl Fake {
        fn read(&self, addr: u64, len: usize) -> Option<Vec<u8>> {
            self.regions.iter().find_map(|(start, data)| {
                if Some(*start) == self.dead || addr < *start || addr + len as u64 > start + data.len() as u64 {
                    return None;
                }
                let o = (addr - start) as usize;
                Some(data[o..o + len].to_vec())
            })
        }

        fn ranges(&self) -> Vec<(u64, u64)> {
            self.regions.iter().map(|(s, d)| (*s, s + d.len() as u64)).collect()
        }

        fn put(&mut self, addr: u64, v: u32) {
            let (start, data) = self.regions.iter_mut().find(|(s, d)| addr >= *s && addr < s + d.len() as u64).unwrap();
            let o = (addr - *start) as usize;
            data[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
    }

    fn tmp() -> File {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("starlightd-store-test-{}-{:?}", std::process::id(), std::thread::current().id()));
        let f = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        f
    }

    const G4: Geometry = Geometry { width: 4, align: 4 };

    fn fake() -> Fake {
        // Two regions, the first spanning several chunks, not a multiple of 64 slots.
        Fake { regions: vec![(0x10000, vec![0u8; CHUNK * 2 + 4096 + 12]), (0x1000_0000, vec![0u8; 8192])], dead: None }
    }

    fn changed(c: &[u8], p: &[u8]) -> bool {
        c != p
    }

    #[test]
    fn dense_unknown_then_changed_finds_writes_across_chunks() {
        let mut f = fake();
        let regions = f.ranges();
        let total = slots(regions[0].1 - regions[0].0, G4) + slots(8192, G4);
        let mut s = Store::first_dense(&regions, G4, &|a, n| f.read(a, n), tmp()).unwrap();
        assert!(matches!(s, Store::Dense { .. }));
        assert_eq!(s.count(), total);
        let hits = [0x10000, 0x10000 + CHUNK as u64 - 4, 0x10000 + CHUNK as u64, 0x10000 + 2 * CHUNK as u64 + 4096 + 8, 0x1000_0000 + 8188];
        for &a in &hits {
            f.put(a, 7);
        }
        s.next(G4, &|a, n| f.read(a, n), &changed).unwrap();
        assert_eq!(s.count(), hits.len() as u64);
        assert!(matches!(s, Store::Sparse { .. }), "small results become sparse");
        assert_eq!(s.page(G4, 0, 100), hits);
        // The remembered bytes are this scan's: an unchanged value is not "changed" again.
        f.put(hits[1], 8);
        s.next(G4, &|a, n| f.read(a, n), &changed).unwrap();
        assert_eq!(s.page(G4, 0, 100), [hits[1]]);
    }

    #[test]
    fn dense_stays_dense_above_threshold_and_pages() {
        let f = Fake { regions: vec![(0x10000, vec![0u8; (SPARSE_MAX as usize + 100) * 4])], dead: None };
        let regions = f.ranges();
        let mut s = Store::first_dense(&regions, G4, &|a, n| f.read(a, n), tmp()).unwrap();
        s.shrink(G4).unwrap();
        assert!(matches!(s, Store::Dense { .. }));
        assert_eq!(s.count(), SPARSE_MAX + 100);
        assert_eq!(s.page(G4, 65, 3), [0x10000 + 65 * 4, 0x10000 + 66 * 4, 0x10000 + 67 * 4]);
        // Unchanged keeps everything, still dense; the bitmap is intact.
        s.next(G4, &|a, n| f.read(a, n), &|c, p| c == p).unwrap();
        assert!(matches!(s, Store::Dense { .. }));
        assert_eq!(s.count(), SPARSE_MAX + 100);
    }

    #[test]
    fn straddling_slots_compare_against_the_previous_scan() {
        // Alignment 1, width 4: slots straddle chunk ends. Large enough to stay dense.
        let g = Geometry { width: 4, align: 1 };
        let mut f = Fake { regions: vec![(0x10000, vec![0u8; CHUNK * 5 + 2])], dead: None };
        let regions = f.ranges();
        let mut s = Store::first_dense(&regions, g, &|a, n| f.read(a, n), tmp()).unwrap();
        let all = s.count();
        assert!(all > SPARSE_MAX);
        s.next(g, &|a, n| f.read(a, n), &|c, p| c == p).unwrap();
        assert_eq!(s.count(), all, "nothing changed, including slots straddling chunk ends");
        assert!(matches!(s, Store::Dense { .. }));
        let edge = 0x10000 + CHUNK as u64 - 2; // writes bytes CHUNK-2 .. CHUNK+2
        f.put(edge, 0x0102_0304);
        let last = 0x10000 + 5 * CHUNK as u64 - 2; // the region's last slot, straddling into a chunk of 2 bytes
        f.put(last, 0x0506_0708);
        s.next(g, &|a, n| f.read(a, n), &changed).unwrap();
        // Every slot overlapping the written bytes changed: 7 starts around `edge`, 4 before the end.
        let mut want: Vec<u64> = (edge - 3..=edge + 3).collect();
        want.extend(last - 3..=last);
        assert_eq!(s.page(g, 0, 100), want);
    }

    #[test]
    fn unreadable_regions_drop_their_candidates() {
        let mut f = fake();
        let regions = f.ranges();
        let s = Store::first_sparse(&regions, G4, &|a, n| f.read(a, n), &|v| v == [0, 0, 0, 0]);
        let mut s = s;
        let before = s.count();
        f.dead = Some(0x1000_0000);
        s.next(G4, &|a, n| f.read(a, n), &|c, p| c == p).unwrap();
        assert_eq!(s.count(), before - 8192 / 4);
        // Dense too.
        let mut f = fake();
        let mut s = Store::first_dense(&regions, G4, &|a, n| f.read(a, n), tmp()).unwrap();
        f.dead = Some(0x10000);
        s.next(G4, &|a, n| f.read(a, n), &|c, p| c == p).unwrap();
        assert_eq!(s.count(), 8192 / 4);
    }

    #[test]
    fn sparse_first_finds_values_on_chunk_edges() {
        let mut f = fake();
        let at = [0x10000 + CHUNK as u64 - 4, 0x10000 + CHUNK as u64, 0x1000_0000];
        for &a in &at {
            f.put(a, 100);
        }
        let s = Store::first_sparse(&f.ranges(), G4, &|a, n| f.read(a, n), &|v| v == 100u32.to_le_bytes());
        assert_eq!(s.page(G4, 0, 10), at);
        assert_eq!(s.page(G4, 1, 1), [at[1]]);
        assert!(s.page(G4, 9, 1).is_empty());
    }
}
