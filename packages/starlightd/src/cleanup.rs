//! Teardown owner: every change the daemon makes to a game is registered here with the action
//! that undoes it, so it can be reverted on detach, connection close, stdin EOF and signals.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration;

/// How long `main` waits for teardown before exiting anyway.
pub const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(3);

/// Teardown order: lower kinds run first. Within a kind, the newest action runs first.
/// `Watch` and `Scan` are first used by later M2 tasks (and `Scan` by debug builds).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Teardown {
    Patch = 0,
    Watch = 1,
    Freeze = 2,
    Scan = 3,
}

/// What a target's exit tears down (ruling R4): code changes and freezes. Scan sessions stay
/// registered (later calls report the process is gone), and watches end through their own
/// exit handling so they can report `process_exited`.
pub const ON_TARGET_EXIT: &[Teardown] = &[Teardown::Patch, Teardown::Freeze];

type Action = Box<dyn FnOnce() + Send>;

struct Entry {
    token: u64,
    handle: Option<u32>,
    kind: Teardown,
    f: Action,
}

#[derive(Default)]
struct State {
    next: u64,
    entries: Vec<Entry>,
    /// Batches taken from `entries` that are still running.
    running: usize,
    /// Set by `run_all`: anything added afterwards runs at once.
    closed: bool,
}

/// One connection's teardown actions.
#[derive(Default)]
pub struct Owner {
    state: Mutex<State>,
    idle: Condvar,
}

impl Owner {
    /// Register `f` to run at teardown. `handle: None` means it belongs to the connection.
    /// After `run_all` the owner is closed, and `f` runs immediately.
    pub fn add(&self, handle: Option<u32>, kind: Teardown, f: Action) -> u64 {
        let mut s = self.state.lock().unwrap();
        s.next += 1;
        let token = s.next;
        if s.closed {
            drop(s);
            run_one(f);
        } else {
            s.entries.push(Entry { token, handle, kind, f });
        }
        token
    }

    /// Drop an action without running it (the change was undone some other way).
    /// The action is dropped after the lock is released, so whatever it owns (e.g. an
    /// `Arc<Tracer>`, whose drop detaches) is never torn down under the owner's lock.
    pub fn remove(&self, token: u64) -> bool {
        let removed = {
            let mut s = self.state.lock().unwrap();
            let i = s.entries.iter().position(|e| e.token == token);
            i.map(|i| s.entries.remove(i))
        };
        removed.is_some()
    }

    /// Run every action of `handle`.
    pub fn run_handle(&self, handle: u32) {
        self.run_matching(|e| e.handle == Some(handle));
    }

    /// Run the actions of `handle` whose kind is in `kinds`.
    pub fn run_handle_kinds(&self, handle: u32, kinds: &[Teardown]) {
        self.run_matching(|e| e.handle == Some(handle) && kinds.contains(&e.kind));
    }

    /// Run everything, close the owner, and wait for batches other threads are still running,
    /// so a caller about to exit knows every revert has finished.
    pub fn run_all(&self) {
        self.state.lock().unwrap().closed = true;
        self.run_matching(|_| true);
        let mut s = self.state.lock().unwrap();
        while s.running > 0 {
            s = self.idle.wait(s).unwrap();
        }
    }

    fn run_matching(&self, pred: impl Fn(&Entry) -> bool) {
        let mut batch = {
            let mut s = self.state.lock().unwrap();
            let (take, keep): (Vec<Entry>, Vec<Entry>) = std::mem::take(&mut s.entries).into_iter().partition(|e| pred(e));
            s.entries = keep;
            if take.is_empty() {
                return;
            }
            s.running += 1;
            take
        };
        // Decrements `running` even if an action panics.
        struct Done<'a>(&'a Owner);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.state.lock().unwrap().running -= 1;
                self.0.idle.notify_all();
            }
        }
        let _done = Done(self);
        batch.sort_by_key(|e| (e.kind, std::cmp::Reverse(e.token)));
        for e in batch {
            run_one(e.f);
        }
    }
}

/// One failing revert must not stop the others.
fn run_one(f: Action) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

static OWNERS: Mutex<Vec<Weak<Owner>>> = Mutex::new(Vec::new());

/// Make `owner` part of the daemon-wide shutdown.
pub fn register(owner: &Arc<Owner>) {
    let mut list = OWNERS.lock().unwrap();
    list.retain(|w| w.strong_count() > 0);
    list.push(Arc::downgrade(owner));
}

/// Run every live owner's `run_all` on a helper thread. Returns when they finish or at `deadline`.
pub fn shutdown_all(deadline: Duration) {
    let owners: Vec<Arc<Owner>> = OWNERS.lock().unwrap().iter().filter_map(Weak::upgrade).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for o in owners {
            o.run_all();
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(deadline);
}

/// Block SIGTERM, SIGINT and SIGHUP in the calling thread (call it from `main` before any other
/// thread starts, so every thread inherits the mask), then handle them on a dedicated thread:
/// tear everything down, then exit cleanly.
pub fn spawn_signal_thread() {
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::sigaddset(&mut set, libc::SIGHUP);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };
    std::thread::spawn(move || loop {
        let mut sig = 0;
        if unsafe { libc::sigwait(&set, &mut sig) } == 0 {
            shutdown_all(SHUTDOWN_DEADLINE);
            std::process::exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorder() -> (Arc<Mutex<Vec<&'static str>>>, impl Fn(&'static str) -> Action) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        (log, move |name| {
            let l = l.clone();
            Box::new(move || l.lock().unwrap().push(name)) as Action
        })
    }

    #[test]
    fn runs_patches_before_scans() {
        let (log, act) = recorder();
        let o = Owner::default();
        o.add(Some(1), Teardown::Scan, act("scan"));
        o.add(Some(1), Teardown::Freeze, act("freeze"));
        o.add(Some(1), Teardown::Patch, act("patch"));
        o.add(None, Teardown::Watch, act("watch"));
        o.run_all();
        assert_eq!(*log.lock().unwrap(), ["patch", "watch", "freeze", "scan"]);
    }

    #[test]
    fn newest_patch_runs_first() {
        let (log, act) = recorder();
        let o = Owner::default();
        o.add(Some(1), Teardown::Patch, act("first"));
        o.add(Some(1), Teardown::Patch, act("second"));
        o.add(Some(1), Teardown::Patch, act("third"));
        o.run_handle(1);
        assert_eq!(*log.lock().unwrap(), ["third", "second", "first"]);
    }

    #[test]
    fn removed_token_never_runs() {
        let (log, act) = recorder();
        let o = Owner::default();
        let t = o.add(Some(1), Teardown::Patch, act("removed"));
        o.add(Some(1), Teardown::Patch, act("kept"));
        assert!(o.remove(t));
        assert!(!o.remove(t), "a token can only be removed once");
        o.run_all();
        assert_eq!(*log.lock().unwrap(), ["kept"]);
    }

    #[test]
    fn run_handle_leaves_other_handles_and_kinds() {
        let (log, act) = recorder();
        let o = Owner::default();
        o.add(Some(1), Teardown::Patch, act("h1 patch"));
        o.add(Some(1), Teardown::Scan, act("h1 scan"));
        o.add(Some(2), Teardown::Patch, act("h2 patch"));
        o.add(None, Teardown::Scan, act("conn"));
        o.run_handle_kinds(1, ON_TARGET_EXIT);
        assert_eq!(*log.lock().unwrap(), ["h1 patch"]);
        o.run_handle(1);
        assert_eq!(*log.lock().unwrap(), ["h1 patch", "h1 scan"]);
        o.run_all();
        assert_eq!(*log.lock().unwrap(), ["h1 patch", "h1 scan", "h2 patch", "conn"]);
    }

    #[test]
    fn add_after_run_all_runs_at_once_and_panics_are_contained() {
        let (log, act) = recorder();
        let o = Owner::default();
        o.add(None, Teardown::Patch, Box::new(|| panic!("revert failed")));
        o.add(None, Teardown::Scan, act("after panic"));
        o.run_all();
        o.add(Some(3), Teardown::Patch, act("late"));
        assert_eq!(*log.lock().unwrap(), ["after panic", "late"]);
    }

    #[test]
    fn run_all_waits_for_a_batch_running_elsewhere() {
        let o = Arc::new(Owner::default());
        let (log, act) = recorder();
        let slow_log = log.clone();
        o.add(Some(1), Teardown::Patch, Box::new(move || {
            std::thread::sleep(Duration::from_millis(200));
            slow_log.lock().unwrap().push("slow revert");
        }));
        let o2 = o.clone();
        let t = std::thread::spawn(move || o2.run_handle(1));
        std::thread::sleep(Duration::from_millis(50)); // let the other thread take the batch
        o.add(None, Teardown::Scan, act("conn"));
        o.run_all();
        assert_eq!(*log.lock().unwrap(), ["conn", "slow revert"], "run_all returned before the revert finished");
        t.join().unwrap();
    }
}
