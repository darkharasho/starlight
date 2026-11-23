//! Hardware watchpoints: "what writes / accesses this address" (D21).
//!
//! A watch arms one of the process's four debug-register slots (DR0–DR3) on every thread through
//! the tracer, which also arms threads created later before they first run. A collector thread
//! per watch turns the tracer's traps into hits grouped by instruction: a data breakpoint traps
//! *after* the access, so the reported address is the start of the instruction ending at `rip`
//! (`disasm::instruction_before`, ruling R10), with `next = rip`, a count, and the registers of
//! the first hit. If no instruction can be found ending at `rip` (unreadable or undecodable
//! code), the hit's `address` is `null` and `text` is `"??"`; `next` is still `rip`. The collector ends the watch at its deadline, at `max_hits`, when the process
//! exits, or when asked (`watch_stop`, detach, connection close), clears the slot, and sends
//! `watch_ended` unless the client stopped it.
use crate::cleanup::{Owner, Teardown};
use crate::disasm::{self, Symbolizer};
use crate::modules;
use crate::process::Target;
use crate::rpc::{Conn, RpcError};
use crate::tracer::{DrConfig, DrRw, Trap, Tracer};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const DEFAULT_DURATION_MS: u64 = 10_000;
pub const MAX_DURATION_MS: u64 = 60_000;
pub const DEFAULT_MAX_HITS: u64 = 5_000;
/// How often the collector checks for a stop request or the process's exit.
const TICK: Duration = Duration::from_millis(10);
/// Attempts at clearing the slot (a stop-the-world can time out under load).
const CLEAR_TRIES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Timeout,
    MaxHits,
    Stopped,
    ProcessExited,
    Detached,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Timeout => "timeout",
            Reason::MaxHits => "max_hits",
            Reason::Stopped => "stopped",
            Reason::ProcessExited => "process_exited",
            Reason::Detached => "detached",
        }
    }
}

/// Debug-register slots in use per pid, across every connection: a process has only four.
static SLOTS: LazyLock<Mutex<HashMap<i32, [bool; 4]>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn claim_slot(pid: i32) -> Result<usize, RpcError> {
    let mut all = SLOTS.lock().unwrap();
    let used = all.entry(pid).or_default();
    let slot = used
        .iter()
        .position(|u| !u)
        .ok_or_else(|| RpcError::busy(format!("all 4 debug registers of pid {pid} are in use by other watches")))?;
    used[slot] = true;
    Ok(slot)
}

fn release_slot(pid: i32, slot: usize) {
    let mut all = SLOTS.lock().unwrap();
    if let Some(used) = all.get_mut(&pid) {
        used[slot] = false;
        if used.iter().all(|u| !u) {
            all.remove(&pid);
        }
    }
}

/// One instruction that touched the watched address.
#[derive(Clone)]
struct Hit {
    /// Start of the instruction; `None` if none could be found ending at `next`.
    address: Option<u64>,
    next: u64,
    module: Option<String>,
    text: String,
    count: u64,
    /// Registers at its first hit (after the instruction ran).
    regs: libc::user_regs_struct,
}

impl Hit {
    fn to_json(&self) -> Value {
        let r = &self.regs;
        let regs: serde_json::Map<String, Value> = [
            ("rax", r.rax),
            ("rbx", r.rbx),
            ("rcx", r.rcx),
            ("rdx", r.rdx),
            ("rsi", r.rsi),
            ("rdi", r.rdi),
            ("rbp", r.rbp),
            ("rsp", r.rsp),
            ("r8", r.r8),
            ("r9", r.r9),
            ("r10", r.r10),
            ("r11", r.r11),
            ("r12", r.r12),
            ("r13", r.r13),
            ("r14", r.r14),
            ("r15", r.r15),
            ("rip", r.rip),
            ("eflags", r.eflags),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), Value::String(format!("{v:#x}"))))
        .collect();
        json!({
            "address": self.address.map(|a| format!("{a:#x}")),
            "next": format!("{:#x}", self.next),
            "module": self.module,
            "text": self.text,
            "count": self.count,
            "registers": regs,
        })
    }
}

#[derive(Default)]
struct State {
    /// Set when the collector has ended the watch.
    reason: Option<Reason>,
    /// An end asked for by `watch_stop` or teardown, picked up by the collector.
    request: Option<Reason>,
    /// The collector is done: the slot is cleared and the tracer released.
    finished: bool,
    /// Hits in the order their instruction was first seen.
    hits: Vec<Hit>,
    /// This watch's teardown action in the connection's owner.
    token: Option<u64>,
}

struct Watch {
    id: u32,
    state: Mutex<State>,
    cv: Condvar,
}

impl Watch {
    /// The state, even if a collector panicked while holding it.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ask the collector to end the watch (unless it already has) and wait until it is done.
    fn end(&self, reason: Reason) {
        let mut s = self.lock();
        s.request.get_or_insert(reason);
        while !s.finished {
            s = self.cv.wait(s).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn report(&self) -> Value {
        let s = self.lock();
        json!({
            "active": s.reason.is_none(),
            "reason": s.reason.map(Reason::as_str),
            "hits": s.hits.iter().map(Hit::to_json).collect::<Vec<_>>(),
        })
    }
}

type Live = Arc<Mutex<HashMap<u32, Arc<Watch>>>>;

/// One connection's watches.
pub struct Watches {
    owner: Arc<Owner>,
    conn: Conn,
    live: Live,
    next: AtomicU32,
}

impl Watches {
    pub fn new(owner: Arc<Owner>, conn: Conn) -> Self {
        Watches { owner, conn, live: Live::default(), next: AtomicU32::new(1) }
    }

    /// Watch `size` bytes at `addr` of `t` for `duration_ms`, or until `max_hits` hits.
    /// `-32602` for a bad size, misalignment, duration or hit limit; `-32013` when all four
    /// debug registers of the process are taken.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        handle: u32,
        t: Arc<Target>,
        addr: u64,
        size: u64,
        rw: DrRw,
        duration_ms: u64,
        max_hits: u64,
    ) -> Result<u32, RpcError> {
        if !matches!(size, 1 | 2 | 4 | 8) {
            return Err(RpcError::invalid_params("size must be 1, 2, 4 or 8"));
        }
        if addr % size != 0 {
            return Err(RpcError::invalid_params(format!("address {addr:#x} is not aligned to size {size}")));
        }
        if duration_ms == 0 || duration_ms > MAX_DURATION_MS {
            return Err(RpcError::invalid_params(format!("duration_ms must be 1..={MAX_DURATION_MS}")));
        }
        if max_hits == 0 {
            return Err(RpcError::invalid_params("max_hits must be at least 1"));
        }
        let cfg = DrConfig { addr, len: size as u8, rw };
        let slot = claim_slot(t.pid)?;
        let tracer = match t.tracer() {
            Ok(tr) => tr,
            Err(e) => {
                release_slot(t.pid, slot);
                return Err(e);
            }
        };
        // Subscribed before arming, so no hit is missed.
        let traps = tracer.subscribe_traps();
        if let Err(e) = tracer.set_watch_slot(slot, Some(cfg)) {
            let _ = tracer.set_watch_slot(slot, None);
            release_slot(t.pid, slot);
            drop(tracer); // may detach: outside every lock
            return Err(e);
        }

        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let w = Arc::new(Watch { id, state: Mutex::default(), cv: Condvar::new() });
        let c = Collector {
            w: w.clone(),
            conn: self.conn.clone(),
            t,
            tracer,
            traps,
            slot,
            deadline: Instant::now() + Duration::from_millis(duration_ms),
            max_hits,
        };
        std::thread::spawn(move || c.run());

        self.live.lock().unwrap().insert(id, w.clone());
        let live = self.live.clone();
        // If the owner is already closed (the connection is ending) this ends the watch at once.
        let token = self.owner.add(Some(handle), Teardown::Watch, Box::new(move || {
            let w = live.lock().unwrap().remove(&id);
            if let Some(w) = w {
                w.end(Reason::Detached);
            }
        }));
        w.lock().token = Some(token);
        Ok(id)
    }

    /// End watch `id` quietly (no notification) because its handle went away while starting.
    pub fn cancel(&self, id: u32) {
        let _ = self.stop(id);
    }

    /// The watch's state and hits so far. Unknown id is `-32009`.
    pub fn poll(&self, id: u32) -> Result<Value, RpcError> {
        let w = self.live.lock().unwrap().get(&id).cloned().ok_or_else(|| unknown(id))?;
        Ok(w.report())
    }

    /// End watch `id` (if it is still running) and return its final report; the id is gone
    /// afterwards. Unknown id is `-32009`.
    pub fn stop(&self, id: u32) -> Result<Value, RpcError> {
        let w = self.live.lock().unwrap().remove(&id).ok_or_else(|| unknown(id))?;
        w.end(Reason::Stopped);
        if let Some(token) = w.lock().token.take() {
            self.owner.remove(token);
        }
        Ok(w.report())
    }
}

fn unknown(id: u32) -> RpcError {
    RpcError::unknown_id(format!("unknown watch id: {id}"))
}

/// Everything the collector thread owns. Holding `tracer` keeps the game traced (R12).
struct Collector {
    w: Arc<Watch>,
    conn: Conn,
    t: Arc<Target>,
    tracer: Arc<Tracer>,
    traps: Receiver<Trap>,
    slot: usize,
    deadline: Instant,
    max_hits: u64,
}

impl Collector {
    fn run(self) {
        // Even if collecting panics, the watch is marked finished (so `Watch::end` returns)
        // and its slot is released.
        let mut fin = Finish { w: self.w.clone(), pid: self.t.pid, slot: self.slot, release_slot: true };
        let reason = self.collect();
        let Collector { w, conn, tracer, traps, slot, .. } = self;
        // Disarm before anything else; a gone process has nothing left to disarm.
        let mut cleared = false;
        for _ in 0..CLEAR_TRIES {
            match tracer.set_watch_slot(slot, None) {
                Ok(()) => cleared = true,
                Err(e) if e.code == -32002 => cleared = true, // ProcessNotFound
                Err(_) => continue,
            }
            break;
        }
        // A slot that may still be armed stays claimed, so no other watch is handed it (its
        // hits are still swallowed by the tracer, and its detach clears the registers).
        fin.release_slot = cleared;
        w.lock().reason = Some(reason);
        drop(traps);
        // The last holder detaches here, outside every lock.
        drop(tracer);
        if reason != Reason::Stopped {
            conn.send_notification("watch_ended", json!({ "id": w.id, "reason": reason.as_str() }));
        }
        drop(fin);
    }

    /// Collect hits until the watch has to end; returns why.
    fn collect(&self) -> Reason {
        let bit = 1u64 << self.slot;
        // Trap rip -> index into `hits` (one instruction start per rip).
        let mut sites: HashMap<u64, usize> = HashMap::new();
        let mut sym: Option<Symbolizer> = None;
        let mut total = 0u64;
        loop {
            if let Some(r) = self.w.lock().request {
                return r;
            }
            let now = Instant::now();
            if now >= self.deadline {
                return Reason::Timeout;
            }
            if self.t.exited() {
                return Reason::ProcessExited;
            }
            let trap = match self.traps.recv_timeout(TICK.min(self.deadline - now)) {
                Ok(trap) => trap,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Reason::ProcessExited,
            };
            if trap.dr6 & bit == 0 {
                continue; // another watch's slot
            }
            let rip = trap.regs.rip;
            match sites.get(&rip) {
                Some(&i) => self.w.lock().hits[i].count += 1,
                None => {
                    let hit = self.describe(rip, trap.regs, &mut sym);
                    let mut s = self.w.lock();
                    sites.insert(rip, s.hits.len());
                    s.hits.push(hit);
                }
            }
            total += 1;
            if total >= self.max_hits {
                return Reason::MaxHits;
            }
        }
    }

    /// A new hit for the instruction that ends at `rip`.
    fn describe(&self, rip: u64, regs: libc::user_regs_struct, sym: &mut Option<Symbolizer>) -> Hit {
        let address = disasm::instruction_before(&self.t, rip);
        let text = address
            .and_then(|s| disasm::read_code(&self.t, s, (rip - s) as usize).ok().map(|b| (s, b)))
            .and_then(|(s, b)| disasm::decode(&b, s, 1).into_iter().next())
            .map_or_else(|| "??".to_string(), |i| i.text);
        // Without a start, the module is named after `next` (the same code region).
        let at = address.unwrap_or(rip);
        let mut name = sym.as_ref().and_then(|s| s.name(at));
        if name.is_none() {
            // First hit, or a module loaded since: refresh the module list.
            *sym = modules::list(&self.t).ok().map(|m| Symbolizer::new(&m));
            name = sym.as_ref().and_then(|s| s.name(at));
        }
        Hit { address, next: rip, module: name, text, count: 1, regs }
    }
}

/// Marks a collector's watch finished, and releases its slot unless told not to, when the
/// collector ends, normally or by panicking.
struct Finish {
    w: Arc<Watch>,
    pid: i32,
    slot: usize,
    release_slot: bool,
}

impl Drop for Finish {
    fn drop(&mut self) {
        if self.release_slot {
            release_slot(self.pid, self.slot);
        }
        let mut s = self.w.lock();
        s.reason.get_or_insert(Reason::Stopped);
        s.finished = true;
        drop(s);
        self.w.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_are_per_pid_and_reusable() {
        // A pid no test target can have (above pid_max).
        let pid = i32::MAX - 7;
        let got: Vec<usize> = (0..4).map(|_| claim_slot(pid).unwrap()).collect();
        assert_eq!(got, [0, 1, 2, 3]);
        assert_eq!(claim_slot(pid).unwrap_err().code, -32013);
        assert_eq!(claim_slot(pid - 1).unwrap(), 0, "another process has its own four");
        release_slot(pid, 2);
        assert_eq!(claim_slot(pid).unwrap(), 2);
        for s in 0..4 {
            release_slot(pid, s);
        }
        release_slot(pid - 1, 0);
        assert!(!SLOTS.lock().unwrap().contains_key(&pid));
    }

    #[test]
    fn hit_json_has_every_register_as_hex() {
        let mut regs: libc::user_regs_struct = unsafe { std::mem::zeroed() };
        regs.rip = 0x401136;
        regs.r15 = 0xabc;
        let h = Hit { address: Some(0x401130), next: 0x401136, module: Some("target+0x1130".into()), text: "mov [404108],eax".into(), count: 3, regs };
        let v = h.to_json();
        assert_eq!(v["address"], "0x401130");
        assert_eq!(v["next"], "0x401136");
        assert_eq!(v["count"], 3);
        assert_eq!(v["registers"]["rip"], "0x401136");
        assert_eq!(v["registers"]["r15"], "0xabc");
        assert_eq!(v["registers"].as_object().unwrap().len(), 18);
        // No instruction found ending at `next`: no address, `next` still reported.
        let v = Hit { address: None, text: "??".into(), ..h }.to_json();
        assert_eq!(v["address"], Value::Null);
        assert_eq!(v["next"], "0x401136");
    }
}
