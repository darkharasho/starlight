//! Running syscalls inside the target (D6) and remote memory allocation (D7).
use crate::maps::{self, Region};
use crate::mem;
use crate::process::Target;
use crate::rpc::RpcError;
use crate::tracer::{Stopped, Tracer};

const PAGE: u64 = 4096;
/// Near allocations are aligned like Windows allocations.
const GRANULARITY: u64 = 0x10000;
/// Lowest address we map at (the usual `vm.mmap_min_addr`).
const MIN_ADDR: u64 = 0x10000;
/// End of the x86-64 user address space (47-bit).
const MAX_ADDR: u64 = 0x7fff_ffff_f000;
/// The kernel keeps this much free below a stack so it can grow.
const STACK_GUARD: u64 = 1 << 20;
/// Gaps tried per near allocation.
const MAX_NEAR_TRIES: usize = 32;
const MAP_FIXED_NOREPLACE: u64 = 0x100000;

/// `size` rounded up to whole pages.
pub fn page_round(size: u64) -> u64 {
    size.div_ceil(PAGE) * PAGE
}

fn is_libc(r: &Region) -> bool {
    r.path.as_deref().and_then(|p| p.rsplit('/').next()).is_some_and(|n| n.starts_with("libc.so") || n.starts_with("libc-"))
}

/// Address of a `syscall` (`0f 05`) in an r-x, file-backed Linux mapping, libc first. Cached per
/// tracer. Only executed, never written.
pub fn syscall_site(t: &Target, tracer: &Tracer) -> Result<u64, RpcError> {
    if let Some(a) = tracer.syscall_site() {
        return Ok(a);
    }
    let regions = maps::read(t.pid).map_err(|e| RpcError::process_not_found(format!("cannot read maps of {}: {e}", t.pid)))?;
    let mut code: Vec<&Region> = regions
        .iter()
        .filter(|r| r.perms.read && r.perms.exec && !r.perms.write && r.path.as_deref().is_some_and(|p| p.starts_with('/')))
        .collect();
    code.sort_by_key(|r| !is_libc(r)); // stable: libc first, then map order
    const CHUNK: u64 = 64 * 1024;
    for r in code {
        let mut at = r.start;
        while at < r.end {
            // One byte of overlap so a `0f 05` across a chunk boundary is found.
            let len = (r.end - at).min(CHUNK + 1);
            let Ok(buf) = mem::read_bytes(t, at, len as usize) else { break };
            if let Some(i) = buf.windows(2).position(|w| w == [0x0f, 0x05]) {
                let site = at + i as u64;
                tracer.set_syscall_site(site);
                return Ok(site);
            }
            at += CHUNK;
        }
    }
    Err(RpcError::ptrace_failed("no syscall instruction found in the game's code"))
}

fn syscall_result(r: i64, what: &str) -> Result<u64, RpcError> {
    if (-4095..0).contains(&r) {
        Err(RpcError::alloc_failed(format!("{what} failed: {}", std::io::Error::from_raw_os_error(-r as i32))))
    } else {
        Ok(r as u64)
    }
}

/// Remote anonymous private `mmap`. With a `hint`, `MAP_FIXED_NOREPLACE` is used; the kernel may
/// still return another address (kernels before 4.17 treat the flag as a hint), so callers check.
pub fn mmap(stopped: &mut Stopped<'_>, len: u64, prot: i32, hint: Option<u64>) -> Result<u64, RpcError> {
    let mut flags = (libc::MAP_PRIVATE | libc::MAP_ANONYMOUS) as u64;
    if hint.is_some() {
        flags |= MAP_FIXED_NOREPLACE;
    }
    let r = stopped.syscall(libc::SYS_mmap, [hint.unwrap_or(0), len, prot as u64, flags, u64::MAX, 0])?;
    syscall_result(r, "mmap")
}

pub fn munmap(stopped: &mut Stopped<'_>, addr: u64, len: u64) -> Result<(), RpcError> {
    let r = stopped.syscall(libc::SYS_munmap, [addr, len, 0, 0, 0, 0])?;
    syscall_result(r, "munmap").map(|_| ())
}

/// 64 KiB-aligned addresses where `len` bytes fit in a true gap of `regions`, every byte within
/// ±(2 GiB − `len`) of `near` (a little margin is kept), nearest first.
fn near_candidates(regions: &[Region], near: u64, len: u64) -> Vec<u64> {
    let reach = (1u64 << 31).saturating_sub(len + GRANULARITY);
    let lo = near.saturating_sub(reach).max(MIN_ADDR);
    let hi = near.saturating_add(reach).min(MAX_ADDR);
    let mut regions: Vec<&Region> = regions.iter().filter(|r| r.start < MAX_ADDR).collect();
    regions.sort_by_key(|r| r.start);
    let mut gaps = Vec::new();
    let mut prev_end = 0;
    for r in &regions {
        let end = if r.path.as_deref() == Some("[stack]") { r.start.saturating_sub(STACK_GUARD) } else { r.start };
        if end > prev_end {
            gaps.push((prev_end, end));
        }
        prev_end = prev_end.max(r.end);
    }
    gaps.push((prev_end, MAX_ADDR));
    let mut out: Vec<u64> = gaps
        .into_iter()
        .filter_map(|(s, e)| {
            let s = s.max(lo).next_multiple_of(GRANULARITY);
            let e = e.min(hi);
            let last = e.checked_sub(len)? / GRANULARITY * GRANULARITY;
            (last >= s).then(|| (near / GRANULARITY * GRANULARITY).clamp(s, last))
        })
        .collect();
    out.sort_by_key(|&a| a.abs_diff(near));
    out
}

/// Allocate `size` bytes (rounded up to pages) in the target with `prot`. With `near`, the block
/// lies within ±2 GiB of it so rel32 jumps reach it, in a true gap of the address space (so
/// Wine's reserved areas are never touched). The tracer is held only for the call.
pub fn alloc(t: &Target, size: u64, near: Option<u64>, prot: i32) -> Result<u64, RpcError> {
    if size == 0 {
        return Err(RpcError::invalid_params("size must be positive"));
    }
    let len = page_round(size);
    let tracer = t.tracer()?;
    syscall_site(t, &tracer)?;
    let pid = t.pid;
    tracer.with_stopped(move |s| {
        let Some(near) = near else { return mmap(s, len, prot, None) };
        // Read with the game stopped, so the gaps can't change under us.
        let regions = maps::read(pid).map_err(|e| RpcError::process_not_found(format!("cannot read maps of {pid}: {e}")))?;
        for cand in near_candidates(&regions, near, len).into_iter().take(MAX_NEAR_TRIES) {
            match mmap(s, len, prot, Some(cand)) {
                Ok(a) if a == cand => return Ok(a),
                Ok(a) => {
                    let _ = munmap(s, a, len);
                }
                Err(e) if e.code == -32002 => return Err(e), // process gone
                Err(_) => {} // taken meanwhile (EEXIST): next gap
            }
        }
        Err(RpcError::alloc_failed(format!("no free gap within 2 GiB of {near:#x}")))
    })?
}

/// Unmap `size` bytes at `addr` (an earlier `alloc`).
pub fn free(t: &Target, addr: u64, size: u64) -> Result<(), RpcError> {
    let tracer = t.tracer()?;
    syscall_site(t, &tracer)?;
    tracer.with_stopped(move |s| munmap(s, addr, size))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(start: u64, end: u64, path: Option<&str>) -> Region {
        Region {
            start,
            end,
            perms: maps::Perms { read: true, write: false, exec: false, shared: false },
            offset: 0,
            path: path.map(str::to_string),
        }
    }

    #[test]
    fn page_round_rounds_up() {
        assert_eq!(page_round(1), 4096);
        assert_eq!(page_round(4096), 4096);
        assert_eq!(page_round(4097), 8192);
    }

    #[test]
    fn near_candidates_use_true_gaps_nearest_first() {
        // Code at 0x400000, a reserved block right above it, a free gap after that.
        let regions = [
            region(0x400000, 0x405000, Some("/game")),
            region(0x405000, 0x10000000, None), // e.g. a PROT_NONE reservation
            region(0x7f00_0000_0000, 0x7f00_0010_0000, Some("/usr/lib64/libc.so.6")),
        ];
        let near = 0x401234;
        let c = near_candidates(&regions, near, 4096);
        assert_eq!(c[0], 0x3f0000, "just below the image");
        assert_eq!(c[1], 0x10000000, "just above the reservation");
        for a in &c {
            assert_eq!(a % GRANULARITY, 0);
            assert!(a.abs_diff(near) < (1 << 31) - 4096);
            assert!(regions.iter().all(|r| a + 4096 <= r.start || *a >= r.end), "{a:#x} overlaps a mapping");
        }
        assert!(!c.iter().any(|&a| a >= 0x7f00_0000_0000), "libc gap is out of reach");
    }

    #[test]
    fn near_candidates_stay_within_reach_of_high_addresses() {
        let near = 0x7f12_3456_7000;
        let regions = [region(near - 0x1000, near + 0x1000, Some("/x"))];
        let c = near_candidates(&regions, near, 0x2000);
        assert!(!c.is_empty());
        for a in c {
            assert!(a.abs_diff(near) < (1 << 31) - 0x2000 && a + 0x2000 <= MAX_ADDR);
        }
    }

    #[test]
    fn near_candidates_skip_the_stack_guard_and_full_space() {
        let near = 0x7ffd_0000_0000;
        let regions = [region(0x7ffc_ffff_0000, 0x7ffd_0010_0000, Some("[stack]"))];
        let c = near_candidates(&regions, near, 4096);
        assert!(c.iter().all(|&a| a + 4096 <= 0x7ffc_ffff_0000 - STACK_GUARD || a >= 0x7ffd_0010_0000));
        // Everything within reach is mapped: no candidates.
        let full = [region(0, MAX_ADDR, None)];
        assert!(near_candidates(&full, near, 4096).is_empty());
    }
}
