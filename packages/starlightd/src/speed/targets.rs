//! Which timing functions to hook: in a Proton game (D15) or a native Linux one (D16), and their
//! clock slots (D14).
use super::{Abi, Kind};
use crate::maps;
use crate::modules::{self, Kind as ModKind, Module};
use crate::process::Target;
use crate::symbols::{self, Export, Reader, SymKind};
use iced_x86::{Decoder, DecoderOptions, Mnemonic, OpKind, Register};

/// Clock slots (D14). `clock_gettime` uses `SLOT_CLOCK + id` for ids 0–7.
pub const SLOT_CLOCK: u32 = 0;
pub const SLOT_GETTIMEOFDAY: u32 = 8;
/// QPC, RtlQPC and NtQueryPerformanceCounter share one counter.
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
    /// Not to be hooked, with the reason (e.g. the same function as an earlier target).
    pub skipped: Option<String>,
}

/// The slot a target of `kind` named `name` uses when nothing else says (debug `targets`).
pub fn default_slot(kind: Kind, name: &str) -> u32 {
    match kind {
        Kind::ClockGettime => SLOT_CLOCK,
        Kind::Gettimeofday | Kind::GettimeofdayGot => SLOT_GETTIMEOFDAY,
        Kind::Qpc | Kind::NtQpc => SLOT_QPC,
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
        skipped: None,
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

/// The Windows timing functions of a Proton game (D15), in order: (module, export, kind).
/// winmm is only there if the game loaded it.
const WINE: [(&str, &str, Kind); 6] = [
    ("ntdll.dll", "RtlQueryPerformanceCounter", Kind::Qpc),
    ("ntdll.dll", "NtQueryPerformanceCounter", Kind::NtQpc),
    ("kernel32.dll", "QueryPerformanceCounter", Kind::Qpc),
    ("kernel32.dll", "GetTickCount", Kind::Tick32),
    ("kernel32.dll", "GetTickCount64", Kind::Tick64),
    ("winmm.dll", "timeGetTime", Kind::Tick32),
];

/// Most import thunks `follow_thunks` goes through.
const MAX_THUNKS: usize = 4;

/// Where the code at `addr` really is: an import thunk (`jmp qword ptr [rip+imp]`, or a
/// `jmp rel32`, optionally after hot-patch padding such as Wine's `lea rsp,[rsp+0]`) is followed
/// to its target. Wine builds kernel32's `QueryPerformanceCounter` and winmm's `timeGetTime` this
/// way; the thunk itself can't be hooked (its jump would be displaced) and isn't the function the
/// other names lead to.
fn follow_thunks(read: Reader, mut addr: u64) -> u64 {
    'hop: for _ in 0..MAX_THUNKS {
        let Some(code) = read(addr, 16) else { return addr };
        for i in Decoder::with_ip(64, &code, addr, DecoderOptions::NONE).iter() {
            let padding = i.mnemonic() == Mnemonic::Nop
                || (i.mnemonic() == Mnemonic::Lea
                    && i.op0_register() == Register::RSP
                    && i.memory_base() == Register::RSP
                    && i.memory_index() == Register::None
                    && i.memory_displacement64() == 0)
                || (i.mnemonic() == Mnemonic::Mov && i.op0_register() == Register::EDI && i.op1_kind() == OpKind::Register && i.op1_register() == Register::EDI);
            if padding {
                continue;
            }
            if i.mnemonic() != Mnemonic::Jmp {
                return addr;
            }
            let next = if i.is_ip_rel_memory_operand() {
                read(i.ip_rel_memory_address(), 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
            } else if i.op0_kind() == OpKind::NearBranch64 {
                Some(i.near_branch_target())
            } else {
                None
            };
            match next {
                Some(n) if n != 0 => {
                    addr = n;
                    continue 'hop;
                }
                _ => return addr,
            }
        }
        return addr;
    }
    addr
}

/// Proton targets (D15): each name resolved through export forwarders and import thunks, in the
/// order of `WINE`. Names that resolve to an address an earlier name already has are listed
/// `skipped: "same function as <name>"` (one function can be hooked once). Names that can't be
/// found, and timeGetTime when winmm isn't loaded, are left out.
pub fn wine(read: &dyn Fn(u64, usize) -> Option<Vec<u8>>, mods: &[Module]) -> Vec<HookTarget> {
    let mut out: Vec<HookTarget> = vec![];
    for (module, name, kind) in WINE {
        let Ok(found) = symbols::resolve_with(read, mods, module, name) else { continue };
        let address = follow_thunks(read, found);
        let skipped = out.iter().find(|h| h.address == address && h.skipped.is_none()).map(|first| format!("same function as {}", first.name));
        out.push(HookTarget {
            name: name.into(),
            address,
            abi: Abi::Win64,
            kind,
            slot: default_slot(kind, name),
            original: None,
            got_slots: vec![],
            skipped,
        });
    }
    out
}

/// The targets for a process: Proton's when a PE `ntdll.dll` is mapped (then the Linux libc,
/// Wine's own, is not hooked: it would scale time twice), else the native ones.
pub fn discover(t: &Target, mods: &[Module]) -> Vec<HookTarget> {
    match modules::find(mods, "ntdll.dll") {
        Some(m) if m.kind == ModKind::Pe => wine(&|addr, len| crate::mem::read_bytes(t, addr, len).ok(), mods),
        _ => native(t, mods),
    }
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

    fn pe_module(name: &str, base: u64) -> Module {
        Module { name: name.into(), base, size: 0x1000, path: format!("/x/{name}"), kind: ModKind::Pe }
    }

    /// `(name, address, kind, slot, skipped)` of each target.
    fn summary(v: &[HookTarget]) -> Vec<(String, u64, Kind, u32, Option<String>)> {
        v.iter().map(|h| (h.name.clone(), h.address, h.kind, h.slot, h.skipped.clone())).collect()
    }

    #[test]
    fn wine_target_selection_follows_forwarders_and_dedupes() {
        use crate::symbols::tests::{pe, reader};
        let (ntdll, k32) = (0x10_0000u64, 0x20_0000u64);
        let mut nt = pe(&[("NtQueryPerformanceCounter", 0xc00), ("RtlQueryPerformanceCounter", 0xc40)], &[]);
        // NtQPC: `mov r10, rcx; mov eax, 31h` (a syscall stub); RtlQPC: `push rbp`.
        nt[0xc00..0xc08].copy_from_slice(&[0x4c, 0x8b, 0xd1, 0xb8, 0x31, 0, 0, 0]);
        nt[0xc40] = 0x55;
        let k = pe(
            &[("GetTickCount", 0xc00), ("GetTickCount64", 0xc40), ("QueryPerformanceCounter", 0x300)],
            &[(0x300, "NTDLL.RtlQueryPerformanceCounter")],
        );
        let read = reader(vec![(ntdll, nt), (k32, k)]);
        let mods = [pe_module("ntdll.dll", ntdll), pe_module("KERNEL32.dll", k32)];
        let got = wine(&read, &mods);
        assert!(got.iter().all(|h| h.abi == Abi::Win64 && h.original.is_none() && h.got_slots.is_empty()), "{got:?}");
        assert_eq!(
            summary(&got),
            vec![
                ("RtlQueryPerformanceCounter".into(), ntdll + 0xc40, Kind::Qpc, SLOT_QPC, None),
                ("NtQueryPerformanceCounter".into(), ntdll + 0xc00, Kind::NtQpc, SLOT_QPC, None),
                (
                    "QueryPerformanceCounter".into(),
                    ntdll + 0xc40,
                    Kind::Qpc,
                    SLOT_QPC,
                    Some("same function as RtlQueryPerformanceCounter".into())
                ),
                ("GetTickCount".into(), k32 + 0xc00, Kind::Tick32, SLOT_TICK_COUNT, None),
                ("GetTickCount64".into(), k32 + 0xc40, Kind::Tick64, SLOT_TICK_COUNT64, None),
            ],
            "no winmm loaded, so no timeGetTime"
        );
    }

    #[test]
    fn wine_import_thunks_are_followed_to_the_function() {
        // Proton 11: kernel32's QueryPerformanceCounter is `lea rsp,[rsp+0]; jmp [rip+imp]` into
        // its import table (filled with ntdll's RtlQPC), and winmm's timeGetTime is
        // `jmp [rip+imp]` into kernel32's timeGetTime.
        use crate::symbols::tests::{pe, put, reader};
        let (ntdll, k32, winmm) = (0x10_0000u64, 0x20_0000u64, 0x30_0000u64);
        let mut nt = pe(&[("RtlQueryPerformanceCounter", 0xc40), ("NtQueryPerformanceCounter", 0xc00)], &[]);
        nt[0xc40] = 0x55;
        nt[0xc00..0xc03].copy_from_slice(&[0x4c, 0x8b, 0xd1]);
        let mut k = pe(&[("QueryPerformanceCounter", 0xc80), ("GetTickCount", 0xc00), ("timeGetTime", 0xd00)], &[]);
        let jmp_rip = |at: u64, len: u64, slot: u64| ((slot as i64 - (at + len) as i64) as i32).to_le_bytes();
        put(&mut k, 0xc80, &[0x48, 0x8d, 0xa4, 0x24, 0, 0, 0, 0, 0xff, 0x25]);
        put(&mut k, 0xc8a, &jmp_rip(k32 + 0xc88, 6, k32 + 0xf00));
        put(&mut k, 0xf00, &(ntdll + 0xc40).to_le_bytes());
        k[0xc00] = 0x55;
        k[0xd00] = 0x55;
        let mut w = pe(&[("timeGetTime", 0xc00)], &[]);
        put(&mut w, 0xc00, &[0xff, 0x25]);
        put(&mut w, 0xc02, &jmp_rip(winmm + 0xc00, 6, winmm + 0xf00));
        put(&mut w, 0xf00, &(k32 + 0xd00).to_le_bytes());
        let read = reader(vec![(ntdll, nt), (k32, k), (winmm, w)]);
        let mods = [pe_module("ntdll.dll", ntdll), pe_module("kernel32.dll", k32), pe_module("winmm.dll", winmm)];
        let got = summary(&wine(&read, &mods));
        let qpc = got.iter().find(|h| h.0 == "QueryPerformanceCounter").unwrap();
        assert_eq!((qpc.1, qpc.4.as_deref()), (ntdll + 0xc40, Some("same function as RtlQueryPerformanceCounter")));
        let tgt = got.iter().find(|h| h.0 == "timeGetTime").unwrap();
        assert_eq!((tgt.1, tgt.2, tgt.3, tgt.4.clone()), (k32 + 0xd00, Kind::Tick32, SLOT_TIME_GET_TIME, None));
        // GetTickCount64 isn't exported here: left out.
        assert!(!got.iter().any(|h| h.0 == "GetTickCount64"), "{got:?}");
    }

    #[test]
    fn native_process_without_ntdll_uses_native_targets() {
        // The C test target, launched here; never any other process.
        let tt = TestTarget::spawn(&[]);
        let t = open_target(tt.pid()).unwrap();
        let mut mods = crate::modules::list(&t).unwrap();
        let native = discover(&t, &mods);
        assert!(native.iter().any(|h| h.name == "clock_gettime" && h.abi == Abi::Sysv), "{native:?}");
        // A PE ntdll.dll in the module list means Wine: the Linux libc is left alone (D15). This
        // one has no readable exports, so there is nothing to hook.
        mods.push(pe_module("ntdll.dll", 0x1000));
        assert_eq!(discover(&t, &mods), vec![]);
    }
}
