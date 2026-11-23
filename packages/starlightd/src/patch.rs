//! Recorded code patches. Each write happens with every thread stopped and no thread inside the
//! site (D8). The original bytes are kept and restored on `unpatch`, and on session end through
//! the connection's teardown owner.
use crate::cleanup::{Owner, Teardown};
use crate::process::Target;
use crate::rpc::RpcError;
use crate::tracer::Tracer;
use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Stop-the-world attempts before giving up with `Busy` (D8).
const MAX_TRIES: u32 = 200;
/// How long the game runs between attempts.
const RETRY_PAUSE: Duration = Duration::from_millis(1);

enum Write {
    /// Written; holds the bytes that were there before.
    Done(Vec<u8>),
    /// Not written: the current bytes differ from the expected ones (holds them).
    Changed(Vec<u8>),
    /// The write came up short: the first part of the bytes may be in place.
    Partial(RpcError),
}

/// `-ERESTARTSYS`, `-ERESTARTNOINTR`, `-ERESTARTNOHAND`, `-ERESTART_RESTARTBLOCK`: a syscall
/// interrupted by our stop that the kernel restarts by moving RIP back over the `syscall`.
const RESTART_ERRNOS: [i64; 4] = [-512, -513, -514, -516];
/// Length of `syscall` (`0f 05`).
const SYSCALL_LEN: u64 = 2;

/// True if the thread with registers `r` is, or will resume, strictly inside `(addr, end)`. A
/// thread stopped in a syscall the kernel will restart resumes at `rip - 2`, so that counts too.
fn inside(r: &libc::user_regs_struct, addr: u64, end: u64) -> bool {
    let within = |rip: u64| rip > addr && rip < end;
    let restarts = (r.orig_rax as i64) >= 0 && RESTART_ERRNOS.contains(&(r.rax as i64));
    within(r.rip) || (restarts && within(r.rip.wrapping_sub(SYSCALL_LEN)))
}

/// Why `Patches::apply_with` failed, and whether the game may have run the new bytes.
#[derive(Debug)]
pub enum ApplyError {
    /// Nothing was written.
    NotWritten(RpcError),
    /// `expect` did not match the current bytes (given here); nothing was written.
    Changed(Vec<u8>),
    /// The bytes were (or may have been) written and the game may have run them, but no patch
    /// was recorded (e.g. the session ended meanwhile and the patch was reverted at once).
    Written(RpcError),
}

impl From<ApplyError> for RpcError {
    fn from(e: ApplyError) -> Self {
        match e {
            ApplyError::NotWritten(e) | ApplyError::Written(e) => e,
            ApplyError::Changed(now) => {
                RpcError::patch_conflict(format!("the code changed (now {})", crate::rpc::to_hex(&now)))
            }
        }
    }
}

/// Write `bytes` at `addr` with every thread stopped, once no thread's RIP is strictly inside the
/// site. Returns the original bytes. `-32013 Busy` if a thread stays inside for 200 attempts.
#[allow(dead_code)] // used by the speed hooks' GOT slot writes (Task 12)
pub fn write_code(t: &Target, tracer: &Tracer, addr: u64, bytes: &[u8]) -> Result<Vec<u8>, RpcError> {
    match write_checked(t, tracer, addr, bytes, None)? {
        Write::Done(original) | Write::Changed(original) => Ok(original),
        Write::Partial(e) => Err(e),
    }
}

/// `write_code`, but only if the current bytes equal `expect` (checked in the same stop).
fn write_checked(t: &Target, tracer: &Tracer, addr: u64, bytes: &[u8], expect: Option<&[u8]>) -> Result<Write, RpcError> {
    let len = bytes.len() as u64;
    let end = addr.checked_add(len).filter(|&e| e <= i64::MAX as u64).ok_or_else(|| {
        RpcError::write_failed(format!("address {addr:#x} out of range"))
    })?;
    let mem = Arc::new(t.mem.try_clone().map_err(|e| RpcError::internal_error(format!("cannot dup mem fd: {e}")))?);
    let bytes: Arc<[u8]> = bytes.into();
    let expect: Option<Arc<[u8]>> = expect.map(Into::into);
    for _ in 0..MAX_TRIES {
        let (mem, bytes, expect) = (mem.clone(), bytes.clone(), expect.clone());
        let step = tracer.with_stopped(move |s| -> Result<Option<Write>, RpcError> {
            let current = read_at(&mem, addr, bytes.len())?;
            if expect.as_deref().is_some_and(|e| e != current.as_slice()) {
                return Ok(Some(Write::Changed(current)));
            }
            for &tid in s.tids() {
                match s.regs(tid) {
                    Ok(r) if inside(&r, addr, end) => return Ok(None),
                    Ok(_) => {}
                    // Its RIP is unknown (the thread is going away): try again.
                    Err(_) => return Ok(None),
                }
            }
            match mem.write_at(&bytes, addr) {
                Ok(n) if n == bytes.len() => Ok(Some(Write::Done(current))),
                Ok(n) => Ok(Some(Write::Partial(RpcError::write_failed(format!(
                    "short write at {addr:#x}: {n} of {} bytes",
                    bytes.len()
                ))))),
                Err(e) => Err(RpcError::write_failed(format!("write at {addr:#x}: {e}"))),
            }
        })??;
        match step {
            Some(w) => return Ok(w),
            None => std::thread::sleep(RETRY_PAUSE),
        }
    }
    Err(RpcError::busy(format!(
        "a game thread stayed inside {addr:#x}..{end:#x} for {MAX_TRIES} attempts; try again"
    )))
}

fn read_at(mem: &File, addr: u64, len: usize) -> Result<Vec<u8>, RpcError> {
    let mut buf = vec![0u8; len];
    mem.read_exact_at(&mut buf, addr)
        .map_err(|e| RpcError::write_failed(format!("cannot read {len} bytes at {addr:#x}: {e}")))?;
    Ok(buf)
}

/// One live patch.
struct Rec {
    id: u32,
    target: Arc<Target>,
    addr: u64,
    written: Vec<u8>,
    original: Vec<u8>,
    /// Its teardown action in the connection's owner.
    token: Mutex<Option<u64>>,
    /// The tracer while the patch is live; `None` once reverted. Holding it keeps the game
    /// traced (R12): the last patch to go away detaches. Locked across a revert's write.
    tracer: Mutex<Option<Arc<Tracer>>>,
}

type Live = Arc<Mutex<HashMap<u32, Arc<Rec>>>>;

/// One connection's code patches.
pub struct Patches {
    owner: Arc<Owner>,
    live: Live,
    next: AtomicU32,
    /// Serializes `apply`, so an overlap check and its write can't interleave with another's.
    applying: Mutex<()>,
}

impl Patches {
    pub fn new(owner: Arc<Owner>) -> Self {
        Patches { owner, live: Live::default(), next: AtomicU32::new(1), applying: Mutex::new(()) }
    }

    /// Patch `bytes` at `addr` for `handle`. Returns the patch id and the original bytes. A range
    /// overlapping a live patch in the same process is `-32014`.
    pub fn apply(&self, handle: u32, t: &Arc<Target>, addr: u64, bytes: &[u8]) -> Result<(u32, Vec<u8>), RpcError> {
        if bytes.is_empty() {
            return Err(RpcError::invalid_params("bytes must not be empty"));
        }
        let tracer = t.tracer()?;
        Ok(self.apply_with(handle, t, tracer, addr, bytes, None)?)
    }

    /// `apply` with a tracer the caller already holds. With `expect`, the bytes are written only
    /// if the current ones equal it (checked in the same stop as the write).
    pub fn apply_with(
        &self,
        handle: u32,
        t: &Arc<Target>,
        tracer: Arc<Tracer>,
        addr: u64,
        bytes: &[u8],
        expect: Option<&[u8]>,
    ) -> Result<(u32, Vec<u8>), ApplyError> {
        let end = addr.saturating_add(bytes.len() as u64);
        let _applying = self.applying.lock().unwrap();
        if let Some(other) =
            self.live.lock().unwrap().values().find(|r| r.target.pid == t.pid && r.addr < end && addr < r.addr + r.written.len() as u64)
        {
            return Err(ApplyError::NotWritten(RpcError::patch_conflict(format!(
                "{addr:#x}..{end:#x} overlaps patch {} at {:#x}..{:#x}",
                other.id,
                other.addr,
                other.addr + other.written.len() as u64
            ))));
        }
        let original = match write_checked(t, &tracer, addr, bytes, expect).map_err(ApplyError::NotWritten)? {
            Write::Done(original) => original,
            Write::Changed(now) => return Err(ApplyError::Changed(now)),
            Write::Partial(e) => return Err(ApplyError::Written(e)),
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let rec = Arc::new(Rec {
            id,
            target: t.clone(),
            addr,
            written: bytes.to_vec(),
            original: original.clone(),
            token: Mutex::new(None),
            tracer: Mutex::new(Some(tracer)),
        });
        self.live.lock().unwrap().insert(id, rec.clone());
        let (live, r) = (self.live.clone(), rec.clone());
        // If the owner is already closed (the connection is ending) this reverts at once.
        let token = self.owner.add(Some(handle), Teardown::Patch, Box::new(move || teardown(&live, &r)));
        *rec.token.lock().unwrap() = Some(token);
        if rec.tracer.lock().unwrap().is_none() {
            return Err(ApplyError::Written(RpcError::unknown_handle(format!("handle {handle} went away while patching"))));
        }
        Ok((id, original))
    }

    /// Restore patch `id`'s original bytes. If the game changed the patched bytes since, that is
    /// `-32014` unless `force`. Unknown (or already reverted) id is `-32009`.
    pub fn revert(&self, id: u32, force: bool) -> Result<(), RpcError> {
        let unknown = || RpcError::unknown_id(format!("unknown patch id: {id}"));
        let rec = self.live.lock().unwrap().get(&id).cloned().ok_or_else(unknown)?;
        let tracer = {
            let mut held = rec.tracer.lock().unwrap();
            let tracer = held.as_ref().ok_or_else(unknown)?;
            let expect = (!force).then_some(rec.written.as_slice());
            match write_checked(&rec.target, tracer, rec.addr, &rec.original, expect)? {
                Write::Done(_) => {}
                Write::Changed(now) => {
                    return Err(RpcError::patch_conflict(format!(
                        "the bytes at {:#x} changed since patch {id} (now {}); use force to restore anyway",
                        rec.addr,
                        crate::rpc::to_hex(&now)
                    )))
                }
                // Part of the original is back; the patch stays live so it can be retried.
                Write::Partial(e) => return Err(e),
            }
            held.take()
        };
        self.live.lock().unwrap().remove(&id);
        if let Some(token) = rec.token.lock().unwrap().take() {
            self.owner.remove(token);
        }
        drop(tracer); // may detach: outside every lock
        Ok(())
    }
}

/// Session-end revert: restore the original bytes only if ours are still there. A dead process
/// (or any other failure) is ignored, as there is nobody to report it to.
fn teardown(live: &Live, rec: &Rec) {
    let tracer = {
        let mut held = rec.tracer.lock().unwrap();
        let Some(tracer) = held.take() else { return };
        let _ = write_checked(&rec.target, &tracer, rec.addr, &rec.original, Some(&rec.written));
        tracer
    };
    live.lock().unwrap().remove(&rec.id);
    drop(tracer);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::open_target;
    use crate::tracer::tests::TestTarget;

    fn regs(rip: u64, rax: i64, orig_rax: i64) -> libc::user_regs_struct {
        let mut r: libc::user_regs_struct = unsafe { std::mem::zeroed() };
        r.rip = rip;
        r.rax = rax as u64;
        r.orig_rax = orig_rax as u64;
        r
    }

    #[test]
    fn inside_is_strict_and_counts_syscall_restarts() {
        let (a, e) = (0x1000, 0x1008);
        assert!(!inside(&regs(0x1000, 0, -1), a, e), "at the start is fine");
        assert!(inside(&regs(0x1001, 0, -1), a, e));
        assert!(inside(&regs(0x1007, 0, -1), a, e));
        assert!(!inside(&regs(0x1008, 0, -1), a, e), "at the end is fine");
        // Blocked in a syscall right after the range: restarts at rip-2, inside.
        for errno in RESTART_ERRNOS {
            assert!(inside(&regs(0x1009, errno, 202), a, e), "{errno}");
        }
        // Same RIP, but the syscall completed (or is not a syscall stop): resumes at rip.
        assert!(!inside(&regs(0x1009, -4, 202), a, e), "-EINTR is not restarted");
        assert!(!inside(&regs(0x1009, -512, -1), a, e), "not in a syscall");
        assert!(!inside(&regs(0x100a, -512, 202), a, e), "restart lands on the end");
    }

    #[test]
    fn apply_with_types_its_failures() {
        let tt = TestTarget::spawn(&[]);
        let t = Arc::new(open_target(tt.pid()).unwrap());
        let f = tt.addrs["bump_counter"];
        let orig = crate::mem::read_bytes(&t, f, 4).unwrap();
        let owner = Arc::new(Owner::default());
        let patches = Patches::new(owner.clone());

        // Expected bytes differ: refused before anything is written.
        let e = patches.apply_with(1, &t, t.tracer().unwrap(), f, &[0x90; 4], Some(&[0xCC; 4])).unwrap_err();
        assert!(matches!(&e, ApplyError::Changed(now) if *now == orig), "{e:?}");
        assert_eq!(crate::mem::read_bytes(&t, f, 4).unwrap(), orig);

        // Session already over: written, then reverted at once. Reported as `Written`, so a
        // caller knows the game may have run the bytes.
        owner.run_all();
        let e = patches.apply_with(1, &t, t.tracer().unwrap(), f, &[0x90; 4], Some(&orig)).unwrap_err();
        assert!(matches!(&e, ApplyError::Written(r) if r.code == -32007), "{e:?}");
        assert_eq!(crate::mem::read_bytes(&t, f, 4).unwrap(), orig, "the teardown did not revert");
    }
}
