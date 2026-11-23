//! Which timing functions to hook in a native Linux game (D16), and their clock slots (D14).
use super::{Abi, Kind};
use crate::maps;
use crate::modules::{Kind as ModKind, Module};
use crate::process::Target;
use crate::symbols::{self, Export, SymKind};

/// Clock slots (D14). `clock_gettime` uses `SLOT_CLOCK + id` for ids 0–7.
pub const SLOT_CLOCK: u32 = 0;
pub const SLOT_GETTIMEOFDAY: u32 = 8;
/// QPC and NtQueryPerformanceCounter share one counter.
pub const SLOT_QPC: u32 = 9;
pub const SLOT_TICK_COUNT: u32 = 10;
pub const SLOT_TICK_COUNT64: u32 = 11;
pub const SLOT_TIME_GET_TIME: u32 = 12;

#[derive(Debug, Clone, PartialEq)]
pub struct HookTarget {
    pub name: String,
    pub address: u64,
    pub abi: Abi,
    pub kind: Kind,
    pub slot: u32,
    /// `GettimeofdayGot` only: the function the hook calls (`__vdso_gettimeofday`).
    pub original: Option<u64>,
    /// `GettimeofdayGot` only: the GOT slots to point at the hook.
    pub got_slots: Vec<u64>,
}

/// The slot a target of `kind` named `name` uses when nothing else says (debug `targets`).
pub fn default_slot(kind: Kind, name: &str) -> u32 {
    match kind {
        Kind::ClockGettime => SLOT_CLOCK,
        Kind::Gettimeofday | Kind::GettimeofdayGot => SLOT_GETTIMEOFDAY,
        Kind::Qpc => SLOT_QPC,
        Kind::Tick32 if name.eq_ignore_ascii_case("timeGetTime") => SLOT_TIME_GET_TIME,
        Kind::Tick32 => SLOT_TICK_COUNT,
        Kind::Tick64 => SLOT_TICK_COUNT64,
    }
}

/// glibc's `libc.so.6` or musl's `ld-musl-x86_64.so.1`: the module that exports `clock_gettime`.
fn is_libc(m: &Module) -> bool {
    m.kind == ModKind::Elf && (m.name.starts_with("libc.so") || m.name.starts_with("libc-") || m.name.starts_with("ld-musl"))
}

/// The `[vdso]` image as a module (it has no file path, so `modules::list` leaves it out).
fn vdso(t: &Target) -> Option<Module> {
    let r = maps::read(t.pid).ok()?.into_iter().find(|r| r.path.as_deref() == Some("[vdso]"))?;
    Some(Module { name: "[vdso]".into(), base: r.start, size: r.end - r.start, path: "[vdso]".into(), kind: ModKind::Elf })
}

fn find<'a>(exports: &'a [Export], name: &str) -> Option<&'a Export> {
    exports.iter().find(|e| e.name == name && matches!(e.kind, SymKind::Func | SymKind::Ifunc))
}

/// Native targets (D16): an inline hook on libc's `clock_gettime`; `gettimeofday` inline if it
/// is a plain function, else (an IFUNC that glibc resolves straight to the vDSO) its GOT slots in
/// every loaded module, pointed at a hook that calls `__vdso_gettimeofday`. The vDSO is only read.
/// Functions that can't be found are left out.
pub fn native(t: &Target, mods: &[Module]) -> Vec<HookTarget> {
    let mut out = vec![];
    let Some(exports) = mods.iter().filter(|m| is_libc(m)).find_map(|m| {
        let e = symbols::exports(t, m).ok()?;
        find(&e, "clock_gettime").is_some().then_some(e)
    }) else {
        return out;
    };
    let target = |name: &str, address, kind, original, got_slots| HookTarget {
        name: name.into(),
        address,
        abi: Abi::Sysv,
        kind,
        slot: default_slot(kind, name),
        original,
        got_slots,
    };
    if let Some(e) = find(&exports, "clock_gettime").filter(|e| e.kind == SymKind::Func) {
        out.push(target("clock_gettime", e.address, Kind::ClockGettime, None, vec![]));
    }
    match find(&exports, "gettimeofday") {
        Some(e) if e.kind == SymKind::Func => out.push(target("gettimeofday", e.address, Kind::Gettimeofday, None, vec![])),
        Some(e) => {
            let vdso_fn = vdso(t).and_then(|v| {
                let ex = symbols::exports(t, &v).ok()?;
                find(&ex, "__vdso_gettimeofday").or_else(|| find(&ex, "gettimeofday")).map(|e| e.address)
            });
            if let Some(original) = vdso_fn {
                let mut slots: Vec<u64> = mods
                    .iter()
                    .filter(|m| m.kind == ModKind::Elf)
                    .flat_map(|m| symbols::got_slots(t, m, "gettimeofday").unwrap_or_default())
                    .collect();
                slots.sort_unstable();
                slots.dedup();
                out.push(target("gettimeofday", e.address, Kind::GettimeofdayGot, Some(original), slots));
            }
        }
        None => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::open_target;
    use crate::tracer::tests::TestTarget;

    #[test]
    fn slots_are_distinct_per_clock_domain() {
        let all = [
            default_slot(Kind::Gettimeofday, "gettimeofday"),
            default_slot(Kind::Qpc, "QueryPerformanceCounter"),
            default_slot(Kind::Tick32, "GetTickCount"),
            default_slot(Kind::Tick32, "timeGetTime"),
            default_slot(Kind::Tick64, "GetTickCount64"),
        ];
        for (i, a) in all.iter().enumerate() {
            assert!(*a >= SLOT_CLOCK + 8, "clock ids 0-7 own slots 0-7");
            assert!(all[i + 1..].iter().all(|b| b != a), "{all:?}");
        }
        assert_eq!(default_slot(Kind::GettimeofdayGot, "gettimeofday"), SLOT_GETTIMEOFDAY);
        assert_eq!(default_slot(Kind::Qpc, "NtQueryPerformanceCounter"), SLOT_QPC, "QPC and NtQPC share a slot");
    }

    #[test]
    fn native_targets_of_the_test_target() {
        // The C test target, launched here; never any other process.
        let tt = TestTarget::spawn(&[]);
        let t = open_target(tt.pid()).unwrap();
        let mods = crate::modules::list(&t).unwrap();
        let targets = native(&t, &mods);
        let cg = targets.iter().find(|h| h.name == "clock_gettime").expect("clock_gettime");
        assert_eq!((cg.kind, cg.abi, cg.address, cg.slot), (Kind::ClockGettime, Abi::Sysv, tt.addrs["libc_clock_gettime"], SLOT_CLOCK));
        let tod = targets.iter().find(|h| h.name == "gettimeofday").expect("gettimeofday");
        assert_eq!(tod.slot, SLOT_GETTIMEOFDAY);
        let libc = mods.iter().find(|m| is_libc(m)).unwrap();
        let kind = symbols::exports(&t, libc).unwrap().into_iter().find(|e| e.name == "gettimeofday").unwrap().kind;
        if kind == SymKind::Ifunc {
            // glibc x86-64: the GOT route, calling the vDSO's function.
            assert_eq!(tod.kind, Kind::GettimeofdayGot);
            let v = vdso(&t).unwrap();
            let orig = tod.original.unwrap();
            assert!(orig >= v.base && orig < v.base + v.size, "{orig:#x} is not in the vDSO");
            // The executable imports gettimeofday through its GOT (the -no-pie image is below 4 GiB).
            assert!(tod.got_slots.iter().any(|&s| s < 1 << 32), "{:x?}", tod.got_slots);
        } else {
            assert_eq!((tod.kind, tod.original), (Kind::Gettimeofday, None));
        }
    }
}
