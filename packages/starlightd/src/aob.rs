//! Array-of-bytes pattern parsing and scanning.
use crate::maps;
use crate::mem;
use crate::modules;
use crate::process::Target;
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

    fn matches_at(&self, buf: &[u8], i: usize) -> bool {
        self.0.iter().zip(&buf[i..i + self.0.len()]).all(|(p, b)| p.map_or(true, |p| p == *b))
    }
}

/// Offsets (ascending) where `p` matches in `buf`.
fn find_in<'a>(buf: &'a [u8], p: &'a Pattern) -> impl Iterator<Item = usize> + 'a {
    let last = buf.len().checked_sub(p.len()).map_or(0, |n| n + 1);
    (0..last).filter(move |&i| p.matches_at(buf, i))
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
        let mut data = vec![0u8; CHUNK * 2];
        data[CHUNK - 2..CHUNK + 2].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        data[3..5].copy_from_slice(&[0xde, 0xad]);
        data[CHUNK + 5..CHUNK + 9].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        let p = Pattern::parse("DE AD BE EF").unwrap();
        let mut out = vec![];
        scan_range(|a, n| Some(data[a as usize..a as usize + n].to_vec()), (0, data.len() as u64), &p, 100, &mut out);
        assert_eq!(out, vec![CHUNK as u64 - 2, CHUNK as u64 + 5]);
    }
}
