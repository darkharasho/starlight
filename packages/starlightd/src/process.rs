//! Attached processes. `Handles` is per connection; dropping a connection detaches everything.
use crate::cleanup::{Owner, Teardown, ON_TARGET_EXIT};
use crate::freeze::Freezes;
use crate::maps;
use crate::remote;
use crate::rpc::{Conn, RpcError};
use crate::tracer::{self, Tracer};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Target {
    pub pid: i32,
    pub pidfd: OwnedFd,
    pub mem: File,
}

type Map = Arc<Mutex<HashMap<u32, Arc<Target>>>>;
/// Per handle: address -> size of each live remote allocation. Only records: the memory itself is
/// never freed automatically (D9).
type Allocs = Arc<Mutex<HashMap<u32, HashMap<u64, u64>>>>;

pub struct Handles {
    conn: Conn,
    owner: Arc<Owner>,
    map: Map,
    freezes: Freezes,
    allocs: Allocs,
    next: AtomicU32,
}

fn pidfd_open(pid: i32) -> io::Result<OwnedFd> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

fn map_errno(e: &io::Error, pid: i32) -> RpcError {
    match e.raw_os_error() {
        Some(libc::ESRCH) | Some(libc::ENOENT) => RpcError::process_not_found(format!("no such process: {pid}")),
        Some(libc::EACCES) | Some(libc::EPERM) => {
            RpcError::permission_denied(format!("not permitted to access pid {pid}: {e}"))
        }
        _ => RpcError::internal_error(format!("cannot access pid {pid}: {e}")),
    }
}

pub(crate) fn open_target(pid: i32) -> Result<Target, RpcError> {
    if pid <= 0 {
        return Err(RpcError::invalid_params("pid must be positive"));
    }
    let pidfd = pidfd_open(pid).map_err(|e| map_errno(&e, pid))?;
    let mem = OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("/proc/{pid}/mem"))
        .map_err(|e| map_errno(&e, pid))?;
    let t = Target { pid, pidfd, mem };
    // Validate that reads actually work (ptrace access check) before handing out a handle.
    let regions = maps::read(pid).map_err(|e| map_errno(&e, pid))?;
    if let Some(r) = regions.iter().find(|r| r.perms.read) {
        let mut b = [0u8; 1];
        let local = libc::iovec { iov_base: b.as_mut_ptr() as *mut libc::c_void, iov_len: 1 };
        let remote = libc::iovec { iov_base: r.start as usize as *mut libc::c_void, iov_len: 1 };
        let n = unsafe { libc::process_vm_readv(pid, &local, 1, &remote, 1, 0) };
        if n < 0 {
            let e = io::Error::last_os_error();
            if matches!(e.raw_os_error(), Some(libc::EPERM) | Some(libc::ESRCH)) {
                return Err(map_errno(&e, pid));
            }
        }
    }
    Ok(t)
}

/// True once the process behind `pidfd` has exited (pidfd becomes readable).
fn poll_exited(pidfd: &OwnedFd, timeout: Duration) -> bool {
    let mut p = libc::pollfd { fd: pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    let r = unsafe { libc::poll(&mut p, 1, timeout.as_millis() as i32) };
    r > 0 && p.revents != 0
}

impl Target {
    /// True once the process has exited (its pidfd is readable).
    pub fn exited(&self) -> bool {
        poll_exited(&self.pidfd, Duration::ZERO)
    }

    /// The process's ptrace tracer, attaching if nobody holds it. Keep the `Arc` only while
    /// something needs the game traced (a patch, hook, watch, or an operation in progress):
    /// dropping the last one detaches. Plain attach, read, write and scan never call this.
    pub fn tracer(&self) -> Result<Arc<Tracer>, RpcError> {
        let gone = || RpcError::process_not_found(format!("process {} has exited", self.pid));
        if self.exited() {
            return Err(gone());
        }
        let t = tracer::for_pid(self.pid)?;
        // The pidfd pins the process we attached to; if it exited before the seize, the pid
        // may already name another process, and dropping `t` detaches from it at once.
        if self.exited() {
            return Err(gone());
        }
        Ok(t)
    }
}

impl Handles {
    pub fn new(conn: Conn, owner: Arc<Owner>) -> Self {
        Handles {
            conn,
            owner,
            map: Arc::new(Mutex::new(HashMap::new())),
            freezes: Freezes::default(),
            allocs: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU32::new(1),
        }
    }

    pub fn attach(&self, pid: i32) -> Result<u32, RpcError> {
        let target = Arc::new(open_target(pid)?);
        let handle = self.next.fetch_add(1, Ordering::Relaxed);
        self.map.lock().unwrap().insert(handle, target.clone());

        let map = self.map.clone();
        let allocs = self.allocs.clone();
        let conn = self.conn.clone();
        let owner = self.owner.clone();
        std::thread::spawn(move || loop {
            if poll_exited(&target.pidfd, Duration::from_millis(100)) {
                owner.run_handle_kinds(handle, ON_TARGET_EXIT);
                // Whoever removes the entry owns the notification, so it is sent at most once.
                let removed = map.lock().unwrap().remove(&handle);
                allocs.lock().unwrap().remove(&handle);
                // Anything registered while the handle was still in the map.
                owner.run_handle_kinds(handle, ON_TARGET_EXIT);
                if removed.is_some() {
                    conn.send_notification("process_exited", serde_json::json!({ "handle": handle }));
                }
                return;
            }
            if !map.lock().unwrap().contains_key(&handle) {
                return; // detached
            }
        });
        Ok(handle)
    }

    pub fn get(&self, handle: u32) -> Result<Arc<Target>, RpcError> {
        self.map
            .lock()
            .unwrap()
            .get(&handle)
            .cloned()
            .ok_or_else(|| RpcError::unknown_handle(format!("unknown handle: {handle}")))
    }

    pub fn freeze(&self, handle: u32, addr: u64, data: Vec<u8>, interval_ms: u64) -> Result<u32, RpcError> {
        let target = self.get(handle)?;
        self.freeze_target(handle, target, addr, data, interval_ms)
    }

    /// Detach and the exit watcher run the handle's teardown and remove it from the map. Rechecking
    /// after the freeze's teardown is registered means one side always sees the other, so no
    /// freeze outlives its handle.
    fn freeze_target(&self, handle: u32, target: Arc<Target>, addr: u64, data: Vec<u8>, interval_ms: u64) -> Result<u32, RpcError> {
        let id = self.freezes.start(target, addr, data, interval_ms)?;
        let freezes = self.freezes.clone();
        let token = self.owner.add(Some(handle), Teardown::Freeze, Box::new(move || {
            let _ = freezes.stop(id);
        }));
        self.freezes.set_token(id, token);
        if !self.map.lock().unwrap().contains_key(&handle) {
            self.owner.remove(token);
            let _ = self.freezes.stop(id);
            return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
        }
        Ok(id)
    }

    pub fn unfreeze(&self, id: u32) -> Result<(), RpcError> {
        if let Some(token) = self.freezes.stop(id)? {
            self.owner.remove(token);
        }
        Ok(())
    }

    /// Allocate in the target and record it for `handle`; returns (address, size in bytes).
    pub fn alloc(&self, handle: u32, size: u64, near: Option<u64>, prot: i32) -> Result<(u64, u64), RpcError> {
        let target = self.get(handle)?;
        let addr = remote::alloc(&target, size, near, prot)?;
        let len = remote::page_round(size);
        self.allocs.lock().unwrap().entry(handle).or_default().insert(addr, len);
        // Detach drops the handle's records after removing it from the map: recheck, as for
        // freezes, so no record outlives its handle. The pages stay mapped either way (D9).
        if !self.map.lock().unwrap().contains_key(&handle) {
            self.allocs.lock().unwrap().remove(&handle);
            return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
        }
        Ok((addr, len))
    }

    /// Unmap an allocation `handle` made. Any other address is `-32009`.
    pub fn free(&self, handle: u32, addr: u64) -> Result<(), RpcError> {
        let target = self.get(handle)?;
        // Taken out first, so two concurrent frees can't both unmap it.
        let size = self
            .allocs
            .lock()
            .unwrap()
            .get_mut(&handle)
            .and_then(|m| m.remove(&addr))
            .ok_or_else(|| RpcError::unknown_id(format!("no allocation at {addr:#x} on handle {handle}")))?;
        remote::free(&target, addr, size).map_err(|e| {
            // Keep the record only if the pages are certainly still mapped.
            if !e.maybe_unmapped {
                self.allocs.lock().unwrap().entry(handle).or_default().insert(addr, size);
            }
            e.error
        })
    }

    pub fn detach(&self, handle: u32) -> Result<(), RpcError> {
        self.owner.run_handle(handle);
        let removed = self.map.lock().unwrap().remove(&handle);
        self.allocs.lock().unwrap().remove(&handle);
        // Anything registered while the handle was still in the map.
        self.owner.run_handle(handle);
        removed.map(|_| ()).ok_or_else(|| RpcError::unknown_handle(format!("unknown handle: {handle}")))
    }

    /// Connection end: run every teardown action (handle-owned and connection-owned).
    pub fn detach_all(&self) {
        self.owner.run_all();
        self.map.lock().unwrap().clear();
        self.allocs.lock().unwrap().clear();
    }
}

impl Drop for Handles {
    fn drop(&mut self) {
        self.detach_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    static CELL: u32 = 0;

    #[test]
    fn freeze_on_a_dead_handle_is_cancelled_by_the_recheck() {
        let (a, _b) = UnixStream::pair().unwrap();
        let handles = Handles::new(Conn::new(a), Arc::new(Owner::default()));
        let pid = std::process::id() as i32;
        let target = Arc::new(Target {
            pid,
            pidfd: pidfd_open(pid).unwrap(),
            mem: OpenOptions::new().read(true).write(true).open("/proc/self/mem").unwrap(),
        });
        // Handle 7 was never inserted: models the watcher having removed it between get and insert.
        let addr = &CELL as *const u32 as u64;
        let e = handles.freeze_target(7, target, addr, vec![0; 4], 20).unwrap_err();
        assert_eq!(e.code, -32007);
        assert!(handles.unfreeze(1).is_err(), "freeze must not survive");
    }
}
