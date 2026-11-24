//! Array-of-bytes pattern parsing and scanning.
use crate::maps;
use crate::mem;
use crate::modules;
use crate::process::Target;
use crate::remote;
use crate::rpc::RpcError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern(Vec<Option<u8>>);

#[cfg(not(test))]
const CHUNK: usize = 1 << 20;
#[cfg(test)]
const CHUNK: usize = 16;

impl Pattern {
    pub fn parse(s: &str) -> Result<Pattern, RpcError> {
        let mut toks = vec![];
        for tok in s.split_whitespace() {
            if tok == "?" || tok == "??" {
                toks.push(None);
            } else if tok.len() == 2 && tok.bytes().all(|b| b.is_ascii_hexdigit()) {
                toks.push(Some(u8::from_str_radix(tok, 16).unwrap()));
            } else {
                return Err(RpcError::invalid_pattern(format!("bad token {tok:?}")));
            }
        }
        if toks.is_empty() {
            return Err(RpcError::invalid_pattern("empty pattern"));
        }
        if toks.iter().all(Option::is_none) {
            return Err(RpcError::invalid_pattern("pattern must contain at least one byte"));
        }
        Ok(Pattern(toks))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Index and value of the non-wildcard byte least likely to be common (0x00 and 0xFF are
    /// the most frequent in process memory), used to skip quickly through the buffer.
    fn anchor(&self) -> (usize, u8) {
        let rank = |b: u8| match b {
            0x00 => 0,
            0xff => 1,
            _ => 2,
        };
        self.0
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.map(|b| (i, b)))
            .max_by_key(|&(i, b)| (rank(b), std::cmp::Reverse(i)))
            .expect("pattern has a non-wildcard byte")
    }

    /// Whether the pattern matches `window`, which must be exactly `self.len()` bytes.
    pub fn matches_window(&self, window: &[u8]) -> bool {
        self.0.iter().zip(window).all(|(p, b)| p.is_none_or(|p| p == *b))
    }
}

/// Offsets (ascending) where `p` matches in `buf`: locate the anchor byte quickly, then verify.
fn find_in<'a>(buf: &'a [u8], p: &'a Pattern) -> impl Iterator<Item = usize> + 'a {
    let (ai, ab) = p.anchor();
    let len = p.len();
    // Candidate starts are in 0..=last; the anchor byte for start i sits at i + ai.
    let last = buf.len().checked_sub(len);
    let mut from = ai; // next index to search for the anchor byte
    std::iter::from_fn(move || {
        let last = last?;
        loop {
            let hay = buf.get(from..last + ai + 1)?;
            let pos = hay.iter().position(|&b| b == ab)? + from;
            from = pos + 1;
            let start = pos - ai;
            if p.matches_window(&buf[start..start + len]) {
                return Some(start);
            }
        }
    })
}

/// Scan `[start, end)` through `read` in `CHUNK`-sized reads that overlap by `p.len() - 1`,
/// pushing ascending matches onto `out` until it holds `max`. A failed read ends the range.
fn scan_range(
    mut read: impl FnMut(u64, usize) -> Option<Vec<u8>>,
    (start, end): (u64, u64),
    p: &Pattern,
    max: usize,
    out: &mut Vec<u64>,
) {
    let (mut pos, mut carry, mut buf) = (start, 0usize, Vec::<u8>::new());
    while pos < end && out.len() < max {
        let n = ((end - pos).min(CHUNK as u64)) as usize;
        let Some(data) = read(pos, n) else { return };
        buf.drain(..buf.len() - carry);
        buf.extend_from_slice(&data);
        let base = pos - carry as u64;
        // Matches inside the carried tail would be shorter than the pattern, so none repeat.
        for i in find_in(&buf, p) {
            if out.len() >= max {
                return;
            }
            out.push(base + i as u64);
        }
        carry = (p.len() - 1).min(buf.len());
        pos += n as u64;
    }
}

/// Scan readable regions intersecting `range` (start, end) for `p`; at most `max` ascending matches.
/// Regions whose reads fail are skipped.
pub fn scan(t: &Target, range: (u64, u64), p: &Pattern, max: usize) -> Result<Vec<u64>, RpcError> {
    let regions = maps::read(t.pid).map_err(|e| match e.raw_os_error() {
        Some(libc::ENOENT) | Some(libc::ESRCH) => RpcError::process_not_found(format!("pid {} has exited", t.pid)),
        _ => RpcError::read_failed(format!("cannot read maps of pid {}: {e}", t.pid)),
    })?;
    let mut out = vec![];
    for r in regions.iter().filter(|r| r.perms.read) {
        let (start, end) = (r.start.max(range.0), r.end.min(range.1));
        scan_range(|a, n| mem::read_bytes(t, a, n).ok(), (start, end), p, max, &mut out);
        if out.len() >= max {
            break;
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// `[start, end)` without the `holes` (sorted, possibly overlapping), as ascending ranges.
fn subtract(start: u64, end: u64, holes: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = vec![];
    let mut at = start;
    for &(hs, he) in holes {
        if he <= at || hs >= end {
            continue;
        }
        if hs > at {
            out.push((at, hs));
        }
        at = at.max(he);
    }
    if at < end {
        out.push((at, end));
    }
    out
}

/// Scan every readable, executable region in address order for `p`, skipping this daemon's own
/// hook and state pages (M4 D10: AA `aobscan` covers code, including JIT code in anonymous
/// memory). At most `max` ascending matches.
pub fn scan_exec(t: &Target, p: &Pattern, max: usize) -> Result<Vec<u64>, RpcError> {
    let regions = maps::read(t.pid).map_err(|e| match e.raw_os_error() {
        Some(libc::ENOENT) | Some(libc::ESRCH) => RpcError::process_not_found(format!("pid {} has exited", t.pid)),
        _ => RpcError::read_failed(format!("cannot read maps of pid {}: {e}", t.pid)),
    })?;
    let own = remote::own_ranges(t.pid);
    let mut out = vec![];
    for r in regions.iter().filter(|r| r.perms.read && r.perms.exec) {
        for range in subtract(r.start, r.end, &own) {
            scan_range(|a, n| mem::read_bytes(t, a, n).ok(), range, p, max, &mut out);
            if out.len() >= max {
                break;
            }
        }
        if out.len() >= max {
            break;
        }
    }
    out.sort_unstable();
    out.dedup();
    out.truncate(max);
    Ok(out)
}

/// Resolve a module name to its (start, end) range.
pub fn module_range(t: &Target, name: &str) -> Result<(u64, u64), RpcError> {
    let mods = modules::list(t)?;
    let m = modules::find(&mods, name).ok_or_else(|| RpcError::module_not_found(format!("module {name:?} not found")))?;
    Ok((m.base, m.base.saturating_add(m.size)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtract_removes_holes() {
        assert_eq!(subtract(0, 100, &[]), vec![(0, 100)]);
        assert_eq!(subtract(0, 100, &[(10, 20), (15, 30), (90, 200)]), vec![(0, 10), (30, 90)]);
        assert_eq!(subtract(10, 20, &[(0, 10), (20, 30)]), vec![(10, 20)]);
        assert_eq!(subtract(10, 20, &[(0, 50)]), vec![]);
    }

    #[test]
    fn parses_wildcards() {
        let p = Pattern::parse("DE AD ?? EF").unwrap();
        assert_eq!(p.0, vec![Some(0xde), Some(0xad), None, Some(0xef)]);
        assert_eq!(Pattern::parse("de ? ad").unwrap().len(), 3);
    }

    #[test]
    fn rejects_bad_tokens() {
        for s in ["DE ZZ", "", "D", "DEAD", "?? ??", "0xDE"] {
            assert_eq!(Pattern::parse(s).unwrap_err().code, -32006, "{s:?}");
        }
    }

    #[test]
    fn find_in_buffer_with_wildcard() {
        let p = Pattern::parse("01 ?? 03").unwrap();
        assert_eq!(find_in(&[0, 1, 9, 3, 1, 2, 3], &p).collect::<Vec<_>>(), vec![1, 4]);
        assert_eq!(find_in(&[1, 2], &p).count(), 0);
    }

    #[test]
    fn chunk_boundary_straddle() {
        let mut data = [0u8; CHUNK * 2];
        data[CHUNK - 2..CHUNK + 2].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        data[3..5].copy_from_slice(&[0xde, 0xad]);
        data[CHUNK + 5..CHUNK + 9].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        let p = Pattern::parse("DE AD BE EF").unwrap();
        let mut out = vec![];
        scan_range(|a, n| Some(data[a as usize..a as usize + n].to_vec()), (0, data.len() as u64), &p, 100, &mut out);
        assert_eq!(out, vec![CHUNK as u64 - 2, CHUNK as u64 + 5]);
    }

    #[test]
    fn prefilter_handles_leading_wildcards_and_edges() {
        let p = Pattern::parse("?? 00 01").unwrap();
        // match at very start, middle, and flush with the end
        assert_eq!(find_in(&[9, 0, 1, 5, 7, 0, 1, 0, 0, 1], &p).collect::<Vec<_>>(), vec![0, 4, 7]);
        // anchor byte present too close to either edge must not match or panic
        assert_eq!(find_in(&[0, 1], &p).count(), 0);
        assert_eq!(find_in(&[1, 0, 1, 0], &p).collect::<Vec<_>>(), vec![0]);
        let p = Pattern::parse("01 ?? ??").unwrap();
        assert_eq!(find_in(&[1, 2, 3, 1], &p).collect::<Vec<_>>(), vec![0]);
    }

    #[test]
    fn prefilter_agrees_with_naive_matcher() {
        let data: Vec<u8> = (0..4000u32).map(|i| ((i * 7) ^ (i >> 3)) as u8 % 5).collect();
        for pat in ["01 ?? 03", "?? 00 01", "00 00 ??", "04 ? ? 02", "FF 00", "02"] {
            let p = Pattern::parse(pat).unwrap();
            let naive: Vec<usize> = (0..=data.len() - p.len()).filter(|&i| p.matches_window(&data[i..i + p.len()])).collect();
            assert_eq!(find_in(&data, &p).collect::<Vec<_>>(), naive, "{pat}");
        }
    }

    #[test]
    #[ignore = "100 MB timing check; run with --release -- --ignored"]
    fn large_zero_buffer_without_match_is_fast() {
        let data = vec![0u8; 100 << 20];
        let p = Pattern::parse("00 00 00 00 00 00 00 01").unwrap();
        let t = std::time::Instant::now();
        let mut out = vec![];
        scan_range(|a, n| Some(data[a as usize..a as usize + n].to_vec()), (0, data.len() as u64), &p, 10, &mut out);
        assert!(out.is_empty());
        assert!(t.elapsed().as_secs() < 1, "took {:?}", t.elapsed());
    }
}
