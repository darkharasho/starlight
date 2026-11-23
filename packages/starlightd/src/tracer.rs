//! One ptrace tracer thread per traced process (D5), shared by every connection.
//!
//! ptrace requests must come from the thread that attached, so a dedicated thread owns every
//! ptrace call for its pid. Callers send it jobs (`with_stopped`): it stops every thread, runs the
//! job, and resumes them. Between jobs it keeps the game running: signals are passed through,
//! group-stops are honoured with `PTRACE_LISTEN`, new threads (`PTRACE_O_TRACECLONE`) get the
//! active watch slots before they first run. `PTRACE_O_EXITKILL` is never used, and if this thread
//! dies the kernel detaches every tracee, so a daemon crash never takes the game with it.
//!
//! Lifetime: the tracer stays attached while anyone holds its `Arc`. Holders are patches, hooks,
//! watches and in-flight remote operations; dropping the last `Arc` clears debug registers and
//! detaches (ruling R12: allocations alone never keep the game traced).
use crate::rpc::RpcError;
use std::collections::HashMap;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, LazyLock, Mutex, Weak};
use std::thread::{JoinHandle, ThreadId};
use std::time::{Duration, Instant};

/// How long a stop-the-world (or a single-step) may take before the job fails.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
/// Idle poll interval of the event loop: the longest a game signal or new thread waits for us.
const POLL: Duration = Duration::from_millis(1);

/// Hardware watchpoint condition (DR7 R/W bits).
#[allow(dead_code)] // used by watchpoints (Task 9)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrRw {
    Write,
    Access,
}

/// One debug-register slot: break when `len` bytes at `addr` are written or accessed.
#[allow(dead_code)] // used by watchpoints (Task 9)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrConfig {
    pub addr: u64,
    /// 1, 2, 4 or 8, with `addr` aligned to it.
    pub len: u8,
    pub rw: DrRw,
}

impl DrConfig {
    /// DR7 bits enabling this config in `slot`: local enable `L<n>`, `R/W<n>`, `LEN<n>`.
    fn dr7_bits(&self, slot: usize) -> u64 {
        let rw = match self.rw {
            DrRw::Write => 0b01,
            DrRw::Access => 0b11,
        };
        let len = match self.len {
            1 => 0b00,
            2 => 0b01,
            8 => 0b10,
            _ => 0b11, // 4
        };
        (1 << (slot * 2)) | (rw << (16 + slot * 4)) | (len << (18 + slot * 4))
    }
}

/// A hit on one of our watch slots: the thread, its registers after the access, and DR6.
#[allow(dead_code)] // used by watchpoints (Task 9)
#[derive(Clone, Copy)]
pub struct Trap {
    pub tid: i32,
    pub regs: libc::user_regs_struct,
    pub dr6: u64,
}

type Job = Box<dyn FnOnce(Result<&mut Stopped<'_>, RpcError>) + Send>;

enum Cmd {
    Run(Job),
    Shutdown,
}

/// Set once the tracer thread has finished (detached or found the process gone).
#[derive(Default)]
struct Gone {
    done: Mutex<bool>,
    cv: Condvar,
}

impl Gone {
    fn set(&self) {
        *self.done.lock().unwrap() = true;
        self.cv.notify_all();
    }
    fn is_set(&self) -> bool {
        *self.done.lock().unwrap()
    }
    fn wait(&self, timeout: Duration) {
        let g = self.done.lock().unwrap();
        let _ = self.cv.wait_timeout_while(g, timeout, |d| !*d);
    }
}

/// State shared between the `Tracer` handle and its thread.
struct Shared {
    dead: AtomicBool,
    gone: Gone,
    subscribers: Mutex<Vec<Sender<Trap>>>,
    syscall_site: Mutex<Option<u64>>,
}

pub struct Tracer {
    pid: i32,
    tx: Sender<Cmd>,
    thread: Mutex<Option<JoinHandle<()>>>,
    thread_id: ThreadId,
    shared: Arc<Shared>,
}

struct Entry {
    tracer: Weak<Tracer>,
    shared: Arc<Shared>,
}

static REGISTRY: LazyLock<Mutex<HashMap<i32, Entry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The tracer for `pid`, attaching if nobody holds one. Concurrent callers for the same pid get
/// the same tracer; different pids never block on each other's events.
pub fn for_pid(pid: i32) -> Result<Arc<Tracer>, RpcError> {
    let mut reg = REGISTRY.lock().unwrap();
    if let Some(e) = reg.get(&pid) {
        if let Some(t) = e.tracer.upgrade() {
            if !t.shared.dead.load(Ordering::Acquire) {
                return Ok(t);
            }
        } else {
            // The last holder is still detaching: a new seize would fail with EPERM until it is done.
            e.shared.gone.wait(STOP_TIMEOUT * 2);
        }
    }
    let t = Arc::new(Tracer::spawn(pid)?);
    reg.retain(|_, e| e.tracer.strong_count() > 0 || !e.shared.gone.is_set());
    reg.insert(pid, Entry { tracer: Arc::downgrade(&t), shared: t.shared.clone() });
    Ok(t)
}

impl Tracer {
    fn spawn(pid: i32) -> Result<Tracer, RpcError> {
        let shared = Arc::new(Shared {
            dead: AtomicBool::new(false),
            gone: Gone::default(),
            subscribers: Mutex::new(Vec::new()),
            syscall_site: Mutex::new(None),
        });
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let sh = shared.clone();
        let thread = std::thread::Builder::new()
            .name(format!("tracer-{pid}"))
            .spawn(move || tracer_main(pid, rx, ready_tx, sh))
            .map_err(|e| RpcError::internal_error(format!("cannot start tracer thread: {e}")))?;
        let thread_id = thread.thread().id();
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Tracer { pid, tx, thread: Mutex::new(Some(thread)), thread_id, shared }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(RpcError::ptrace_failed(format!("tracer for pid {pid} failed to start")))
            }
        }
    }

    #[allow(dead_code)] // diagnostics and later tasks
    pub fn pid(&self) -> i32 {
        self.pid
    }

    /// Stop every thread, run `f` on the tracer thread, then resume every thread (re-injecting
    /// signals that arrived meanwhile). Fails with `ProcessNotFound` once the process is gone.
    pub fn with_stopped<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Stopped<'_>) -> R + Send + 'static,
    ) -> Result<R, RpcError> {
        if std::thread::current().id() == self.thread_id {
            return Err(RpcError::internal_error("with_stopped called from inside a tracer job"));
        }
        let (tx, rx) = mpsc::channel();
        let job: Job = Box::new(move |s| {
            let _ = tx.send(s.map(f));
        });
        if self.tx.send(Cmd::Run(job)).is_err() {
            return Err(self.gone_error());
        }
        match rx.recv() {
            Ok(r) => r,
            // The job was dropped unrun: the thread ended (process gone) or the job panicked.
            Err(_) if self.shared.dead.load(Ordering::Acquire) => Err(self.gone_error()),
            Err(_) => Err(RpcError::internal_error("tracer job failed")),
        }
    }

    /// Set (or clear, with `None`) debug-register slot `slot` (0–3) on every thread, and on every
    /// thread created later before it first runs.
    #[allow(dead_code)] // used by watchpoints (Task 9)
    pub fn set_watch_slot(&self, slot: usize, cfg: Option<DrConfig>) -> Result<(), RpcError> {
        if slot > 3 {
            return Err(RpcError::invalid_params("debug register slot must be 0..=3"));
        }
        self.with_stopped(move |s| s.apply_slot(slot, cfg))?
    }

    /// Hits on our watch slots, from now on.
    #[allow(dead_code)] // used by watchpoints (Task 9)
    pub fn subscribe_traps(&self) -> Receiver<Trap> {
        let (tx, rx) = mpsc::channel();
        self.shared.subscribers.lock().unwrap().push(tx);
        rx
    }

    pub fn syscall_site(&self) -> Option<u64> {
        *self.shared.syscall_site.lock().unwrap()
    }

    pub fn set_syscall_site(&self, addr: u64) {
        *self.shared.syscall_site.lock().unwrap() = Some(addr);
    }

    fn gone_error(&self) -> RpcError {
        RpcError::process_not_found(format!("process {} has exited", self.pid))
    }
}

impl Drop for Tracer {
    /// Clears debug registers and detaches every thread. Waits for it, so a new tracer for the
    /// same pid can attach as soon as this returns.
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Shutdown);
        if std::thread::current().id() != self.thread_id {
            if let Some(t) = self.thread.lock().unwrap().take() {
                let _ = t.join();
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Tracer thread

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Running,
    /// Its clone was reported; its first stop has not arrived yet.
    Starting,
    /// `PTRACE_EVENT_STOP` (our interrupt, or a new thread's first stop). Stopped inside signal
    /// handling, so registers can be changed and code run. Resumes with `PTRACE_CONT`.
    Interrupted,
    /// Another ptrace event (e.g. `PTRACE_EVENT_CLONE`), reported from inside a syscall: registers
    /// written now would be clobbered by the syscall's return, so no code runs on it.
    Event,
    /// Signal-delivery-stop. Resumes by delivering the signal (0 = suppressed, e.g. our own trap).
    Signal(i32),
    /// Group-stop (the game was stopped by SIGSTOP etc.). Resumes with `PTRACE_LISTEN`.
    Group,
}

impl State {
    fn stopped(self) -> bool {
        !matches!(self, State::Running | State::Starting)
    }
    /// Can we set registers and single-step this thread?
    fn can_run_code(self) -> bool {
        matches!(self, State::Interrupted | State::Signal(_))
    }
}

struct Thread {
    state: State,
    /// Signals that stopped this thread while we ran code on it; delivered again on resume.
    queued: Vec<i32>,
    /// Watch slots have not been applied yet (a new thread before its first stop).
    fresh: bool,
}

struct Core {
    pid: i32,
    threads: HashMap<i32, Thread>,
    slots: [Option<DrConfig>; 4],
    /// Some debug register was written, so detach must clear them.
    dr_used: bool,
    shared: Arc<Shared>,
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn pt(req: libc::c_uint, tid: i32, addr: u64, data: u64) -> Result<libc::c_long, i32> {
    let r = unsafe { libc::ptrace(req, tid, addr as *mut libc::c_void, data as *mut libc::c_void) };
    if r < 0 {
        Err(errno())
    } else {
        Ok(r)
    }
}

fn debugreg_offset(idx: usize) -> u64 {
    (std::mem::offset_of!(libc::user, u_debugreg) + 8 * idx) as u64
}

fn peek_debugreg(tid: i32, idx: usize) -> Result<u64, i32> {
    unsafe { *libc::__errno_location() = 0 };
    let v = unsafe { libc::ptrace(libc::PTRACE_PEEKUSER, tid, debugreg_offset(idx) as *mut libc::c_void, 0usize) };
    match errno() {
        0 => Ok(v as u64),
        e if v == -1 => Err(e),
        _ => Ok(v as u64),
    }
}

fn poke_debugreg(tid: i32, idx: usize, value: u64) -> Result<(), i32> {
    pt(libc::PTRACE_POKEUSER, tid, debugreg_offset(idx), value).map(|_| ())
}

fn get_regs(tid: i32) -> Result<libc::user_regs_struct, i32> {
    let mut r: libc::user_regs_struct = unsafe { std::mem::zeroed() };
    pt(libc::PTRACE_GETREGS, tid, 0, &mut r as *mut _ as u64)?;
    Ok(r)
}

fn set_regs(tid: i32, r: &libc::user_regs_struct) -> Result<(), i32> {
    pt(libc::PTRACE_SETREGS, tid, 0, r as *const _ as u64).map(|_| ())
}

fn ptrace_error(what: &str, tid: i32, e: i32) -> RpcError {
    if e == libc::ESRCH {
        RpcError::process_not_found(format!("{what}: thread {tid} is gone"))
    } else {
        RpcError::ptrace_failed(format!("{what} on thread {tid}: {}", io::Error::from_raw_os_error(e)))
    }
}

fn status_tracer_pid(path: &str) -> Option<i32> {
    let s = std::fs::read_to_string(path).ok()?;
    s.lines().find_map(|l| l.strip_prefix("TracerPid:")).and_then(|v| v.trim().parse().ok())
}

fn list_tids(pid: i32) -> io::Result<Vec<i32>> {
    let mut tids: Vec<i32> = std::fs::read_dir(format!("/proc/{pid}/task"))?
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse().ok())
        .collect();
    tids.sort_unstable();
    Ok(tids)
}

/// True if the thread is a zombie or gone: it will never report a stop.
fn thread_finished(pid: i32, tid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/stat")) {
        Ok(s) => matches!(s.rsplit_once(')').and_then(|(_, r)| r.trim_start().chars().next()), Some('Z' | 'X')),
        Err(_) => true,
    }
}

/// Seize every thread of `pid`, re-listing `/proc/<pid>/task` until no new thread shows up.
fn seize_all(pid: i32) -> Result<HashMap<i32, Thread>, RpcError> {
    // TracerPid names the tracing thread, and that is this one.
    let me = unsafe { libc::gettid() };
    let mut threads = HashMap::new();
    loop {
        let tids = list_tids(pid).map_err(|e| match e.raw_os_error() {
            Some(libc::ENOENT) | Some(libc::ESRCH) => RpcError::process_not_found(format!("no such process: {pid}")),
            _ => RpcError::ptrace_failed(format!("cannot list threads of {pid}: {e}")),
        })?;
        let new: Vec<i32> = tids.into_iter().filter(|t| !threads.contains_key(t)).collect();
        if new.is_empty() {
            return Ok(threads);
        }
        for tid in new {
            match pt(libc::PTRACE_SEIZE, tid, 0, libc::PTRACE_O_TRACECLONE as u64) {
                Ok(_) => {
                    threads.insert(tid, Thread { state: State::Running, queued: vec![], fresh: false });
                }
                Err(libc::ESRCH) if tid != pid => {} // exited meanwhile
                Err(libc::ESRCH) => return Err(RpcError::process_not_found(format!("no such process: {pid}"))),
                Err(libc::EPERM) => {
                    let tracer = status_tracer_pid(&format!("/proc/{pid}/task/{tid}/status")).unwrap_or(0);
                    if tracer == me {
                        // Already ours: a thread created by a seized thread (auto-attached). Its
                        // first stop is on its way.
                        threads.insert(tid, Thread { state: State::Starting, queued: vec![], fresh: true });
                    } else if tracer != 0 {
                        return Err(RpcError::ptrace_failed(
                            "another debugger is attached to this game (Cheat Engine?)",
                        ));
                    } else {
                        return Err(RpcError::ptrace_failed(format!(
                            "not permitted to trace pid {pid} (check /proc/sys/kernel/yama/ptrace_scope)"
                        )));
                    }
                }
                Err(e) => return Err(ptrace_error("PTRACE_SEIZE", tid, e)),
            }
        }
    }
}

/// Marks the tracer finished even if the thread panics.
struct Finish(Arc<Shared>);
impl Drop for Finish {
    fn drop(&mut self) {
        self.0.dead.store(true, Ordering::Release);
        self.0.gone.set();
    }
}

fn tracer_main(pid: i32, rx: Receiver<Cmd>, ready: Sender<Result<(), RpcError>>, shared: Arc<Shared>) {
    let _finish = Finish(shared.clone());
    // On error, returning ends this thread, and the kernel detaches whatever was seized.
    let threads = match seize_all(pid) {
        Ok(t) => t,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut core = Core { pid, threads, slots: [None; 4], dr_used: false, shared };
    loop {
        core.pump();
        if core.threads.is_empty() {
            return; // process gone: queued jobs are dropped and their callers see ProcessNotFound
        }
        match rx.recv_timeout(POLL) {
            Ok(Cmd::Run(job)) => core.run_job(job),
            Ok(Cmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                core.detach_all();
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

impl Core {
    /// Wait for one event of any of our tracees without blocking.
    fn wait_any(&mut self) -> Option<(i32, i32)> {
        let mut status = 0;
        let tid = unsafe { libc::waitpid(-1, &mut status, libc::__WALL | libc::__WNOTHREAD | libc::WNOHANG) };
        if tid > 0 {
            return Some((tid, status));
        }
        if tid < 0 && errno() == libc::ECHILD {
            self.threads.clear(); // nothing left to trace
        }
        None
    }

    /// Handle every pending event, resuming each thread that stopped (running mode).
    fn pump(&mut self) {
        while let Some((tid, status)) = self.wait_any() {
            self.on_event(tid, status);
            self.resume(tid);
        }
    }

    /// Record what an event means for `tid`. Never resumes.
    fn on_event(&mut self, tid: i32, status: i32) {
        if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
            self.threads.remove(&tid);
            return;
        }
        if !libc::WIFSTOPPED(status) {
            return;
        }
        let sig = libc::WSTOPSIG(status);
        let event = status >> 16;
        // A new thread's first stop can arrive before its parent's clone event.
        self.threads.entry(tid).or_insert(Thread { state: State::Starting, queued: vec![], fresh: true });
        let state = if event == libc::PTRACE_EVENT_CLONE {
            let mut msg: libc::c_ulong = 0;
            if pt(libc::PTRACE_GETEVENTMSG, tid, 0, &mut msg as *mut _ as u64).is_ok() {
                self.threads.entry(msg as i32).or_insert(Thread { state: State::Starting, queued: vec![], fresh: true });
            }
            State::Event
        } else if event == libc::PTRACE_EVENT_STOP {
            // With PTRACE_SEIZE a group-stop reports the stop signal; anything else reports SIGTRAP.
            match sig {
                libc::SIGSTOP | libc::SIGTSTP | libc::SIGTTIN | libc::SIGTTOU => State::Group,
                _ => State::Interrupted,
            }
        } else if event != 0 {
            State::Event
        } else if sig == libc::SIGTRAP && self.take_watch_trap(tid) {
            State::Signal(0) // ours: swallow it
        } else {
            State::Signal(sig)
        };
        let th = self.threads.get_mut(&tid).unwrap();
        th.state = state;
        if th.fresh {
            th.fresh = false;
            self.apply_slots_to(tid);
        }
    }

    /// If DR6 names one of our active slots, report the hit and clear DR6.
    fn take_watch_trap(&mut self, tid: i32) -> bool {
        let active: u64 = (0..4).filter(|&i| self.slots[i].is_some()).map(|i| 1u64 << i).sum();
        if active == 0 {
            return false;
        }
        let Ok(dr6) = peek_debugreg(tid, 6) else { return false };
        if dr6 & active == 0 {
            return false;
        }
        let _ = poke_debugreg(tid, 6, 0);
        if let Ok(regs) = get_regs(tid) {
            let trap = Trap { tid, regs, dr6 };
            self.shared.subscribers.lock().unwrap().retain(|s| s.send(trap).is_ok());
        }
        true
    }

    /// Resume `tid` according to how it stopped, delivering queued signals.
    fn resume(&mut self, tid: i32) {
        let Some(th) = self.threads.get_mut(&tid) else { return };
        let mut queued = std::mem::take(&mut th.queued).into_iter();
        let (req, sig) = match th.state {
            State::Running | State::Starting => return,
            State::Group => (libc::PTRACE_LISTEN, 0),
            State::Signal(s) if s != 0 => (libc::PTRACE_CONT, s),
            State::Interrupted | State::Event | State::Signal(_) => (libc::PTRACE_CONT, queued.next().unwrap_or(0)),
        };
        th.state = State::Running;
        // ESRCH: the thread is being killed; its exit event follows.
        let _ = pt(req, tid, 0, sig as u64);
        for extra in queued {
            unsafe { libc::syscall(libc::SYS_tgkill, self.pid, tid, extra) };
        }
    }

    fn resume_all(&mut self) {
        let tids: Vec<i32> = self.threads.keys().copied().collect();
        for tid in tids {
            self.resume(tid);
        }
    }

    /// Interrupt every running thread and wait until all are stopped.
    fn stop_all(&mut self) -> Result<(), RpcError> {
        for (&tid, th) in &self.threads {
            if th.state == State::Running {
                let _ = pt(libc::PTRACE_INTERRUPT, tid, 0, 0);
            }
        }
        let start = Instant::now();
        let mut checked_finished = start;
        loop {
            while let Some((tid, status)) = self.wait_any() {
                self.on_event(tid, status);
            }
            if self.threads.is_empty() {
                return Err(RpcError::process_not_found(format!("process {} has exited", self.pid)));
            }
            let waiting: Vec<i32> = self.threads.iter().filter(|(_, t)| !t.state.stopped()).map(|(&t, _)| t).collect();
            if waiting.is_empty() {
                return Ok(());
            }
            // A zombie thread (e.g. a main thread that called pthread_exit) never stops.
            if checked_finished.elapsed() >= Duration::from_millis(50) {
                checked_finished = Instant::now();
                for tid in &waiting {
                    if thread_finished(self.pid, *tid) {
                        self.threads.remove(tid);
                    }
                }
                continue;
            }
            if start.elapsed() >= STOP_TIMEOUT {
                self.resume_all();
                return Err(RpcError::ptrace_failed(format!(
                    "thread {} of pid {} did not stop within {} s",
                    waiting[0],
                    self.pid,
                    STOP_TIMEOUT.as_secs()
                )));
            }
            std::thread::sleep(Duration::from_micros(100));
        }
    }

    fn run_job(&mut self, job: Job) {
        match self.stop_all() {
            Ok(()) => {
                let mut tids: Vec<i32> = self.threads.iter().filter(|(_, t)| t.state.stopped()).map(|(&t, _)| t).collect();
                tids.sort_unstable();
                let mut s = Stopped { core: self, tids };
                // A panicking job drops its reply channel (the caller gets an error); the game
                // must still be resumed.
                let _ = catch_unwind(AssertUnwindSafe(|| job(Ok(&mut s))));
                self.resume_all();
            }
            Err(e) => job(Err(e)),
        }
    }

    fn apply_slots_to(&mut self, tid: i32) {
        if self.slots.iter().all(Option::is_none) {
            return;
        }
        let mut dr7 = 0;
        for (i, slot) in self.slots.iter().enumerate() {
            if let Some(c) = slot {
                let _ = poke_debugreg(tid, i, c.addr);
                dr7 |= c.dr7_bits(i);
            }
        }
        let _ = poke_debugreg(tid, 7, dr7);
    }

    /// Clear debug registers (if we ever set any) and detach every stopped thread. Threads that
    /// would not stop are detached by the kernel when this thread exits.
    fn detach_all(&mut self) {
        let _ = self.stop_all();
        let tids: Vec<i32> = self.threads.keys().copied().collect();
        for tid in tids {
            let th = self.threads.get_mut(&tid).unwrap();
            if !th.state.stopped() {
                continue;
            }
            if self.dr_used {
                let _ = poke_debugreg(tid, 7, 0);
                for i in 0..4 {
                    let _ = poke_debugreg(tid, i, 0);
                }
            }
            let mut queued = std::mem::take(&mut th.queued).into_iter();
            let sig = match th.state {
                State::Signal(s) if s != 0 => s,
                State::Group => 0, // stays in its group-stop, as it would untraced
                _ => queued.next().unwrap_or(0),
            };
            let _ = pt(libc::PTRACE_DETACH, tid, 0, sig as u64);
            for extra in queued {
                unsafe { libc::syscall(libc::SYS_tgkill, self.pid, tid, extra) };
            }
        }
        self.threads.clear();
    }
}

/// Every thread of the process, stopped. Only exists on the tracer thread inside `with_stopped`.
pub struct Stopped<'a> {
    core: &'a mut Core,
    tids: Vec<i32>,
}

impl Stopped<'_> {
    /// Stopped threads, ascending.
    #[allow(dead_code)] // used by patches (Task 8)
    pub fn tids(&self) -> &[i32] {
        &self.tids
    }

    fn check(&self, tid: i32) -> Result<(), RpcError> {
        if self.tids.contains(&tid) && self.core.threads.contains_key(&tid) {
            Ok(())
        } else {
            Err(RpcError::invalid_params(format!("thread {tid} is not stopped")))
        }
    }

    #[allow(dead_code)] // used by patches (Task 8)
    pub fn regs(&self, tid: i32) -> Result<libc::user_regs_struct, RpcError> {
        self.check(tid)?;
        get_regs(tid).map_err(|e| ptrace_error("PTRACE_GETREGS", tid, e))
    }

    #[allow(dead_code)] // used by later tasks
    pub fn set_regs(&mut self, tid: i32, regs: &libc::user_regs_struct) -> Result<(), RpcError> {
        self.check(tid)?;
        set_regs(tid, regs).map_err(|e| ptrace_error("PTRACE_SETREGS", tid, e))
    }

    /// Write debug register `idx` (0–3 addresses, 6 status, 7 control) of `tid`.
    #[allow(dead_code)] // used by watchpoints (Task 9)
    pub fn set_debugreg(&mut self, tid: i32, idx: usize, value: u64) -> Result<(), RpcError> {
        self.check(tid)?;
        if !matches!(idx, 0..=3 | 6 | 7) {
            return Err(RpcError::invalid_params("debug register index must be 0-3, 6 or 7"));
        }
        self.core.dr_used = true;
        poke_debugreg(tid, idx, value).map_err(|e| ptrace_error("PTRACE_POKEUSER", tid, e))
    }

    fn apply_slot(&mut self, slot: usize, cfg: Option<DrConfig>) -> Result<(), RpcError> {
        self.core.slots[slot] = cfg;
        self.core.dr_used = true;
        let dr7: u64 = self.core.slots.iter().enumerate().filter_map(|(i, c)| c.map(|c| c.dr7_bits(i))).fold(0, |a, b| a | b);
        for &tid in &self.tids.clone() {
            // The address before enabling it, and disabling before clearing the address: the
            // kernel validates each DR7 write against the address registers.
            let r = match cfg {
                Some(c) => poke_debugreg(tid, slot, c.addr).and_then(|_| poke_debugreg(tid, 7, dr7)),
                None => poke_debugreg(tid, 7, dr7).and_then(|_| poke_debugreg(tid, slot, 0)),
            };
            match r {
                Ok(()) | Err(libc::ESRCH) => {}
                Err(e) => return Err(ptrace_error("PTRACE_POKEUSER", tid, e)),
            }
        }
        Ok(())
    }

    /// Run syscall `nr` in the target (D6): on the main thread (or any thread stopped where code
    /// can run), point `rip` at the cached `syscall` instruction with `orig_rax = -1` so no
    /// syscall restart interferes, single-step it, read `rax`, then restore every register
    /// exactly, so an interrupted syscall of the game restarts as if nothing happened. Returns the
    /// raw result (`-errno` on failure).
    pub fn syscall(&mut self, nr: i64, args: [u64; 6]) -> Result<i64, RpcError> {
        let site = self
            .core
            .shared
            .syscall_site
            .lock()
            .unwrap()
            .ok_or_else(|| RpcError::internal_error("no syscall site found yet"))?;
        let pid = self.core.pid;
        let eligible = |tid: &i32| self.core.threads.get(tid).is_some_and(|t| t.state.can_run_code());
        let tid = if eligible(&pid) {
            pid
        } else {
            *self
                .tids
                .iter()
                .find(|t| eligible(t))
                .ok_or_else(|| RpcError::ptrace_failed("no thread of the game can run a syscall right now"))?
        };
        let saved = get_regs(tid).map_err(|e| ptrace_error("PTRACE_GETREGS", tid, e))?;
        let mut r = saved;
        r.rip = site;
        r.rax = nr as u64;
        r.orig_rax = u64::MAX;
        r.rdi = args[0];
        r.rsi = args[1];
        r.rdx = args[2];
        r.r10 = args[3];
        r.r8 = args[4];
        r.r9 = args[5];
        set_regs(tid, &r).map_err(|e| ptrace_error("PTRACE_SETREGS", tid, e))?;
        let result = self.step_syscall(tid, site);
        if self.core.threads.contains_key(&tid) {
            set_regs(tid, &saved).map_err(|e| ptrace_error("PTRACE_SETREGS", tid, e))?;
        }
        result
    }

    /// Single-step `tid` over the `syscall` at `site`. Signals that arrive first are queued for
    /// re-delivery on resume, and the step is retried.
    fn step_syscall(&mut self, tid: i32, site: u64) -> Result<i64, RpcError> {
        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            pt(libc::PTRACE_SINGLESTEP, tid, 0, 0).map_err(|e| ptrace_error("PTRACE_SINGLESTEP", tid, e))?;
            let status = loop {
                let mut status = 0;
                let r = unsafe { libc::waitpid(tid, &mut status, libc::__WALL | libc::WNOHANG) };
                if r == tid {
                    break status;
                }
                if r < 0 || Instant::now() >= deadline {
                    // Leave it to the kernel: it is detached when this thread exits.
                    return Err(RpcError::ptrace_failed(format!("thread {tid} did not finish the remote syscall")));
                }
                std::thread::sleep(Duration::from_micros(50));
            };
            if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                self.core.threads.remove(&tid);
                return Err(RpcError::process_not_found(format!("process {} has exited", self.core.pid)));
            }
            if !libc::WIFSTOPPED(status) {
                continue;
            }
            let (sig, event) = (libc::WSTOPSIG(status), status >> 16);
            if event == 0 && sig == libc::SIGTRAP {
                let regs = get_regs(tid).map_err(|e| ptrace_error("PTRACE_GETREGS", tid, e))?;
                if regs.rip == site + 2 {
                    return Ok(regs.rax as i64);
                }
            } else if event == 0 {
                // A signal arrived before the syscall ran: deliver it later, step again.
                self.core.threads.get_mut(&tid).unwrap().queued.push(sig);
            }
            // Otherwise (a pending interrupt stop, a trap before the step): step again.
            if Instant::now() >= deadline {
                return Err(RpcError::ptrace_failed(format!("thread {tid} did not finish the remote syscall")));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    #[test]
    fn dr7_bits_follow_the_intel_layout() {
        let w4 = DrConfig { addr: 0, len: 4, rw: DrRw::Write };
        assert_eq!(w4.dr7_bits(0), 0b1 | (0b01 << 16) | (0b11 << 18));
        let a8 = DrConfig { addr: 0, len: 8, rw: DrRw::Access };
        assert_eq!(a8.dr7_bits(3), (1 << 6) | (0b11 << 28) | (0b10 << 30));
        let w1 = DrConfig { addr: 0, len: 1, rw: DrRw::Write };
        assert_eq!(w1.dr7_bits(1), (1 << 2) | (0b01 << 20));
        let w2 = DrConfig { addr: 0, len: 2, rw: DrRw::Write };
        assert_eq!(w2.dr7_bits(2), (1 << 4) | (0b01 << 24) | (0b01 << 26));
    }

    /// The C test target, launched by this test (never any other process).
    struct TestTarget {
        child: Child,
        addrs: HashMap<String, u64>,
    }

    impl TestTarget {
        fn spawn(args: &[&str]) -> TestTarget {
            let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine/test-target/build/target");
            assert!(exe.exists(), "build it with `make -C packages/engine/test-target`");
            let mut child = Command::new(exe).args(args).stdout(Stdio::piped()).spawn().unwrap();
            let mut out = BufReader::new(child.stdout.take().unwrap());
            let mut addrs = HashMap::new();
            let mut line = String::new();
            while out.read_line(&mut line).unwrap() > 0 {
                if let Some((k, v)) = line.trim().strip_prefix("addr ").and_then(|r| r.split_once('=')) {
                    addrs.insert(k.to_string(), u64::from_str_radix(v.trim_start_matches("0x"), 16).unwrap());
                }
                if line.starts_with("offset hp_in_stats") {
                    break;
                }
                line.clear();
            }
            std::thread::spawn(move || std::io::copy(&mut out, &mut std::io::sink()));
            TestTarget { child, addrs }
        }
        fn pid(&self) -> i32 {
            self.child.id() as i32
        }
    }

    impl Drop for TestTarget {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn tracer_pid_of(pid: i32) -> i32 {
        status_tracer_pid(&format!("/proc/{pid}/status")).unwrap()
    }

    #[test]
    fn with_stopped_sees_every_thread_and_drop_detaches() {
        let t = TestTarget::spawn(&["--writer", "--spin"]);
        let tr = for_pid(t.pid()).unwrap();
        assert_ne!(tracer_pid_of(t.pid()), 0, "for_pid must attach");
        let tids = tr.with_stopped(|s| s.tids().to_vec()).unwrap();
        assert_eq!(tids, list_tids(t.pid()).unwrap(), "main, writer and spin threads");
        assert_eq!(tids.len(), 3);
        // While stopped, the spin thread's rip does not move.
        let pid = t.pid();
        let (a, b) = tr
            .with_stopped(move |s| {
                let spin = *s.tids().last().unwrap();
                let a = s.regs(spin).unwrap().rip;
                std::thread::sleep(Duration::from_millis(20));
                (a, s.regs(spin).unwrap().rip)
            })
            .unwrap();
        assert_eq!(a, b);
        // Same pid, same tracer.
        let again = for_pid(pid).unwrap();
        assert!(Arc::ptr_eq(&tr, &again));
        drop(again);
        drop(tr);
        assert_eq!(tracer_pid_of(pid), 0, "dropping the last Arc must detach");
    }

    #[test]
    fn tracers_of_two_processes_run_side_by_side() {
        let (a, b) = (TestTarget::spawn(&["--spin"]), TestTarget::spawn(&["--spin"]));
        let (ta, tb) = (for_pid(a.pid()).unwrap(), for_pid(b.pid()).unwrap());
        for _ in 0..20 {
            assert!(ta.with_stopped(|s| s.tids().to_vec()).unwrap().contains(&a.pid()));
            assert!(tb.with_stopped(|s| s.tids().to_vec()).unwrap().contains(&b.pid()));
        }
        drop((ta, tb));
        assert_eq!(tracer_pid_of(a.pid()), 0);
        assert_eq!(tracer_pid_of(b.pid()), 0);
    }

    #[test]
    fn write_watch_slot_traps_until_cleared() {
        let t = TestTarget::spawn(&["--writer"]);
        let tr = for_pid(t.pid()).unwrap();
        let traps = tr.subscribe_traps();
        let counter = t.addrs["g_counter"];
        tr.set_watch_slot(1, Some(DrConfig { addr: counter, len: 4, rw: DrRw::Write })).unwrap();
        let trap = traps.recv_timeout(Duration::from_secs(1)).expect("no trap within 1 s");
        assert_ne!(trap.dr6 & 0b10, 0, "DR6 names slot 1: {:#x}", trap.dr6);
        // The trap fires after the store, inside bump_counter.
        let bump = t.addrs["bump_counter"];
        assert!(trap.regs.rip > bump && trap.regs.rip < bump + 64, "rip {:#x}", trap.regs.rip);
        tr.set_watch_slot(1, None).unwrap();
        while traps.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_millis(150));
        assert!(traps.try_recv().is_err(), "trap after the slot was cleared");
        let pid = t.pid();
        drop(tr);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "target died after detach (stray SIGTRAP?)");
    }

    #[test]
    fn process_exit_fails_pending_and_later_jobs() {
        let mut t = TestTarget::spawn(&["--spin"]);
        let tr = for_pid(t.pid()).unwrap();
        tr.with_stopped(|_| ()).unwrap();
        let _ = t.child.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        let e = loop {
            match tr.with_stopped(|_| ()) {
                Err(e) => break e,
                Ok(()) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                Ok(()) => panic!("with_stopped kept succeeding after the target was killed"),
            }
        };
        assert_eq!(e.code, -32002, "{e:?}");
    }
}
