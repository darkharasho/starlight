//! Only the process that spawned the daemon (Starlight) may use it: the daemon
//! can hold cap_sys_ptrace, so another same-user process must not borrow it.

use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;

/// The connecting process's pid, from SO_PEERCRED.
pub fn peer_pid(stream: &UnixStream) -> Option<libc::pid_t> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    (rc == 0 && cred.pid > 0).then_some(cred.pid)
}

pub fn parent_pid() -> libc::pid_t {
    unsafe { libc::getppid() }
}

/// A peer is allowed only if it is our parent. Pid 1 is never a real parent
/// here: it means Starlight died and we were reparented.
pub fn peer_allowed(peer: Option<libc::pid_t>, parent: libc::pid_t) -> bool {
    parent > 1 && peer == Some(parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_is_allowed() {
        assert!(peer_allowed(Some(1234), 1234));
    }

    #[test]
    fn other_pid_is_refused() {
        assert!(!peer_allowed(Some(999), 1234));
    }

    #[test]
    fn unknown_peer_is_refused() {
        assert!(!peer_allowed(None, 1234));
    }

    #[test]
    fn orphaned_daemon_refuses_init() {
        assert!(!peer_allowed(Some(1), 1));
    }

    #[test]
    fn peer_pid_reads_socketpair_peer() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(peer_pid(&a), Some(std::process::id() as libc::pid_t));
    }
}
