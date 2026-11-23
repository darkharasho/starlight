//! Attached processes. `Handles` is per connection; dropping a connection detaches everything.
use crate::freeze::Freezes;
use crate::maps;
use crate::rpc::{Conn, RpcError};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Target {
    pub pid: i32,
    pub pidfd: OwnedFd,
    pub mem: File,
}

type Map = Arc<Mutex<HashMap<u32, Arc<Target>>>>;

pub struct Handles {
    conn: Conn,
    map: Map,
    freezes: Freezes,
    next: u32,
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

fn open_target(pid: i32) -> Result<Target, RpcError> {
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

impl Handles {
    pub fn new(conn: Conn) -> Self {
        Handles { conn, map: Arc::new(Mutex::new(HashMap::new())), freezes: Freezes::default(), next: 1 }
    }

    pub fn attach(&mut self, pid: i32) -> Result<u32, RpcError> {
        let target = Arc::new(open_target(pid)?);
        let handle = self.next;
        self.next += 1;
        self.map.lock().unwrap().insert(handle, target.clone());

        let map = self.map.clone();
        let conn = self.conn.clone();
        let freezes = self.freezes.clone();
        std::thread::spawn(move || loop {
            if poll_exited(&target.pidfd, Duration::from_millis(100)) {
                // Whoever removes the entry owns the notification, so it is sent at most once.
                let removed = map.lock().unwrap().remove(&handle);
                freezes.stop_handle(handle);
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

    /// The exit watcher removes the handle and then cancels its freezes. Rechecking after the
    /// freeze is registered means one side always sees the other, so no freeze outlives its handle.
    fn freeze_target(&self, handle: u32, target: Arc<Target>, addr: u64, data: Vec<u8>, interval_ms: u64) -> Result<u32, RpcError> {
        let id = self.freezes.start(handle, target, addr, data, interval_ms)?;
        if !self.map.lock().unwrap().contains_key(&handle) {
            let _ = self.freezes.stop(id);
            return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
        }
        Ok(id)
    }

    pub fn unfreeze(&self, id: u32) -> Result<(), RpcError> {
        self.freezes.stop(id)
    }

    pub fn detach(&mut self, handle: u32) -> Result<(), RpcError> {
        self.freezes.stop_handle(handle);
        self.map
            .lock()
            .unwrap()
            .remove(&handle)
            .map(|_| ())
            .ok_or_else(|| RpcError::unknown_handle(format!("unknown handle: {handle}")))
    }

    pub fn detach_all(&mut self) {
        self.freezes.stop_all();
        self.map.lock().unwrap().clear();
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
        let handles = Handles::new(Conn::new(a));
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
