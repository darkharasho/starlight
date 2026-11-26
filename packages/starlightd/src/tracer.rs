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
use std::sync::{Arc, Condvar, LazyLock, Mutex, OnceLock, Weak};
use std::thread::{JoinHandle, ThreadId};
use std::time::{Duration, Instant};

/// How long a stop-the-world (or a single-step) may take before the job fails.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
/// Idle poll interval of the event loop: the longest a game signal or new thread waits for us.
const POLL: Duration = Duration::from_millis(1);

/// Set when the daemon is about to exit (`detach_everything`): every tracer detaches at once, giving
/// up on threads it would otherwise wait for at this instant.
static URGENT: OnceLock<Instant> = OnceLock::new();

/// Hardware watchpoint condition (DR7 R/W bits).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrRw {
    Write,
    Access,
}

/// One debug-register slot: break when `len` bytes at `addr` are written or accessed.
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
#[derive(Clone, Copy)]
pub struct Trap {
    #[allow(dead_code)] // diagnostics
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

/// How a remote syscall is made: which instruction, which registers, which numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyscallAbi {
    /// `syscall` from 64-bit code (cs 0x33).
    X64,
    /// `int 0x80` from 32-bit code (cs 0x23).
    I386,
}

impl SyscallAbi {
    pub fn for_bits(process_bits: crate::arch::Bits) -> SyscallAbi {
        match process_bits {
            crate::arch::Bits::B32 => SyscallAbi::I386,
            crate::arch::Bits::B64 => SyscallAbi::X64,
        }
    }

    /// True if a thread whose code segment is `cs` can run this ABI's instruction.
    pub fn fits(self, cs: u64) -> bool {
        match self {
            SyscallAbi::X64 => cs == 0x33,
            SyscallAbi::I386 => cs == 0x23,
        }
    }

    pub fn site_bytes(self) -> [u8; 2] {
        match self {
            SyscallAbi::X64 => [0x0f, 0x05],
            SyscallAbi::I386 => [0xcd, 0x80],
        }
    }

    pub fn nr_mmap(self) -> i64 {
        match self {
            SyscallAbi::X64 => libc::SYS_mmap,
            SyscallAbi::I386 => 192, // mmap2: offset in pages
        }
    }

    pub fn nr_munmap(self) -> i64 {
        match self {
            SyscallAbi::X64 => libc::SYS_munmap,
            SyscallAbi::I386 => 91,
        }
    }

    /// The syscall's result from the thread's `rax` after the call.
    pub fn result(self, rax: u64) -> i64 {
        match self {
            SyscallAbi::X64 => rax as i64,
            SyscallAbi::I386 => rax as u32 as i32 as i64,
        }
    }

    /// Point `r` at `site` with syscall `nr` and `args` in this ABI's registers.
    fn load(self, r: &mut libc::user_regs_struct, site: u64, nr: i64, args: [u64; 6]) {
        r.rip = site;
        r.orig_rax = u64::MAX;
        match self {
            SyscallAbi::X64 => {
                r.rax = nr as u64;
                r.rdi = args[0];
                r.rsi = args[1];
                r.rdx = args[2];
                r.r10 = args[3];
                r.r8 = args[4];
                r.r9 = args[5];
            }
            SyscallAbi::I386 => {
                let lo = |v: u64| v & 0xFFFF_FFFF;
                r.rax = lo(nr as u64);
                r.rbx = lo(args[0]);
                r.rcx = lo(args[1]);
                r.rdx = lo(args[2]);
                r.rsi = lo(args[3]);
                r.rdi = lo(args[4]);
                r.rbp = lo(args[5]);
            }
        }
    }
}

/// The first thread of `cs_by_tid` (in preference order) whose code segment can run `abi`.
pub fn pick_thread(cs_by_tid: &[(i32, u64)], abi: SyscallAbi) -> Option<i32> {
    cs_by_tid.iter().find(|&&(_, cs)| abi.fits(cs)).map(|&(tid, _)| tid)
}

/// State shared between the `Tracer` handle and its thread.
struct Shared {
    dead: AtomicBool,
    gone: Gone,
    subscribers: Mutex<Vec<Sender<Trap>>>,
    syscall_site: Mutex<Option<(u64, SyscallAbi)>>,
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
    if URGENT.get().is_some() {
        return Err(RpcError::ptrace_failed("starlightd is shutting down"));
    }
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

/// The daemon's last step before it exits: make every tracer clear its debug registers and
/// detach every thread now, even if its `Arc` is still held (a teardown that ran out of time).
/// A thread with a SIGTRAP of ours still queued is waited for until `budget` minus a second, so
/// it is not detached with it. Returns when every tracer is done, or after `budget`.
pub fn detach_everything(budget: Duration) {
    let start = Instant::now();
    let _ = URGENT.set(start + budget.saturating_sub(Duration::from_secs(1)));
    // `for_pid` can hold the registry while it waits for a tracer to finish: don't block on it.
    let shared: Vec<Arc<Shared>> = loop {
        if let Ok(reg) = REGISTRY.try_lock() {
            break reg.values().map(|e| e.shared.clone()).collect();
        }
        if start.elapsed() >= budget {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    for sh in shared {
        sh.gone.wait(budget.saturating_sub(start.elapsed()));
    }
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
    pub fn set_watch_slot(&self, slot: usize, cfg: Option<DrConfig>) -> Result<(), RpcError> {
        if slot > 3 {
            return Err(RpcError::invalid_params("debug register slot must be 0..=3"));
        }
        self.with_stopped(move |s| s.apply_slot(slot, cfg))?
    }

    /// Hits on our watch slots, from now on.
    pub fn subscribe_traps(&self) -> Receiver<Trap> {
        let (tx, rx) = mpsc::channel();
        self.shared.subscribers.lock().unwrap().push(tx);
        rx
    }

    /// The cached call site and its ABI.
    pub fn call_site(&self) -> Option<(u64, SyscallAbi)> {
        *self.shared.syscall_site.lock().unwrap()
    }

    pub fn set_call_site(&self, addr: u64, abi: SyscallAbi) {
        *self.shared.syscall_site.lock().unwrap() = Some((addr, abi));
    }

    #[cfg(test)]
    pub fn set_syscall_site(&self, addr: u64) {
        self.set_call_site(addr, SyscallAbi::X64);
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

/// A signal to deliver later, with the siginfo it arrived with, so the game sees it unchanged
/// (`si_addr` of a SIGSEGV, which Wine's write-watch and guard pages rely on; `si_value`).
#[derive(Clone, Copy)]
struct Sig {
    sig: i32,
    info: Option<libc::siginfo_t>,
}

/// A remote syscall we stopped waiting for: the thread still runs with our registers. Its next
/// stop puts `regs` back (D6) before anything else happens to it.
#[derive(Clone, Copy)]
struct Restore {
    regs: libc::user_regs_struct,
    site: u64,
    /// The state it was stopped in before we ran code on it.
    prior: State,
}

struct Thread {
    state: State,
    /// Siginfo of a `Signal(s)` stop with `s != 0`.
    info: Option<libc::siginfo_t>,
    /// Signals that stopped this thread while we ran code on it; delivered again on resume.
    queued: Vec<Sig>,
    /// The current stop is a signal-delivery-stop, the only stop `PTRACE_CONT` can deliver a
    /// signal from.
    in_signal_stop: bool,
    /// A group-stop arrived while we ran code on it: put it back into the group-stop on resume.
    regroup: bool,
    restore: Option<Restore>,
    /// Our syscall finished but its single-step SIGTRAP is still queued (another stop was
    /// reported first): swallow it when it comes, never deliver or detach with it pending.
    step_trap_pending: bool,
    /// Resumed at detach so a SIGTRAP of ours still queued for it (a watch hit, or our step's
    /// late trap) is reported and swallowed first. Until it stops it is not interrupted: it stops
    /// by itself as soon as it runs, and an interrupt would only be reported ahead of the trap.
    awaiting_trap: bool,
    /// Slots (bit n = DRn) whose queued hit predates the slot's last clear or re-arm: that hit
    /// belongs to the previous watch on the slot, so it is swallowed but never reported.
    stale: u64,
    /// Watch slots have not been applied yet (a new thread before its first stop).
    fresh: bool,
}

impl Thread {
    fn new(state: State, fresh: bool) -> Thread {
        Thread {
            state,
            info: None,
            queued: vec![],
            in_signal_stop: false,
            regroup: false,
            restore: None,
            step_trap_pending: false,
            awaiting_trap: false,
            stale: 0,
            fresh,
        }
    }
}

struct Core {
    pid: i32,
    threads: HashMap<i32, Thread>,
    slots: [Option<DrConfig>; 4],
    /// Some debug register was written, so detach must clear them.
    dr_used: bool,
    /// Slots (bit n = DRn) ever armed by this tracer. A hit's SIGTRAP can still be queued when
    /// its slot is cleared; DR6 naming any of these marks it as ours, so it is swallowed rather
    /// than delivered (which would kill the game).
    armed: u64,
    /// How long a remote syscall's single-step may take (tests shorten it).
    step_timeout: Duration,
    /// How long one detach round waits for queued traps without interrupting (tests shorten it).
    detach_grace: Duration,
    /// Tests: skip this many resumes of threads with a queued trap at detach, as if those threads
    /// were not scheduled in time. Always 0 otherwise.
    detach_stalls: u32,
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

fn get_siginfo(tid: i32) -> Option<libc::siginfo_t> {
    let mut si: libc::siginfo_t = unsafe { std::mem::zeroed() };
    pt(libc::PTRACE_GETSIGINFO, tid, 0, &mut si as *mut _ as u64).ok()?;
    Some(si)
}

fn is_stop_signal(sig: i32) -> bool {
    matches!(sig, libc::SIGSTOP | libc::SIGTSTP | libc::SIGTTIN | libc::SIGTTOU)
}

fn tgkill(pid: i32, tid: i32, sig: i32) {
    unsafe { libc::syscall(libc::SYS_tgkill, pid, tid, sig) };
}

fn ptrace_error(what: &str, tid: i32, e: i32) -> RpcError {
    if e == libc::ESRCH {
        RpcError::process_not_found(format!("{what}: thread {tid} is gone"))
    } else {
        RpcError::ptrace_failed(format!("{what} on thread {tid}: {}", io::Error::from_raw_os_error(e)))
    }
}

/// True if signal `sig` is pending and not blocked, per the text of a
/// `/proc/<pid>/task/<tid>/status`. The masks are hex with bit `sig - 1` set for signal `sig`
/// (SIGTRAP, 5, is `0x10`). `SigPnd` is the thread's own queue, `ShdPnd` the process's.
fn sig_pending_in(status: &str, sig: i32) -> bool {
    let mask = |key: &str| {
        status.lines().find_map(|l| l.strip_prefix(key)).and_then(|v| u64::from_str_radix(v.trim(), 16).ok()).unwrap_or(0)
    };
    let bit = 1u64 << (sig - 1);
    ((mask("SigPnd:") | mask("ShdPnd:")) & !mask("SigBlk:") & bit) != 0
}

/// True if a SIGTRAP is queued for `tid` (not yet taken: a thread stopped delivering one no
/// longer has it queued). A gone thread has nothing queued.
fn sigtrap_queued(pid: i32, tid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/status")).is_ok_and(|s| sig_pending_in(&s, libc::SIGTRAP))
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
                    threads.insert(tid, Thread::new(State::Running, false));
                }
                Err(libc::ESRCH) if tid != pid => {} // exited meanwhile
                Err(libc::ESRCH) => return Err(RpcError::process_not_found(format!("no such process: {pid}"))),
                Err(libc::EPERM) => {
                    let tracer = status_tracer_pid(&format!("/proc/{pid}/task/{tid}/status")).unwrap_or(0);
                    if tracer == me {
                        // Already ours: a thread created by a seized thread (auto-attached). Its
                        // first stop is on its way.
                        threads.insert(tid, Thread::new(State::Starting, true));
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
    // On error, returning ends this thread, and the kernel detaches whatever was seized (all
    // still running, nothing changed yet).
    let threads = match seize_all(pid) {
        Ok(t) => t,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut core = Core {
        pid,
        threads,
        slots: [None; 4],
        dr_used: false,
        armed: 0,
        step_timeout: STOP_TIMEOUT,
        detach_grace: DETACH_GRACE,
        detach_stalls: 0,
        shared,
    };
    loop {
        core.pump();
        if core.threads.is_empty() {
            return; // process gone: queued jobs are dropped and their callers see ProcessNotFound
        }
        if URGENT.get().is_some() {
            // The daemon is exiting: detach now, whoever still holds this tracer.
            core.detach_all();
            return;
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

/// What a stop means for a thread we are running a syscall on.
enum StepStop {
    /// The single-step finished the `syscall`; `rax` is its result.
    Done(u64),
    /// Something else came first (recorded); step again.
    Again,
}

/// How a remote syscall's single-step ended.
enum Step {
    Done(u64),
    /// Stopped and still ours: the caller restores the registers.
    Failed(RpcError),
    /// Still running our code: the registers are restored at its next stop (`Thread::restore`).
    Abandoned(RpcError),
}

/// `si_code` of a SIGTRAP raised by a hardware breakpoint (no single-step involved).
const TRAP_HWBKPT: i32 = 4;
/// DR6 BS: the trap (also) came from a single-step.
const DR6_BS: u64 = 1 << 14;

/// The DR6 hit bits of a trap that belong to the slots' current watches: active slots, minus
/// hits that were already queued when their slot was last cleared or re-armed.
fn reportable(dr6: u64, active: u64, stale: u64) -> u64 {
    dr6 & active & !stale & 0xf
}

/// Stay attached at most this long at detach waiting for threads that must be cleaned up
/// (debug registers armed, a trap of ours queued, or registers still to restore) before the
/// kernel lets them go. The daemon's exit cuts it short (`URGENT`, see `cleanup`).
const DETACH_PATIENCE: Duration = Duration::from_secs(30);
/// One detach round's wait for queued traps before threads are checked again.
const DETACH_GRACE: Duration = Duration::from_millis(200);

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
            self.release(tid, false);
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
        if self.threads.get(&tid).is_some_and(|t| t.restore.is_some()) {
            self.finish_restore(tid, status);
            return;
        }
        let sig = libc::WSTOPSIG(status);
        let event = status >> 16;
        // A new thread's first stop can arrive before its parent's clone event.
        self.threads.entry(tid).or_insert(Thread::new(State::Starting, true));
        let state = if event == libc::PTRACE_EVENT_CLONE {
            let mut msg: libc::c_ulong = 0;
            if pt(libc::PTRACE_GETEVENTMSG, tid, 0, &mut msg as *mut _ as u64).is_ok() {
                self.threads.entry(msg as i32).or_insert(Thread::new(State::Starting, true));
            }
            State::Event
        } else if event == libc::PTRACE_EVENT_STOP {
            // With PTRACE_SEIZE a group-stop reports the stop signal; anything else reports SIGTRAP.
            if is_stop_signal(sig) {
                State::Group
            } else {
                State::Interrupted
            }
        } else if event != 0 {
            State::Event
        } else if sig == libc::SIGTRAP && std::mem::take(&mut self.threads.get_mut(&tid).unwrap().step_trap_pending) {
            State::Signal(0) // the late trap of our single-step: swallow it
        } else if sig == libc::SIGTRAP && self.take_watch_trap(tid) {
            State::Signal(0) // ours: swallow it
        } else {
            State::Signal(sig)
        };
        let info = match state {
            State::Signal(s) if s != 0 => get_siginfo(tid),
            _ => None,
        };
        let th = self.threads.get_mut(&tid).unwrap();
        th.state = state;
        th.info = info;
        th.awaiting_trap = false;
        th.in_signal_stop = event == 0;
        if th.fresh {
            th.fresh = false;
            self.apply_slots_to(tid);
        }
    }

    /// Record a stop of a thread running our syscall. It is done once `rip` is past the
    /// `syscall`, whatever stop reports it: a leftover interrupt can be reported before the
    /// step's SIGTRAP, which then stays queued and is swallowed when it comes. Signals and
    /// group-stops that come along are kept for resume (signals with their siginfo).
    fn note_step_stop(&mut self, tid: i32, status: i32, site: u64) -> StepStop {
        let (sig, event) = (libc::WSTOPSIG(status), status >> 16);
        let done = get_regs(tid).ok().filter(|r| r.rip == site + 2).map(|r| r.rax);
        let info = if event == 0 { get_siginfo(tid) } else { None };
        let step_trap = event == 0 && sig == libc::SIGTRAP && done.is_some();
        let Some(th) = self.threads.get_mut(&tid) else { return StepStop::Again };
        th.in_signal_stop = event == 0;
        if event == 0 && sig == libc::SIGTRAP && !step_trap && std::mem::take(&mut th.step_trap_pending) {
            // The late trap of an earlier remote syscall on this thread: swallow it.
            return StepStop::Again;
        }
        if event == 0 && sig == libc::SIGTRAP && !step_trap && self.take_watch_trap(tid) {
            // A watch hit queued before the step: ours, not the game's.
            return StepStop::Again;
        }
        let th = self.threads.get_mut(&tid).unwrap();
        if !step_trap {
            if event == 0 {
                // A signal of the game (a real SIGTRAP included).
                th.queued.push(Sig { sig, info });
            } else if event == libc::PTRACE_EVENT_STOP && is_stop_signal(sig) {
                th.regroup = true;
            }
        }
        match done {
            Some(rax) => {
                th.step_trap_pending |= !step_trap;
                StepStop::Done(rax)
            }
            None => StepStop::Again,
        }
    }

    /// The thread whose remote syscall we abandoned has stopped: put its registers back, and
    /// swallow the step's own SIGTRAP.
    fn finish_restore(&mut self, tid: i32, status: i32) {
        let Some(rs) = self.threads.get_mut(&tid).and_then(|t| t.restore.take()) else { return };
        let _ = self.note_step_stop(tid, status, rs.site);
        let _ = set_regs(tid, &rs.regs);
        if let Some(th) = self.threads.get_mut(&tid) {
            th.state = rs.prior;
        }
    }

    /// True if a SIGTRAP of ours is still queued for `tid`: a SIGTRAP is pending (`SigPnd`,
    /// `ShdPnd`), and it is either our single-step's late trap or DR6 names a slot we armed (a hit
    /// not taken yet: `take_watch_trap` clears those bits). DR6 alone is not enough: it goes
    /// stale (the step-trap swallow path leaves it), and a stale bit with nothing queued would
    /// have detach wait for a trap that never comes.
    fn our_trap_queued(&self, tid: i32) -> bool {
        let Some(th) = self.threads.get(&tid) else { return false };
        let ours = th.step_trap_pending || (self.armed != 0 && peek_debugreg(tid, 6).is_ok_and(|dr6| dr6 & self.armed != 0));
        ours && sigtrap_queued(self.pid, tid)
    }

    /// If this SIGTRAP is a hit on a slot we armed (DR6 names it, `si_code == TRAP_HWBKPT`), it
    /// is ours: clear DR6, report the hit if its slot is active and the hit is not stale, and
    /// return true so it is swallowed. A trap that also carries a single-step (`TRAP_TRACE`, DR6
    /// BS) is the game's own step: our hit is still reported, but the trap goes to the game.
    fn take_watch_trap(&mut self, tid: i32) -> bool {
        if self.armed == 0 {
            return false;
        }
        let Ok(dr6) = peek_debugreg(tid, 6) else { return false };
        if dr6 & self.armed == 0 {
            return false;
        }
        let si_code = get_siginfo(tid).map(|si| si.si_code);
        let ours = si_code == Some(TRAP_HWBKPT) && dr6 & DR6_BS == 0;
        // Our bits are consumed either way; the game's own DR6 bits (BS) are left alone.
        let _ = poke_debugreg(tid, 6, dr6 & !self.armed);
        let active: u64 = (0..4).filter(|&i| self.slots[i].is_some()).map(|i| 1u64 << i).sum();
        let stale = self.threads.get_mut(&tid).map_or(0, |t| std::mem::take(&mut t.stale));
        if reportable(dr6, active, stale) != 0 {
            if let Ok(regs) = get_regs(tid) {
                let trap = Trap { tid, regs, dr6 };
                self.shared.subscribers.lock().unwrap().retain(|s| s.send(trap).is_ok());
            }
        }
        ours
    }

    /// Let a stopped thread go: resume it (`PTRACE_CONT`, or `PTRACE_LISTEN` for a group-stop),
    /// or detach from it. Its pending signal goes out with its original siginfo when the stop
    /// can carry one; any further ones are re-sent with tgkill.
    fn release(&mut self, tid: i32, detach: bool) {
        let pid = self.pid;
        let Some(th) = self.threads.get_mut(&tid) else { return };
        if !th.state.stopped() {
            return;
        }
        let mut sigs = Vec::new();
        if let State::Signal(s) = th.state {
            if s != 0 {
                sigs.push(Sig { sig: s, info: th.info.take() });
            }
        }
        sigs.extend(th.queued.drain(..));
        let group = th.state == State::Group;
        let regroup = std::mem::take(&mut th.regroup) && !detach;
        let in_signal_stop = th.in_signal_stop;
        th.state = State::Running;
        th.info = None;
        let mut rest = sigs.into_iter();
        // Only a signal-delivery-stop delivers the signal passed to CONT/DETACH, and it keeps
        // the siginfo set here as long as the signal numbers match.
        let first = if in_signal_stop && !group { rest.next() } else { None };
        if let Some(Sig { info: Some(info), .. }) = &first {
            let _ = pt(libc::PTRACE_SETSIGINFO, tid, 0, info as *const _ as u64);
        }
        let data = first.map_or(0, |s| s.sig) as u64;
        let req = if detach {
            libc::PTRACE_DETACH // a group-stopped thread stays stopped, as it would untraced
        } else if group {
            libc::PTRACE_LISTEN
        } else {
            libc::PTRACE_CONT
        };
        // ESRCH: the thread is being killed; its exit event follows.
        let _ = pt(req, tid, 0, if group { 0 } else { data });
        if regroup {
            // Its next stop reports the group-stop again, which `on_event` turns into LISTEN.
            let _ = pt(libc::PTRACE_INTERRUPT, tid, 0, 0);
        }
        for s in rest {
            tgkill(pid, tid, s.sig);
        }
    }

    fn resume_all(&mut self) {
        let tids: Vec<i32> = self.threads.keys().copied().collect();
        for tid in tids {
            self.release(tid, false);
        }
    }

    /// Interrupt every running thread and wait until all are stopped. On timeout, the stopped
    /// threads are resumed if `resume_on_timeout`, else left stopped for the caller.
    fn stop_all(&mut self, resume_on_timeout: bool) -> Result<(), RpcError> {
        self.stop_threads(resume_on_timeout, false)
    }

    /// `stop_all`, except that with `spare_awaiting` threads resumed to take a queued trap
    /// (`awaiting_trap`) are neither interrupted nor waited for.
    fn stop_threads(&mut self, resume_on_timeout: bool, spare_awaiting: bool) -> Result<(), RpcError> {
        let spared = |t: &Thread| spare_awaiting && t.awaiting_trap;
        for (&tid, th) in &self.threads {
            if th.state == State::Running && !spared(th) {
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
            let waiting: Vec<i32> =
                self.threads.iter().filter(|(_, t)| !t.state.stopped() && !spared(t)).map(|(&t, _)| t).collect();
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
                if resume_on_timeout {
                    self.resume_all();
                }
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
        match self.stop_all(true) {
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

    /// Clear debug registers (if we ever set any) and detach every thread. A thread with a
    /// SIGTRAP of ours still queued (a watch hit, or our single-step's late trap) is resumed until
    /// that trap is reported and swallowed, as many times as it takes: detached with it queued,
    /// the game would get it (and die). A thread still running our syscall's registers is
    /// waited for too. Both up to `DETACH_PATIENCE`, or the daemon's exit (`URGENT`). Every
    /// thread that is stopped when this returns has been detached, with no signal of ours: left
    /// to the kernel's implicit detach, a stop that swallowed our trap would deliver it after
    /// all. Only a thread that never stops is left to the kernel.
    fn detach_all(&mut self) {
        let patience = Instant::now() + DETACH_PATIENCE;
        loop {
            let deadline = URGENT.get().map_or(patience, |&u| patience.min(u));
            let past = Instant::now() >= deadline;
            // Threads resumed to take a queued trap stop by themselves; an interrupt would be
            // reported ahead of the trap. Past the deadline, every thread is stopped to detach it.
            let _ = self.stop_threads(false, !past);
            let past = past || Instant::now() >= deadline;
            let stopped: Vec<i32> = self.threads.iter().filter(|(_, t)| t.state.stopped()).map(|(&t, _)| t).collect();
            for tid in stopped {
                if self.dr_used {
                    let _ = poke_debugreg(tid, 7, 0);
                    for i in 0..4 {
                        let _ = poke_debugreg(tid, i, 0);
                    }
                }
                // A group-stopped thread would not run to report it: detach it as it is.
                if !past && self.threads[&tid].state != State::Group && self.our_trap_queued(tid) {
                    // Disarmed now, so no further hit comes: let the queued trap arrive.
                    if self.detach_stalls > 0 {
                        self.detach_stalls -= 1; // tests: it stays stopped, as if never scheduled
                    } else {
                        self.release(tid, false);
                    }
                    if let Some(th) = self.threads.get_mut(&tid) {
                        th.awaiting_trap = true;
                    }
                    continue;
                }
                // Detached with signal 0 if the stop is our own (swallowed) trap.
                self.release(tid, true);
                self.threads.remove(&tid);
            }
            if self.threads.is_empty() || past {
                return;
            }
            // A thread waiting for its trap whose SIGTRAP is gone (another thread took a shared
            // one) would never stop: interrupt it next round instead.
            let pid = self.pid;
            for (&tid, th) in self.threads.iter_mut() {
                if th.awaiting_trap && th.state == State::Running && !sigtrap_queued(pid, tid) {
                    th.awaiting_trap = false;
                }
            }
            let unsafe_left = self.dr_used
                || self.threads.values().any(|t| t.restore.is_some() || t.step_trap_pending || t.awaiting_trap);
            if !unsafe_left {
                return; // what is left never stopped, and nothing of ours is pending on it
            }
            let grace = (Instant::now() + self.detach_grace).min(deadline);
            while Instant::now() < grace && self.threads.values().any(|t| t.awaiting_trap && t.state == State::Running) {
                match self.wait_any() {
                    Some((tid, status)) => self.on_event(tid, status),
                    None => std::thread::sleep(Duration::from_micros(100)),
                }
            }
        }
    }

    /// Mark `tid` as still running our syscall; its next stop restores `regs`.
    fn abandon(&mut self, tid: i32, regs: libc::user_regs_struct, site: u64, prior: State) {
        if let Some(th) = self.threads.get_mut(&tid) {
            th.restore = Some(Restore { regs, site, prior });
            th.state = State::Running;
        }
    }
}

/// Every thread of the process, stopped. Only exists on the tracer thread inside `with_stopped`.
pub struct Stopped<'a> {
    core: &'a mut Core,
    tids: Vec<i32>,
}

impl Stopped<'_> {
    /// Stopped threads, ascending.
    pub fn tids(&self) -> &[i32] {
        &self.tids
    }

    fn check(&self, tid: i32) -> Result<(), RpcError> {
        if self.tids.contains(&tid) && self.core.threads.get(&tid).is_some_and(|t| t.state.stopped()) {
            Ok(())
        } else {
            Err(RpcError::invalid_params(format!("thread {tid} is not stopped")))
        }
    }

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
    #[allow(dead_code)] // watches use set_watch_slot; kept for raw debug-register access
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
        if cfg.is_some() {
            self.core.armed |= 1 << slot;
        }
        let dr7: u64 = self.core.slots.iter().enumerate().filter_map(|(i, c)| c.map(|c| c.dr7_bits(i))).fold(0, |a, b| a | b);
        for &tid in &self.tids.clone() {
            // A hit on this slot already queued (an interrupt is reported before a pending
            // signal) belongs to the slot's previous watch, not to the one set now.
            if peek_debugreg(tid, 6).is_ok_and(|dr6| dr6 & (1 << slot) != 0) {
                if let Some(th) = self.core.threads.get_mut(&tid) {
                    th.stale |= 1 << slot;
                }
            }
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

    /// The thread to run a syscall on: one stopped by our interrupt (main thread first), so no
    /// signal has to be carried across it; a signal-stopped thread only if there is no other.
    /// Only threads whose code segment can run `abi`'s instruction qualify (in WoW64 a thread in
    /// 32-bit game code can't run `syscall`); if none can, nothing is touched.
    fn syscall_thread(&self, abi: SyscallAbi) -> Result<i32, RpcError> {
        let state = |tid: &i32| self.core.threads.get(tid).map(|t| t.state);
        let pid = self.core.pid;
        let mut order = vec![pid];
        order.extend(self.tids.iter().copied().filter(|&t| t != pid));
        let interrupted = order.iter().filter(|t| state(t) == Some(State::Interrupted));
        let others = order.iter().filter(|t| state(t).is_some_and(State::can_run_code) && state(t) != Some(State::Interrupted));
        let mut cs_by_tid = vec![];
        for &tid in interrupted.chain(others) {
            if let Ok(r) = get_regs(tid) {
                cs_by_tid.push((tid, r.cs));
            }
        }
        if cs_by_tid.is_empty() {
            return Err(RpcError::ptrace_failed("no thread of the game can run a syscall right now"));
        }
        pick_thread(&cs_by_tid, abi).ok_or_else(|| RpcError::ptrace_failed("no thread is running code that can make this call"))
    }

    /// Run syscall `nr` in the target (D6): on a thread stopped where code can run, point `rip`
    /// at the cached `syscall` instruction with `orig_rax = -1` so no syscall restart
    /// interferes, single-step it, read `rax`, then restore every register exactly, so an
    /// interrupted syscall of the game restarts as if nothing happened. Returns the raw result
    /// (`-errno` on failure).
    pub fn syscall(&mut self, nr: i64, args: [u64; 6]) -> Result<i64, RpcError> {
        let (_, abi) = self.site()?;
        let tid = self.syscall_thread(abi)?;
        self.syscall_on(tid, nr, args)
    }

    /// The cached call site and its ABI.
    pub fn site(&self) -> Result<(u64, SyscallAbi), RpcError> {
        self.core.shared.syscall_site.lock().unwrap().ok_or_else(|| RpcError::internal_error("no syscall site found yet"))
    }

    fn syscall_on(&mut self, tid: i32, nr: i64, args: [u64; 6]) -> Result<i64, RpcError> {
        let (site, abi) = self.site()?;
        let prior = self.core.threads.get(&tid).map(|t| t.state).filter(|s| s.can_run_code());
        let prior = prior.ok_or_else(|| RpcError::invalid_params(format!("thread {tid} cannot run a syscall")))?;
        let saved = get_regs(tid).map_err(|e| ptrace_error("PTRACE_GETREGS", tid, e))?;
        if !abi.fits(saved.cs) {
            return Err(RpcError::ptrace_failed(format!("thread {tid} is running code that can't make this call")));
        }
        let mut r = saved;
        abi.load(&mut r, site, nr, args);
        set_regs(tid, &r).map_err(|e| ptrace_error("PTRACE_SETREGS", tid, e))?;
        match self.step_syscall(tid, site, saved, prior) {
            Step::Done(rax) => {
                set_regs(tid, &saved).map_err(|e| ptrace_error("PTRACE_SETREGS", tid, e))?;
                Ok(abi.result(rax as u64))
            }
            Step::Failed(e) => {
                if self.core.threads.contains_key(&tid) {
                    let _ = set_regs(tid, &saved);
                }
                Err(e)
            }
            Step::Abandoned(e) => Err(e),
        }
    }

    /// Single-step `tid` over the `syscall` at `site`. Signals and group-stops that come first
    /// are recorded for resume, and the step is retried. If the thread doesn't stop in time it
    /// is left running and its registers are restored at its next stop.
    fn step_syscall(&mut self, tid: i32, site: u64, saved: libc::user_regs_struct, prior: State) -> Step {
        let timeout_error = || RpcError::ptrace_failed(format!("thread {tid} did not finish the remote syscall"));
        let deadline = Instant::now() + self.core.step_timeout;
        loop {
            if let Err(e) = pt(libc::PTRACE_SINGLESTEP, tid, 0, 0) {
                return Step::Failed(ptrace_error("PTRACE_SINGLESTEP", tid, e)); // still in its stop
            }
            let status = loop {
                let mut status = 0;
                let r = unsafe { libc::waitpid(tid, &mut status, libc::__WALL | libc::WNOHANG) };
                if r == tid {
                    break status;
                }
                if r < 0 || Instant::now() >= deadline {
                    self.core.abandon(tid, saved, site, prior);
                    return Step::Abandoned(timeout_error());
                }
                std::thread::sleep(Duration::from_micros(50));
            };
            if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                self.core.threads.remove(&tid);
                return Step::Failed(RpcError::process_not_found(format!("process {} has exited", self.core.pid)));
            }
            if !libc::WIFSTOPPED(status) {
                continue;
            }
            if let StepStop::Done(rax) = self.core.note_step_stop(tid, status, site) {
                return Step::Done(rax);
            }
            if Instant::now() >= deadline {
                return Step::Failed(timeout_error()); // stopped right now: the caller restores
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    #[test]
    fn abi_fits_code_segment() {
        assert!(SyscallAbi::X64.fits(0x33));
        assert!(!SyscallAbi::X64.fits(0x23));
        assert!(SyscallAbi::I386.fits(0x23));
        assert!(!SyscallAbi::I386.fits(0x33));
        assert_eq!(SyscallAbi::X64.site_bytes(), [0x0f, 0x05]);
        assert_eq!(SyscallAbi::I386.site_bytes(), [0xcd, 0x80]);
        assert_eq!((SyscallAbi::I386.nr_mmap(), SyscallAbi::I386.nr_munmap()), (192, 91));
        assert_eq!((SyscallAbi::X64.nr_mmap(), SyscallAbi::X64.nr_munmap()), (libc::SYS_mmap, libc::SYS_munmap));
    }

    #[test]
    fn abi_no_fitting_thread_refuses_without_touching_registers() {
        // In WoW64, a thread in 32-bit game code can't run a 64-bit `syscall`.
        assert_eq!(pick_thread(&[(10, 0x23), (11, 0x33)], SyscallAbi::X64), Some(11));
        assert_eq!(pick_thread(&[(10, 0x23), (11, 0x23)], SyscallAbi::X64), None);
        assert_eq!(pick_thread(&[(10, 0x23)], SyscallAbi::I386), Some(10));
        assert_eq!(pick_thread(&[], SyscallAbi::I386), None);
    }

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
    pub(crate) struct TestTarget {
        child: Child,
        pub(crate) addrs: HashMap<String, u64>,
    }

    impl TestTarget {
        pub(crate) fn spawn(args: &[&str]) -> TestTarget {
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
        pub(crate) fn pid(&self) -> i32 {
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

    /// A hit that is already pending (its SIGTRAP queued but not yet reported) when its slot is
    /// cleared, or when the tracer detaches, must still be swallowed: delivered to the game,
    /// SIGTRAP kills it. `--spin` stores to `g_spin_calls` in a tight loop, so a hit is nearly
    /// always pending.
    #[test]
    fn clearing_or_detaching_amid_a_trap_storm_never_kills_the_game() {
        for _ in 0..3 {
            let t = TestTarget::spawn(&["--spin"]);
            let pid = t.pid();
            let calls = t.addrs["g_spin_calls"];
            let cfg = DrConfig { addr: calls, len: 8, rw: DrRw::Write };
            let tr = for_pid(pid).unwrap();
            let traps = tr.subscribe_traps();
            for _ in 0..20 {
                tr.set_watch_slot(0, Some(cfg)).unwrap();
                traps.recv_timeout(Duration::from_secs(1)).unwrap_or_else(|e| panic!("no trap within 1 s ({e:?}); game dead: {}", thread_finished(pid, pid)));
                tr.set_watch_slot(0, None).unwrap();
            }
            std::thread::sleep(Duration::from_millis(50));
            assert!(!thread_finished(pid, pid), "the game died after its slot was cleared");
            tr.set_watch_slot(0, Some(cfg)).unwrap();
            traps.recv_timeout(Duration::from_secs(1)).expect("no trap within 1 s");
            drop(tr); // detach while hits keep coming
            assert_eq!(tracer_pid_of(pid), 0);
            let before = u64::from_le_bytes(read_mem(pid, calls));
            std::thread::sleep(Duration::from_millis(100));
            assert!(!thread_finished(pid, pid), "the game died after detach");
            assert!(u64::from_le_bytes(read_mem(pid, calls)) > before, "the spin thread stopped");
        }
    }

    #[test]
    fn sig_pending_reads_the_status_masks() {
        let status = |pnd: &str, shd: &str, blk: &str| {
            format!("Name:\ttarget\nSigQ:\t1/127000\nSigPnd:\t{pnd}\nShdPnd:\t{shd}\nSigBlk:\t{blk}\nSigIgn:\t0000000000000000\n")
        };
        let zero = "0000000000000000";
        // Signal n is bit n - 1: SIGTRAP (5) is 0x10.
        assert!(sig_pending_in(&status("0000000000000010", zero, zero), libc::SIGTRAP));
        assert!(!sig_pending_in(&status("0000000000000020", zero, zero), libc::SIGTRAP), "0x20 is SIGBUS");
        assert!(!sig_pending_in(&status("0000000000000008", zero, zero), libc::SIGTRAP), "0x08 is SIGQUIT");
        // The process-wide queue counts too.
        assert!(sig_pending_in(&status(zero, "0000000000000010", zero), libc::SIGTRAP));
        // A blocked signal stays queued and is never reported: nothing to wait for.
        assert!(!sig_pending_in(&status("0000000000000010", zero, "0000000000000010"), libc::SIGTRAP));
        // Other signals and high bits (real-time signals) don't count.
        assert!(sig_pending_in(&status("8000000000000210", zero, zero), libc::SIGTRAP));
        assert!(!sig_pending_in(&status("8000000000000200", zero, zero), libc::SIGTRAP));
        assert!(!sig_pending_in(&status(zero, zero, zero), libc::SIGTRAP));
        assert!(!sig_pending_in("", libc::SIGTRAP));
        // SIGUSR2 (12) is bit 11.
        assert!(sig_pending_in(&status("0000000000000800", zero, zero), libc::SIGUSR2));
    }

    /// A real SIGTRAP queued for a stopped thread shows up in its `/proc` status.
    #[test]
    fn sigtrap_queued_sees_a_trap_queued_for_a_stopped_thread() {
        let t = TestTarget::spawn(&["--spin"]);
        let pid = t.pid();
        let tr = for_pid(pid).unwrap();
        let (before, after) = tr
            .with_stopped(move |s| {
                let before = sigtrap_queued(pid, pid);
                tgkill(pid, pid, libc::SIGTRAP);
                let after = sigtrap_queued(pid, pid);
                // Don't let it reach the game: take it at its signal-delivery-stop, and swallow it.
                s.core.threads.get_mut(&pid).unwrap().step_trap_pending = true;
                (before, after)
            })
            .unwrap();
        assert!(!before && after, "before {before}, after {after}");
        drop(tr);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!thread_finished(pid, pid), "the test's SIGTRAP reached the game");
    }

    /// No watch was ever armed (`dr_used` false: right after an alloc or a speed hook install,
    /// which detach at once) and a thread still has our single-step's SIGTRAP queued. Detach
    /// resumes it so the trap is swallowed, and must then detach that thread too: left stopped
    /// for the kernel's implicit detach, the trap would be delivered to the game after all.
    #[test]
    fn detach_never_leaves_a_swallowed_step_trap_to_the_kernel() {
        for _ in 0..5 {
            let t = TestTarget::spawn(&["--spin"]);
            let pid = t.pid();
            let tr = for_pid(pid).unwrap();
            let (left, traced) = tr
                .with_stopped(move |s| {
                    // Our step's late trap, as `note_step_stop` leaves it: queued, flagged.
                    tgkill(pid, pid, libc::SIGTRAP);
                    s.core.threads.get_mut(&pid).unwrap().step_trap_pending = true;
                    assert!(!s.core.dr_used);
                    s.core.detach_all();
                    let left: Vec<(i32, State)> = s.core.threads.iter().map(|(&t, th)| (t, th.state)).collect();
                    let traced: Vec<i32> = list_tids(pid)
                        .unwrap()
                        .into_iter()
                        .filter(|t| status_tracer_pid(&format!("/proc/{pid}/task/{t}/status")).unwrap_or(0) != 0)
                        .collect();
                    (left, traced)
                })
                .unwrap();
            assert!(left.is_empty(), "threads still ours after detach: {left:?}");
            assert!(traced.is_empty(), "threads still traced after detach: {traced:?}");
            drop(tr);
            std::thread::sleep(Duration::from_millis(100));
            assert!(!thread_finished(pid, pid), "our step's SIGTRAP reached the game");
        }
    }

    /// A watch hit's SIGTRAP still queued at detach is waited for for as long as it stays
    /// queued, not for one grace period: a thread that isn't scheduled in time (CPU throttling,
    /// load) must not be detached with it. Stalled resumes simulate exactly that.
    #[test]
    #[ignore = "setup races the scheduler (~50% under load); run with --ignored on an idle machine"]
    fn detach_keeps_waiting_while_a_watch_trap_is_queued() {
        for _ in 0..5 {
            let t = TestTarget::spawn(&["--spin"]);
            let pid = t.pid();
            let calls = t.addrs["g_spin_calls"];
            let tr = for_pid(pid).unwrap();
            let traps = tr.subscribe_traps();
            tr.set_watch_slot(0, Some(DrConfig { addr: calls, len: 8, rw: DrRw::Write })).unwrap();
            traps.recv_timeout(Duration::from_secs(1)).expect("no trap within 1 s");
            let (queued, traced) = tr
                .with_stopped(move |s| {
                    let spin = *s.tids().iter().find(|&&t| t != pid).unwrap();
                    let queued = catch_queued_hit(s, spin);
                    s.core.detach_grace = Duration::ZERO;
                    s.core.detach_stalls = 3;
                    s.core.detach_all();
                    let traced = list_tids(pid)
                        .unwrap()
                        .into_iter()
                        .filter(|t| status_tracer_pid(&format!("/proc/{pid}/task/{t}/status")).unwrap_or(0) != 0)
                        .count();
                    (queued, traced)
                })
                .unwrap();
            assert!(queued, "never caught the spin thread with a watch hit queued");
            assert_eq!(traced, 0, "threads still traced after detach");
            drop(tr);
            let before = u64::from_le_bytes(read_mem(pid, calls));
            std::thread::sleep(Duration::from_millis(100));
            assert!(!thread_finished(pid, pid), "a watch SIGTRAP reached the game");
            assert!(u64::from_le_bytes(read_mem(pid, calls)) > before, "the spin thread stopped");
        }
    }

    /// Resume `tid` (which keeps hitting an armed watch) and interrupt it at once, until it is
    /// stopped by the interrupt with a hit's SIGTRAP still queued. False if that never happens.
    fn catch_queued_hit(s: &mut Stopped<'_>, tid: i32) -> bool {
        for _ in 0..5000 {
            s.core.release(tid, false);
            let _ = pt(libc::PTRACE_INTERRUPT, tid, 0, 0);
            let mut status = 0;
            unsafe { libc::waitpid(tid, &mut status, libc::__WALL) };
            s.core.on_event(tid, status);
            if s.core.threads[&tid].state == State::Interrupted && s.core.our_trap_queued(tid) {
                return true;
            }
        }
        false
    }

    /// The daemon's exit detaches tracers whose `Arc` is still held, with no trap of ours left.
    /// Runs in its own process: `URGENT` is process-wide and would end every other test's tracer.
    #[test]
    #[ignore = "sets the process-wide exit flag; run with --ignored --test-threads=1 on its own"]
    fn detach_everything_detaches_tracers_still_held() {
        let t = TestTarget::spawn(&["--spin"]);
        let pid = t.pid();
        let tr = for_pid(pid).unwrap();
        let traps = tr.subscribe_traps();
        let calls = t.addrs["g_spin_calls"];
        tr.set_watch_slot(0, Some(DrConfig { addr: calls, len: 8, rw: DrRw::Write })).unwrap();
        traps.recv_timeout(Duration::from_secs(1)).expect("no trap within 1 s");
        let start = Instant::now();
        detach_everything(Duration::from_secs(4));
        assert!(start.elapsed() < Duration::from_secs(4), "took {:?}", start.elapsed());
        assert_eq!(tracer_pid_of(pid), 0, "still traced");
        assert!(for_pid(pid).is_err(), "no new tracer while exiting");
        assert!(tr.with_stopped(|_| ()).is_err());
        drop(tr);
        let before = u64::from_le_bytes(read_mem(pid, calls));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!thread_finished(pid, pid), "the game died");
        assert!(u64::from_le_bytes(read_mem(pid, calls)) > before, "the spin thread stopped (DRs still armed?)");
    }

    #[test]
    fn reportable_masks_inactive_and_stale_slots() {
        // Hits on slots 0 and 2; slot 2 is no longer active.
        assert_eq!(reportable(0b0101, 0b0011, 0), 0b0001);
        // Slot 0's hit was queued before it was re-armed: it belongs to the previous watch.
        assert_eq!(reportable(0b0101, 0b0101, 0b0001), 0b0100);
        // BS and other DR6 bits never count as slot hits.
        assert_eq!(reportable(DR6_BS | 0b1000, 0b1111, 0), 0b1000);
        assert_eq!(reportable(0xffff_0ff0, 0b1111, 0), 0);
    }

    /// A hit queued when its slot is re-armed for another address (an interrupt is reported
    /// before a pending signal) belongs to the old watch: the new one must never see it.
    #[test]
    fn a_reused_slot_never_reports_the_previous_watchs_queued_hit() {
        let t = TestTarget::spawn(&["--spin"]);
        let pid = t.pid();
        let calls = DrConfig { addr: t.addrs["g_spin_calls"], len: 8, rw: DrRw::Write };
        // Nothing writes g_health: any trap on its slot is a stale one.
        let quiet = DrConfig { addr: t.addrs["g_health"], len: 4, rw: DrRw::Write };
        let tr = for_pid(pid).unwrap();
        let traps = tr.subscribe_traps();
        for round in 0..40 {
            tr.set_watch_slot(0, Some(calls)).unwrap();
            traps.recv_timeout(Duration::from_secs(1)).expect("no trap within 1 s");
            if round % 2 == 0 {
                tr.set_watch_slot(0, None).unwrap(); // clear, then re-arm
            }
            tr.set_watch_slot(0, Some(quiet)).unwrap();
            // Everything sent before the re-arm returned is already in the channel.
            while traps.try_recv().is_ok() {}
            std::thread::sleep(Duration::from_millis(5));
            if let Ok(trap) = traps.try_recv() {
                panic!("round {round}: the re-armed slot reported a stale hit at rip {:#x}", trap.regs.rip);
            }
        }
        tr.set_watch_slot(0, None).unwrap();
        drop(tr);
        std::thread::sleep(Duration::from_millis(50));
        assert!(!thread_finished(pid, pid), "the game died");
    }

    /// A remote syscall on a thread whose watch hit is still queued: the hit's SIGTRAP is
    /// reported first, during the single-step, and must be swallowed there, not queued for the game.
    #[test]
    fn remote_syscall_on_a_thread_with_a_queued_hit_swallows_it() {
        let t = TestTarget::spawn(&["--spin"]);
        let pid = t.pid();
        let calls = t.addrs["g_spin_calls"];
        let tr = for_pid(pid).unwrap();
        tr.set_syscall_site(find_site(pid));
        let traps = tr.subscribe_traps();
        tr.set_watch_slot(2, Some(DrConfig { addr: calls, len: 8, rw: DrRw::Write })).unwrap();
        traps.recv_timeout(Duration::from_secs(1)).expect("no trap within 1 s");
        for _ in 0..30 {
            let r = tr
                .with_stopped(move |s| {
                    let spin = *s.tids().iter().find(|&&t| t != pid).unwrap();
                    s.syscall_on(spin, libc::SYS_getpid, [0; 6])
                })
                .unwrap();
            assert_eq!(r.unwrap(), pid as i64);
        }
        tr.set_watch_slot(2, None).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!thread_finished(pid, pid), "a queued watch SIGTRAP reached the game");
        drop(tr);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!thread_finished(pid, pid), "the game died after detach");
    }

    fn find_site(pid: i32) -> u64 {
        use std::os::unix::fs::FileExt;
        let mem = std::fs::File::open(format!("/proc/{pid}/mem")).unwrap();
        let maps = crate::maps::read(pid).unwrap();
        for r in maps.iter().filter(|r| r.perms.exec && r.path.as_deref().is_some_and(|p| p.contains("/libc.so"))) {
            let mut buf = vec![0u8; (r.end - r.start) as usize];
            if mem.read_at(&mut buf, r.start).is_ok() {
                if let Some(i) = buf.windows(2).position(|w| w == [0x0f, 0x05]) {
                    return r.start + i as u64;
                }
            }
        }
        panic!("no syscall in libc");
    }

    fn read_mem<const N: usize>(pid: i32, addr: u64) -> [u8; N] {
        use std::os::unix::fs::FileExt;
        let mut b = [0u8; N];
        std::fs::File::open(format!("/proc/{pid}/mem")).unwrap().read_at(&mut b, addr).unwrap();
        b
    }

    /// The target's SIGUSR2 record: [count, si_code, sival_int].
    fn sig_record(pid: i32, addr: u64) -> [i32; 3] {
        let b: [u8; 12] = read_mem(pid, addr);
        [0, 1, 2].map(|i| i32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap()))
    }

    fn wait_sig_count(pid: i32, addr: u64, count: i32) -> [i32; 3] {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let r = sig_record(pid, addr);
            if r[0] >= count || Instant::now() >= deadline {
                return r;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    const SI_QUEUE: i32 = -1;

    /// Queue SIGUSR2 with `value` to one thread of the test target, as sigqueue would.
    fn queue_usr2(pid: i32, tid: i32, value: i32) {
        let mut si: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let p = &mut si as *mut libc::siginfo_t as *mut u8;
        unsafe {
            *(p as *mut i32) = libc::SIGUSR2; // si_signo
            *(p.add(8) as *mut i32) = SI_QUEUE; // si_code
            *(p.add(16) as *mut i32) = libc::getpid(); // si_pid
            *(p.add(20) as *mut u32) = libc::getuid(); // si_uid
            *(p.add(24) as *mut i32) = value; // si_value.sival_int
            assert_eq!(libc::syscall(libc::SYS_rt_tgsigqueueinfo, pid, tid, libc::SIGUSR2, &si), 0);
        }
    }

    #[test]
    fn abandoned_step_restores_registers_at_the_threads_next_stop() {
        let t = TestTarget::spawn(&["--spin"]);
        let pid = t.pid();
        let tr = for_pid(pid).unwrap();
        tr.set_syscall_site(find_site(pid));
        let mut abandoned = 0;
        for _ in 0..20 {
            // A zero step timeout gives up on the step at once, as a 2 s stall would: the main
            // thread is left running the injected syscall with our registers.
            let (r, pending) = tr
                .with_stopped(move |s| {
                    s.core.step_timeout = Duration::ZERO;
                    let r = s.syscall_on(pid, libc::SYS_getpid, [0; 6]);
                    s.core.step_timeout = STOP_TIMEOUT;
                    (r, s.core.threads.get(&pid).is_some_and(|t| t.restore.is_some()))
                })
                .unwrap();
            match r {
                Ok(v) => assert_eq!(v, pid as i64),
                Err(_) if pending => abandoned += 1,
                Err(_) => {}
            }
        }
        assert!(abandoned > 0, "no step was abandoned");
        // Without the restore, the step's SIGTRAP would be delivered to the game (killing it), or
        // the main thread would carry on with our registers. Instead it keeps sleeping and ticking.
        let ticks = t.addrs["g_main_ticks"];
        let t0 = u64::from_le_bytes(read_mem(pid, ticks));
        let deadline = Instant::now() + Duration::from_secs(3);
        while u64::from_le_bytes(read_mem(pid, ticks)) <= t0 {
            assert!(Instant::now() < deadline, "main thread stopped ticking");
            assert!(!thread_finished(pid, pid), "target died");
            std::thread::sleep(Duration::from_millis(20));
        }
        let left = tr.with_stopped(|s| s.core.threads.values().filter(|t| t.restore.is_some()).count()).unwrap();
        assert_eq!(left, 0, "a restore is still pending");
        drop(tr);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!thread_finished(pid, pid), "target died after detach");
    }

    #[test]
    fn signals_keep_their_siginfo_across_a_remote_syscall() {
        let t = TestTarget::spawn(&["--spin"]);
        let pid = t.pid();
        let rec = t.addrs["g_sig"];
        let tr = for_pid(pid).unwrap();
        tr.set_syscall_site(find_site(pid));

        // A signal that arrives while our syscall runs is queued, then delivered as it was sent.
        let queued = tr
            .with_stopped(move |s| {
                assert_eq!(s.syscall_thread(SyscallAbi::X64).unwrap(), pid, "the interrupted main thread runs syscalls");
                queue_usr2(pid, pid, 4242);
                assert_eq!(s.syscall_on(pid, libc::SYS_getpid, [0; 6]).unwrap(), pid as i64);
                s.core.threads[&pid].queued.len()
            })
            .unwrap();
        assert_eq!(queued, 1, "the signal stopped the step first");
        assert_eq!(wait_sig_count(pid, rec, 1), [1, SI_QUEUE, 4242]);

        // A thread stopped delivering a signal is used only when nothing else can run a syscall;
        // when it is, its signal still goes out with its own siginfo.
        tr.with_stopped(move |s| {
            queue_usr2(pid, pid, 777);
            let mut status = 0;
            for _ in 0..5 {
                pt(libc::PTRACE_CONT, pid, 0, 0).unwrap();
                unsafe { libc::waitpid(pid, &mut status, libc::__WALL) };
                s.core.on_event(pid, status);
                if s.core.threads[&pid].state == State::Signal(libc::SIGUSR2) {
                    break;
                }
            }
            assert_eq!(s.core.threads[&pid].state, State::Signal(libc::SIGUSR2));
            assert_ne!(s.syscall_thread(SyscallAbi::X64).unwrap(), pid, "an interrupted thread is preferred");
            assert_eq!(s.syscall_on(pid, libc::SYS_getpid, [0; 6]).unwrap(), pid as i64);
        })
        .unwrap();
        assert_eq!(wait_sig_count(pid, rec, 2), [2, SI_QUEUE, 777]);
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
