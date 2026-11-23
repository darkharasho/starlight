//! Game speed (D11–D17): timing functions are hooked with code from `templates`, which scales
//! the time they return through one shared rwx state page per handle. Every hook and GOT slot
//! write is a recorded patch (reverted at speed 1.0 and at session end), and is also listed in
//! the page's recovery record so a later daemon can undo hooks a SIGKILLed one left (D12).
//! State pages and hook pages are never freed (D9).
pub mod targets;
pub mod templates;

use crate::cleanup::{Owner, Teardown};
use crate::hook::{self, HookError};
use crate::patch::{self, ApplyError, Patches};
use crate::process::Target;
use crate::rpc::RpcError;
use crate::tracer::Tracer;
use crate::{asm, maps, mem, modules, remote};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use targets::HookTarget;
use templates as tpl;

pub const STATE_PAGE_SIZE: u64 = 0x2000;
pub const MAGIC: [u8; 8] = *b"STLSPD01";
/// Accepted speeds (D17). 1.0 removes the hooks.
pub const MIN_SPEED: f64 = 0.1;
pub const MAX_SPEED: f64 = 10.0;
const PAGE: u64 = 0x1000;
const RWX: i32 = libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC;
/// Orphan search: page starts are checked in rwx anonymous mappings up to this size, so a state
/// page the kernel merged with a neighbouring rwx mapping is still found.
const ORPHAN_SCAN_MAX: u64 = 1 << 20;

/// What a hooked function returns, and so how its hook converts time. The Win64 kinds are
/// discovered by Proton targets (Task 12); until then only debug `targets` name them.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `QueryPerformanceCounter`/`NtQueryPerformanceCounter`: `i64` counter through a pointer.
    Qpc,
    /// `GetTickCount`/`timeGetTime`: `u32` milliseconds in `eax`.
    Tick32,
    /// `GetTickCount64`: `u64` milliseconds in `rax`.
    Tick64,
    /// `clock_gettime(id, timespec*)`, hooked inline.
    ClockGettime,
    /// `gettimeofday(timeval*, tz)`, hooked inline.
    Gettimeofday,
    /// `gettimeofday` reached through GOT slots; the hook calls `__vdso_gettimeofday` (D16).
    GettimeofdayGot,
}

impl Kind {
    /// Wire name, for debug `targets`.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "qpc" => Kind::Qpc,
            "tick32" => Kind::Tick32,
            "tick64" => Kind::Tick64,
            "clock_gettime" => Kind::ClockGettime,
            "gettimeofday" => Kind::Gettimeofday,
            "gettimeofday_got" => Kind::GettimeofdayGot,
            _ => return None,
        })
    }
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Abi {
    Win64,
    Sysv,
}

impl Abi {
    /// Wire name, for debug `targets`.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn parse(s: &str) -> Option<Abi> {
        match s {
            "win64" => Some(Abi::Win64),
            "sysv" => Some(Abi::Sysv),
            _ => None,
        }
    }
}

/// One target's outcome: hooked, or skipped with the reason.
#[derive(Debug, Clone, PartialEq)]
pub struct HookReport {
    pub name: String,
    pub address: u64,
    pub skipped: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub speed: f64,
    pub hooks: Vec<HookReport>,
}

/// State pages of this daemon whose hooks are live (or going in), as (pid, address). Orphan
/// recovery leaves them alone (R6). A page at speed 1.0 is not listed: its record is empty.
static LIVE: Mutex<Vec<(i32, u64)>> = Mutex::new(Vec::new());

fn is_live(pid: i32, page: u64) -> bool {
    LIVE.lock().unwrap().contains(&(pid, page))
}

/// List `page` as live, unless another page of this daemon already scales `pid`'s time:
/// hooking again would stack on its hooks (and its GOT slot writes).
fn claim(pid: i32, page: u64) -> bool {
    let mut l = LIVE.lock().unwrap();
    if l.iter().any(|&(p, other)| p == pid && other != page) {
        return false;
    }
    if !l.contains(&(pid, page)) {
        l.push((pid, page));
    }
    true
}

fn unclaim(pid: i32, page: u64) {
    LIVE.lock().unwrap().retain(|&e| e != (pid, page));
}

/// One recorded change: an inline hook's entry jump or a GOT slot.
struct Installed {
    patch_id: u32,
    addr: u64,
    original: Vec<u8>,
}

/// One handle's speed state.
struct Entry {
    target: Arc<Target>,
    state: Option<u64>,
    speed: f64,
    gen: u32,
    /// In install order, which is also the recovery record's order.
    installed: Vec<Installed>,
    hooks: Vec<HookReport>,
    token: Option<u64>,
    /// Torn down: the handle is going away.
    dead: bool,
}

impl Entry {
    fn status(&self) -> Status {
        Status { speed: self.speed, hooks: self.hooks.clone() }
    }
}

type Map = Arc<Mutex<HashMap<u32, Arc<Mutex<Entry>>>>>;

/// One connection's speed state, per handle.
pub struct Speeds {
    owner: Arc<Owner>,
    patches: Arc<Patches>,
    map: Map,
}

impl Speeds {
    pub fn new(owner: Arc<Owner>, patches: Arc<Patches>) -> Self {
        Speeds { owner, patches, map: Map::default() }
    }

    /// Set `handle`'s game speed. Orphaned hooks are recovered first (D12). The first non-1.0
    /// speed hooks `targets` (debug builds) or the discovered ones; later speeds only change the
    /// speed; 1.0 removes every hook.
    pub fn set(&self, handle: u32, t: &Arc<Target>, speed: f64, targets: Option<Vec<HookTarget>>) -> Result<Status, RpcError> {
        if !speed.is_finite() || !(MIN_SPEED..=MAX_SPEED).contains(&speed) {
            return Err(RpcError::invalid_params(format!("speed must be between {MIN_SPEED} and {MAX_SPEED}, got {speed}")));
        }
        recover_orphans(t)?;
        let existing = self.map.lock().unwrap().get(&handle).cloned();
        if speed == 1.0 && existing.is_none() {
            return Ok(Status { speed, hooks: vec![] });
        }
        let entry = existing.unwrap_or_else(|| self.entry(handle, t));
        let mut e = entry.lock().unwrap();
        if e.dead {
            return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
        }
        if speed == 1.0 {
            self.revert(&mut e)?;
            return Ok(e.status());
        }
        let tracer = t.tracer()?;
        if let (Some(state), false) = (e.state, e.installed.is_empty()) {
            e.gen = write_speed(t, &tracer, state, speed, e.gen)?;
            e.speed = speed;
            return Ok(e.status());
        }
        let state = match e.state {
            Some(s) => s,
            None => {
                let s = new_state_page(t)?;
                e.state = Some(s);
                s
            }
        };
        if !claim(t.pid, state) {
            return Err(RpcError::patch_conflict("another session already controls this game's speed"));
        }
        // No hook is live: start every clock afresh (slots, nesting table, empty record).
        mem::write_bytes(t, state + tpl::OFF_SLOTS, &vec![0; (tpl::OFF_RECOVERY + 4 - tpl::OFF_SLOTS) as usize])?;
        e.gen = write_speed(t, &tracer, state, speed, e.gen)?;
        let targets = match targets {
            Some(v) => v,
            None => targets::native(t, &modules::list(t)?),
        };
        let mut hooks = vec![];
        let mut hard_error = None;
        for tg in &targets {
            let skipped = match self.install(handle, t, &tracer, state, &mut e, tg) {
                Ok(()) => None,
                Err(HookError::Skipped(reason)) => Some(reason),
                Err(HookError::Rpc(err)) => {
                    let reason = err.message.clone();
                    hard_error.get_or_insert(err);
                    Some(reason)
                }
            };
            hooks.push(HookReport { name: tg.name.clone(), address: tg.address, skipped });
        }
        if e.installed.is_empty() {
            unclaim(t.pid, state);
            if let Some(err) = hard_error {
                return Err(err);
            }
            let why = if hooks.is_empty() {
                "no clock_gettime or gettimeofday found".to_string()
            } else {
                hooks.iter().map(|h| format!("{}: {}", h.name, h.skipped.as_deref().unwrap_or(""))).collect::<Vec<_>>().join("; ")
            };
            return Err(RpcError::invalid_params(format!("this game's timing functions can't be hooked: {why}")));
        }
        e.speed = speed;
        e.hooks = hooks;
        Ok(e.status())
    }

    /// `handle`'s speed and hooks, after recovering orphaned hooks (D12).
    pub fn get(&self, handle: u32, t: &Target) -> Result<Status, RpcError> {
        recover_orphans(t)?;
        let entry = self.map.lock().unwrap().get(&handle).cloned();
        Ok(match entry {
            Some(e) => e.lock().unwrap().status(),
            None => Status { speed: 1.0, hooks: vec![] },
        })
    }

    /// Undo everything for `handle` now (its handle went away while `set` ran).
    pub fn release(&self, handle: u32) {
        let Some(entry) = self.map.lock().unwrap().get(&handle).cloned() else { return };
        let token = entry.lock().unwrap().token.take();
        teardown(&self.map, &self.patches, handle, &entry);
        if let Some(token) = token {
            self.owner.remove(token);
        }
    }

    /// A new entry for `handle`, with its session-end teardown registered. Registered with no
    /// lock held: if the session is already over, the teardown runs at once and marks it dead.
    fn entry(&self, handle: u32, t: &Arc<Target>) -> Arc<Mutex<Entry>> {
        let entry = {
            let mut m = self.map.lock().unwrap();
            if let Some(e) = m.get(&handle) {
                return e.clone();
            }
            let e = Arc::new(Mutex::new(Entry {
                target: t.clone(),
                state: None,
                speed: 1.0,
                gen: 0,
                installed: vec![],
                hooks: vec![],
                token: None,
                dead: false,
            }));
            m.insert(handle, e.clone());
            e
        };
        let (map, patches, en) = (self.map.clone(), self.patches.clone(), entry.clone());
        // Kind `Patch`, registered before any hook: the hooks' own patch teardowns are newer, so
        // they run first, and this one then keeps in the record whatever they couldn't restore.
        let token = self.owner.add(Some(handle), Teardown::Patch, Box::new(move || teardown(&map, &patches, handle, &en)));
        let mut e = entry.lock().unwrap();
        if !e.dead {
            e.token = Some(token);
        }
        drop(e);
        entry
    }

    fn install(&self, handle: u32, t: &Arc<Target>, tracer: &Arc<Tracer>, state: u64, e: &mut Entry, tg: &HookTarget) -> Result<(), HookError> {
        if tpl::last_slot(tg.kind, tg.slot) >= tpl::SLOT_COUNT {
            return Err(HookError::Skipped(format!("clock slot {} is out of range", tg.slot)));
        }
        match tg.kind {
            Kind::GettimeofdayGot => self.install_got(handle, t, tracer, state, e, tg),
            _ => self.install_inline(handle, t, tracer, state, e, tg),
        }
    }

    /// An inline hook. Its original bytes are recorded before the entry jump is written.
    fn install_inline(&self, handle: u32, t: &Arc<Target>, tracer: &Arc<Tracer>, state: u64, e: &mut Entry, tg: &HookTarget) -> Result<(), HookError> {
        let original = hook::entry_bytes(t, tg.address)?;
        if original.len() > tpl::RECOVERY_ORIGINAL_MAX {
            return Err(HookError::Skipped(format!(
                "the entry jump would displace {} bytes; at most {} can be recorded",
                original.len(),
                tpl::RECOVERY_ORIGINAL_MAX
            )));
        }
        record_push(t, state, e, tg.address, &original)?;
        let body = |tramp| tpl::hook_source(tg.kind, tg.abi, state, tg.slot, tramp);
        match hook::install(t, tracer, &self.patches, handle, tg.address, &body) {
            Ok(h) => {
                let changed = h.displaced != original;
                e.installed.push(Installed { patch_id: h.patch_id, addr: tg.address, original: h.displaced });
                if changed {
                    write_record(t, state, &e.installed)?;
                }
                Ok(())
            }
            Err(err) => {
                let _ = write_record(t, state, &e.installed);
                Err(err)
            }
        }
    }

    /// One hook page for `gettimeofday`, and every GOT slot that imports it pointed at it (D16).
    fn install_got(&self, handle: u32, t: &Arc<Target>, tracer: &Arc<Tracer>, state: u64, e: &mut Entry, tg: &HookTarget) -> Result<(), HookError> {
        let original = tg.original.ok_or_else(|| HookError::Skipped("no __vdso_gettimeofday to call".into()))?;
        if tg.got_slots.is_empty() {
            return Err(HookError::Skipped(format!("no loaded module calls {} through its GOT", tg.name)));
        }
        let page = remote::alloc(t, PAGE, None, RWX)?;
        let src = tpl::hook_source(tg.kind, tg.abi, state, tg.slot, original);
        let code = asm::assemble(&src, page, &|_| None).map_err(|err| RpcError::assemble_failed(err.to_string()))?;
        mem::write_bytes(t, page, &code.bytes)?;
        let hook = page.to_le_bytes();
        let mut failure = None;
        let before = e.installed.len();
        for &slot in &tg.got_slots {
            let current = match mem::read_bytes(t, slot, 8) {
                Ok(c) if c != hook => c,
                Ok(_) => continue,
                Err(err) => {
                    failure = Some(err.into());
                    continue;
                }
            };
            if let Err(err) = record_push(t, state, e, slot, &current) {
                failure = Some(err);
                break;
            }
            match self.patches.apply_with(handle, t, tracer.clone(), slot, &hook, Some(&current)) {
                Ok((patch_id, _)) => e.installed.push(Installed { patch_id, addr: slot, original: current }),
                Err(err) => {
                    let _ = write_record(t, state, &e.installed);
                    failure = Some(match err {
                        ApplyError::Changed(_) => HookError::Skipped(format!("the GOT slot at {slot:#x} changed while hooking")),
                        other => HookError::Rpc(other.into()),
                    });
                }
            }
        }
        if e.installed.len() > before {
            return Ok(());
        }
        Err(failure.unwrap_or_else(|| HookError::Skipped("every GOT slot already points at a hook".into())))
    }

    /// Remove every hook, newest first. A hook whose patch the session's teardown already
    /// reverted counts as removed.
    fn revert(&self, e: &mut Entry) -> Result<(), RpcError> {
        while let Some(last) = e.installed.last() {
            match self.patches.revert(last.patch_id, false) {
                Ok(()) => {}
                Err(err) if err.code == -32009 => {}
                Err(err) => return Err(err),
            }
            e.installed.pop();
            if let Some(state) = e.state {
                let _ = write_count(&e.target, state, e.installed.len());
            }
        }
        if let Some(state) = e.state {
            unclaim(e.target.pid, state);
        }
        e.speed = 1.0;
        e.hooks.clear();
        Ok(())
    }
}

/// Session end for `handle`: revert its hooks (newest first), keep in the recovery record only
/// what is still not restored, and let orphan recovery see the page again.
fn teardown(map: &Map, patches: &Patches, handle: u32, entry: &Arc<Mutex<Entry>>) {
    let mut e = entry.lock().unwrap();
    if !e.dead {
        e.dead = true;
        for i in e.installed.iter().rev() {
            let _ = patches.revert(i.patch_id, false);
        }
        let t = e.target.clone();
        let left: Vec<Installed> = std::mem::take(&mut e.installed)
            .into_iter()
            .filter(|i| mem::read_bytes(&t, i.addr, i.original.len()).is_ok_and(|now| now != i.original))
            .collect();
        if let Some(state) = e.state {
            let _ = write_record(&t, state, &left);
            unclaim(t.pid, state);
        }
        e.speed = 1.0;
        e.hooks.clear();
    }
    drop(e);
    let mut m = map.lock().unwrap();
    if m.get(&handle).is_some_and(|x| Arc::ptr_eq(x, entry)) {
        m.remove(&handle);
    }
}

/// Write `speed`, then the next generation, in one write with the game stopped (so no thread
/// reads a torn value). Returns the new generation (never 0: 0 marks unused slots).
fn write_speed(t: &Target, tracer: &Tracer, state: u64, speed: f64, gen: u32) -> Result<u32, RpcError> {
    let gen = gen.wrapping_add(1).max(1);
    let mut b = speed.to_le_bytes().to_vec();
    b.extend_from_slice(&gen.to_le_bytes());
    patch::write_code(t, tracer, state + tpl::OFF_SPEED, &b)?;
    Ok(gen)
}

/// A new state page: magic, zeroed state (an empty record), the shared routines.
fn new_state_page(t: &Target) -> Result<u64, RpcError> {
    let page = remote::alloc(t, STATE_PAGE_SIZE, None, RWX)?;
    let image = state_image(page).and_then(|img| mem::write_bytes(t, page, &img));
    if let Err(err) = image {
        // Nothing can have run in it yet.
        let _ = remote::free(t, page, STATE_PAGE_SIZE);
        return Err(err);
    }
    Ok(page)
}

fn state_image(page: u64) -> Result<Vec<u8>, RpcError> {
    let mut img = vec![0u8; STATE_PAGE_SIZE as usize];
    img[tpl::OFF_MAGIC as usize..][..8].copy_from_slice(&MAGIC);
    for (off, src) in tpl::shared_routines(page) {
        let a = asm::assemble(&src, page + off, &|_| None).map_err(|e| RpcError::assemble_failed(e.to_string()))?;
        if a.bytes.len() as u64 > tpl::ROUTINE_MAX {
            return Err(RpcError::internal_error(format!("speed routine at {off:#x} is too large")));
        }
        img[off as usize..off as usize + a.bytes.len()].copy_from_slice(&a.bytes);
    }
    Ok(img)
}

fn record_entry(addr: u64, original: &[u8]) -> [u8; tpl::RECOVERY_ENTRY as usize] {
    let mut b = [0u8; tpl::RECOVERY_ENTRY as usize];
    b[..8].copy_from_slice(&addr.to_le_bytes());
    b[8] = original.len() as u8;
    b[16..16 + original.len()].copy_from_slice(original);
    b
}

fn write_count(t: &Target, state: u64, n: usize) -> Result<(), RpcError> {
    mem::write_bytes(t, state + tpl::OFF_RECOVERY, &(n as u32).to_le_bytes())
}

/// Append one entry to the recovery record, before the change it describes is made: the entry
/// first, then the count, so a daemon killed at any point leaves a record that covers every live
/// change (restoring an entry whose change never happened rewrites the same bytes).
fn record_push(t: &Target, state: u64, e: &Entry, addr: u64, original: &[u8]) -> Result<(), HookError> {
    let n = e.installed.len();
    if n >= tpl::RECOVERY_MAX {
        return Err(HookError::Skipped(format!("at most {} speed hooks per game", tpl::RECOVERY_MAX)));
    }
    mem::write_bytes(t, state + tpl::OFF_RECOVERY_ENTRIES + n as u64 * tpl::RECOVERY_ENTRY, &record_entry(addr, original))?;
    write_count(t, state, n + 1)?;
    Ok(())
}

/// Rewrite the whole recovery record as `installed`.
fn write_record(t: &Target, state: u64, installed: &[Installed]) -> Result<(), RpcError> {
    let entries: Vec<u8> = installed.iter().flat_map(|i| record_entry(i.addr, &i.original)).collect();
    mem::write_bytes(t, state + tpl::OFF_RECOVERY_ENTRIES, &entries)?;
    write_count(t, state, installed.len())
}

/// Parse a recovery record (`count` then the entries) into (address, original bytes), or `None`
/// if it isn't a valid one.
fn parse_record(rec: &[u8]) -> Option<Vec<(u64, Vec<u8>)>> {
    let count = u32::from_le_bytes(rec.get(..4)?.try_into().ok()?) as usize;
    if count > tpl::RECOVERY_MAX {
        return None;
    }
    let base = (tpl::OFF_RECOVERY_ENTRIES - tpl::OFF_RECOVERY) as usize;
    (0..count)
        .map(|i| {
            let e = rec.get(base + i * tpl::RECOVERY_ENTRY as usize..base + (i + 1) * tpl::RECOVERY_ENTRY as usize)?;
            let addr = u64::from_le_bytes(e[..8].try_into().ok()?);
            let len = e[8] as usize;
            (1..=tpl::RECOVERY_ORIGINAL_MAX).contains(&len).then(|| (addr, e[16..16 + len].to_vec()))
        })
        .collect()
}

/// D12: find state pages with the magic that this daemon isn't using (R6) and restore their
/// recorded bytes, newest first, then empty their record. A page whose hooks another daemon
/// still holds can't be restored: that daemon keeps the game traced, so the attach fails.
pub fn recover_orphans(t: &Target) -> Result<(), RpcError> {
    let regions = maps::read(t.pid).map_err(|e| RpcError::process_not_found(format!("cannot read maps of {}: {e}", t.pid)))?;
    let mut tracer: Option<Arc<Tracer>> = None;
    for r in regions {
        let size = r.end - r.start;
        let anon_rwx = r.perms.read && r.perms.write && r.perms.exec && !r.perms.shared && r.path.is_none();
        if !anon_rwx || !(STATE_PAGE_SIZE..=ORPHAN_SCAN_MAX).contains(&size) {
            continue;
        }
        for page in (r.start..=r.end - STATE_PAGE_SIZE).step_by(PAGE as usize) {
            if mem::read_bytes(t, page, 8).ok().as_deref() != Some(&MAGIC[..]) || is_live(t.pid, page) {
                continue;
            }
            let rec_len = (tpl::OFF_RECOVERY_ENTRIES - tpl::OFF_RECOVERY + tpl::RECOVERY_ENTRY * tpl::RECOVERY_MAX as u64) as usize;
            let Some(entries) = mem::read_bytes(t, page + tpl::OFF_RECOVERY, rec_len).ok().and_then(|b| parse_record(&b)) else {
                continue;
            };
            for (addr, original) in entries.iter().rev() {
                // Gone (e.g. its library was unloaded) or already restored: nothing to do.
                let Ok(now) = mem::read_bytes(t, *addr, original.len()) else { continue };
                if now == *original {
                    continue;
                }
                let tr = match &tracer {
                    Some(tr) => tr.clone(),
                    None => tracer.insert(t.tracer()?).clone(),
                };
                patch::write_code(t, &tr, *addr, original)?;
            }
            if !entries.is_empty() {
                write_count(t, page, 0)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_and_abi_names() {
        for (s, k) in [
            ("qpc", Kind::Qpc),
            ("tick32", Kind::Tick32),
            ("tick64", Kind::Tick64),
            ("clock_gettime", Kind::ClockGettime),
            ("gettimeofday", Kind::Gettimeofday),
            ("gettimeofday_got", Kind::GettimeofdayGot),
        ] {
            assert_eq!(Kind::parse(s), Some(k));
        }
        assert_eq!(Kind::parse("QPC"), None);
        assert_eq!((Abi::parse("win64"), Abi::parse("sysv"), Abi::parse("x")), (Some(Abi::Win64), Some(Abi::Sysv), None));
    }

    #[test]
    fn state_image_has_magic_and_routines() {
        let page = 0x7f00_1234_0000;
        let img = state_image(page).unwrap();
        assert_eq!(img.len() as u64, STATE_PAGE_SIZE);
        assert_eq!(&img[..8], b"STLSPD01");
        assert!(img[8..tpl::OFF_CODE as usize].iter().all(|&b| b == 0), "state starts zeroed");
        for off in [tpl::OFF_SCALE, tpl::OFF_GUARD_ENTER, tpl::OFF_GUARD_LEAVE] {
            assert_ne!(img[off as usize], 0, "no routine at {off:#x}");
        }
    }

    #[test]
    fn recovery_record_round_trips_and_rejects_garbage() {
        let mut rec = vec![0u8; 8 + 32 * 32];
        let put = |rec: &mut Vec<u8>, i: usize, addr: u64, orig: &[u8]| {
            rec[8 + i * 32..8 + (i + 1) * 32].copy_from_slice(&record_entry(addr, orig));
        };
        put(&mut rec, 0, 0x7f00_0000_1000, &[0xf3, 0x0f, 0x1e, 0xfa, 0x48]);
        put(&mut rec, 1, 0x404028, &0x7ffd_0000_1234u64.to_le_bytes());
        rec[..4].copy_from_slice(&2u32.to_le_bytes());
        let got = parse_record(&rec).unwrap();
        assert_eq!(got, vec![(0x7f00_0000_1000, vec![0xf3, 0x0f, 0x1e, 0xfa, 0x48]), (0x404028, 0x7ffd_0000_1234u64.to_le_bytes().to_vec())]);
        rec[..4].copy_from_slice(&33u32.to_le_bytes());
        assert_eq!(parse_record(&rec), None, "count beyond capacity");
        rec[..4].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(parse_record(&rec), None, "an entry with length 0");
    }
}
