//! Running syscalls inside the target (D6) and remote memory allocation (D7).
use crate::maps::{self, Region};
use crate::mem;
use crate::process::Target;
use crate::rpc::RpcError;
use crate::arch::Bits;
use crate::tracer::{Stopped, SyscallAbi, Tracer};

const PAGE: u64 = 4096;
/// Near allocations are aligned like Windows allocations.
const GRANULARITY: u64 = 0x10000;
/// Lowest address we map at (the usual `vm.mmap_min_addr`).
const MIN_ADDR: u64 = 0x10000;
/// End of the x86-64 user address space (47-bit).
const MAX_ADDR: u64 = 0x7fff_ffff_f000;
/// Highest end for memory that 32-bit code must reach (just under 4 GiB).
const MAX_ADDR_32: u64 = 0xFFFF_0000;
/// The kernel keeps this much free below a stack so it can grow.
const STACK_GUARD: u64 = 1 << 20;
/// Gaps tried per near allocation.
const MAX_NEAR_TRIES: usize = 32;
const MAP_FIXED_NOREPLACE: u64 = 0x100000;
/// `RpcError::alloc_failed`: the kernel ran our syscall and returned an error.
const ALLOC_FAILED: i64 = -32011;

/// `size` rounded up to whole pages.
pub fn page_round(size: u64) -> u64 {
    size.div_ceil(PAGE) * PAGE
}

fn is_libc(r: &Region) -> bool {
    r.path.as_deref().and_then(|p| p.rsplit('/').next()).is_some_and(|n| n.starts_with("libc.so") || n.starts_with("libc-"))
}

/// True if `r` belongs to an ELF file (a Linux library), judged by the magic at the file's
/// offset-0 mapping. Wine's PE DLLs are file-backed and r-x too, but are not Linux code.
fn is_elf(t: &Target, regions: &[Region], r: &Region) -> bool {
    regions
        .iter()
        .find(|h| h.offset == 0 && h.path == r.path && h.perms.read)
        .and_then(|h| mem::read_bytes(t, h.start, 4).ok())
        .is_some_and(|m| m == b"\x7fELF")
}

/// The ABI remote calls use in `t`: `int 0x80` in a 32-bit process.
pub fn abi_for(t: &Target) -> SyscallAbi {
    SyscallAbi::for_bits(t.process_bits)
}

/// Address of the ABI's call instruction (`syscall` `0f 05`, or `int 0x80` `cd 80`), cached per
/// tracer. i386 looks in `[vdso]` first (always mapped, even in freestanding programs), then in
/// r-x Linux libraries, libc first; x86-64 in the libraries only. Only executed, never written.
pub fn call_site(t: &Target, tracer: &Tracer, abi: SyscallAbi) -> Result<u64, RpcError> {
    if let Some((a, cached)) = tracer.call_site() {
        if cached == abi {
            return Ok(a);
        }
    }
    let regions = maps::read(t.pid).map_err(|e| RpcError::process_not_found(format!("cannot read maps of {}: {e}", t.pid)))?;
    let mut code: Vec<&Region> = vec![];
    if abi == SyscallAbi::I386 {
        code.extend(regions.iter().filter(|r| r.perms.read && r.perms.exec && r.path.as_deref() == Some("[vdso]")));
    }
    let mut libs: Vec<&Region> = regions
        .iter()
        .filter(|r| r.perms.read && r.perms.exec && !r.perms.write && r.path.as_deref().is_some_and(|p| p.starts_with('/')))
        .filter(|r| is_elf(t, &regions, r))
        .collect();
    libs.sort_by_key(|r| !is_libc(r)); // stable: libc first, then map order
    code.extend(libs);
    let want = abi.site_bytes();
    const CHUNK: u64 = 64 * 1024;
    for r in code {
        let mut at = r.start;
        while at < r.end {
            // One byte of overlap so a site across a chunk boundary is found.
            let len = (r.end - at).min(CHUNK + 1);
            let Ok(buf) = mem::read_bytes(t, at, len as usize) else { break };
            if let Some(i) = buf.windows(2).position(|w| w == want) {
                let site = at + i as u64;
                tracer.set_call_site(site, abi);
                return Ok(site);
            }
            at += CHUNK;
        }
    }
    Err(RpcError::ptrace_failed("no syscall instruction found in the game's code"))
}

/// A raw result (`-errno` on failure); i386 results are 32-bit addresses.
fn syscall_result_abi(abi: SyscallAbi, r: i64, what: &str) -> Result<u64, RpcError> {
    if (-4095..0).contains(&r) {
        Err(RpcError::alloc_failed(format!("{what} failed: {}", std::io::Error::from_raw_os_error(-r as i32))))
    } else if abi == SyscallAbi::I386 {
        Ok(r as u32 as u64)
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
    let (_, abi) = stopped.site()?;
    // mmap2 (i386) takes its offset in pages; it is 0 here either way.
    let r = stopped.syscall(abi.nr_mmap(), [hint.unwrap_or(0), len, prot as u64, flags, u64::MAX, 0])?;
    syscall_result_abi(abi, r, "mmap")
}

pub fn munmap(stopped: &mut Stopped<'_>, addr: u64, len: u64) -> Result<(), RpcError> {
    let (_, abi) = stopped.site()?;
    let r = stopped.syscall(abi.nr_munmap(), [addr, len, 0, 0, 0, 0])?;
    syscall_result_abi(abi, r, "munmap").map(|_| ())
}

/// 64 KiB-aligned addresses where `len` bytes fit in a true gap of `regions`, every byte within
/// ±(2 GiB − `len`) of `near` (a little margin is kept) and below `max_addr`, nearest first.
fn near_candidates(regions: &[Region], near: u64, len: u64, max_addr: u64) -> Vec<u64> {
    let reach = (1u64 << 31).saturating_sub(len + GRANULARITY);
    let lo = near.saturating_sub(reach).max(MIN_ADDR);
    let hi = near.saturating_add(reach).min(max_addr);
    let mut regions: Vec<&Region> = regions.iter().filter(|r| r.start < max_addr).collect();
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
    gaps.push((prev_end, max_addr));
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
    crate::guard::remote(t)?;
    let len = page_round(size);
    // 32-bit code only reaches the low 4 GiB. A 32-bit process's kernel keeps every mapping
    // there anyway; a 64-bit process running 32-bit code (WoW64) needs an explicit low gap.
    let code32 = t.code_bits() == Some(Bits::B32);
    let max_addr = if code32 { MAX_ADDR_32 } else { MAX_ADDR };
    let near = if code32 && t.process_bits == Bits::B64 { Some(near.unwrap_or(MIN_ADDR)) } else { near };
    let abi = abi_for(t);
    let tracer = t.tracer()?;
    call_site(t, &tracer, abi)?;
    let pid = t.pid;
    tracer.with_stopped(move |s| {
        let Some(near) = near else { return mmap(s, len, prot, None) };
        // Read with the game stopped, so the gaps can't change under us.
        let regions = maps::read(pid).map_err(|e| RpcError::process_not_found(format!("cannot read maps of {pid}: {e}")))?;
        for cand in near_candidates(&regions, near, len, max_addr).into_iter().take(MAX_NEAR_TRIES) {
            match mmap(s, len, prot, Some(cand)) {
                Ok(a) if a == cand => return Ok(a),
                Ok(a) => {
                    let _ = munmap(s, a, len);
                }
                // The kernel refused this gap (EEXIST: taken meanwhile): try the next one.
                Err(e) if e.code == ALLOC_FAILED => {}
                // The injection itself failed (process gone, thread stuck): stop injecting.
                Err(e) => return Err(e),
            }
        }
        Err(RpcError::alloc_failed(format!("no free gap within 2 GiB of {near:#x}{}", if code32 { " below 4 GiB" } else { "" })))
    })?
}

/// Pages this daemon mapped for its own code and data (speed hook and state pages), as
/// (pid, start, end). `aob_scan` over executable memory skips them (M4 D10). Allocations made for
/// the client (`alloc`) are the game's memory as far as scans go, so they are not listed.
static OWN: std::sync::Mutex<Vec<(i32, u64, u64)>> = std::sync::Mutex::new(Vec::new());

/// `alloc` for the daemon's own pages: the block is listed in `own_ranges` until it is freed.
pub fn alloc_own(t: &Target, size: u64, near: Option<u64>, prot: i32) -> Result<u64, RpcError> {
    let addr = alloc(t, size, near, prot)?;
    OWN.lock().unwrap().push((t.pid, addr, addr + page_round(size)));
    Ok(addr)
}

/// The daemon's own pages in `pid`, as sorted (start, end) ranges.
pub fn own_ranges(pid: i32) -> Vec<(u64, u64)> {
    let mut v: Vec<(u64, u64)> = OWN.lock().unwrap().iter().filter(|e| e.0 == pid).map(|e| (e.1, e.2)).collect();
    v.sort_unstable();
    v
}

/// A failed `free`, and whether the pages may already be unmapped.
pub struct FreeError {
    pub error: RpcError,
    pub maybe_unmapped: bool,
}

/// Unmap `size` bytes at `addr` (an earlier `alloc`).
pub fn free(t: &Target, addr: u64, size: u64) -> Result<(), FreeError> {
    // Unlisted first: if the pages may be gone, scanning there again is harmless.
    let end = addr.saturating_add(page_round(size));
    OWN.lock().unwrap().retain(|&(pid, s, e)| !(pid == t.pid && s < end && addr < e));
    let not_run = |error| FreeError { error, maybe_unmapped: false };
    crate::guard::remote(t).map_err(not_run)?;
    let abi = abi_for(t);
    let tracer = t.tracer().map_err(not_run)?;
    call_site(t, &tracer, abi).map_err(not_run)?;
    match tracer.with_stopped(move |s| s.syscall(abi.nr_munmap(), [addr, size, 0, 0, 0, 0])) {
        // The job never ran (the world could not be stopped), unless it panicked part-way.
        Err(e) => Err(FreeError { maybe_unmapped: e.code == -32603, error: e }),
        // The injection failed part-way: the munmap may have run.
        Ok(Err(e)) => Err(FreeError { error: e, maybe_unmapped: true }),
        // The kernel refused: nothing was unmapped.
        Ok(Ok(r)) => syscall_result_abi(abi, r, "munmap").map(|_| ()).map_err(not_run),
    }
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
        let c = near_candidates(&regions, near, 4096, MAX_ADDR);
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
        let c = near_candidates(&regions, near, 0x2000, MAX_ADDR);
        assert!(!c.is_empty());
        for a in c {
            assert!(a.abs_diff(near) < (1 << 31) - 0x2000 && a + 0x2000 <= MAX_ADDR);
        }
    }

    #[test]
    fn near_candidates_skip_the_stack_guard_and_full_space() {
        let near = 0x7ffd_0000_0000;
        let regions = [region(0x7ffc_ffff_0000, 0x7ffd_0010_0000, Some("[stack]"))];
        let c = near_candidates(&regions, near, 4096, MAX_ADDR);
        assert!(c.iter().all(|&a| a + 4096 <= 0x7ffc_ffff_0000 - STACK_GUARD || a >= 0x7ffd_0010_0000));
        // Everything within reach is mapped: no candidates.
        let full = [region(0, MAX_ADDR, None)];
        assert!(near_candidates(&full, near, 4096, MAX_ADDR).is_empty());
    }

    #[test]
    fn near_candidates_respect_max_addr() {
        let regions = [region(0x400000, 0x405000, Some("/game")), region(0xF000_0000, 0xF010_0000, None)];
        let c = near_candidates(&regions, 0xE000_0000, 0x10000, MAX_ADDR_32);
        assert!(!c.is_empty());
        for a in c {
            assert!(a + 0x10000 <= MAX_ADDR_32, "{a:#x}");
        }
    }

    #[test]
    fn i386_results_are_sign_extended_eax() {
        assert_eq!(SyscallAbi::I386.result(0xFFFF_FFF4), -12); // -ENOMEM
        assert_eq!(syscall_result_abi(SyscallAbi::I386, SyscallAbi::I386.result(0xF7F0_0000), "mmap").unwrap(), 0xF7F0_0000);
        assert_eq!(syscall_result_abi(SyscallAbi::X64, 0x7f00_0000_0000, "mmap").unwrap(), 0x7f00_0000_0000);
    }
}
