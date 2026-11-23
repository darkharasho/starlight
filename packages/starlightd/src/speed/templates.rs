//! Speed hook code as CE-style Intel text for `asm::assemble` (D11, D13), and the state page
//! layout it works on. Numbers in the text are hex unless written `#decimal`.
//!
//! # Calling convention of the shared routines
//!
//! `scale`, `guard_enter` and `guard_leave` live in the state page at fixed offsets and use their
//! own convention, valid under both ABIs: arguments in `rcx`, `rdx`, `r8`; result in `rax`; they
//! clobber only `rax`, `rcx`, `rdx`, `r8`–`r11`, `xmm0` and flags (volatile under Win64 and SysV).
//! Every routine takes the calling thread's key (its thread pointer) in `rcx`.
//!
//! # Lock and nesting guard
//!
//! The spinlock word holds an owner tag (the low 32 bits of the thread key, or-ed with 1). A thread
//! that finds the lock held under its own tag was interrupted while holding it, by a signal
//! handler that called a hooked function: spinning would deadlock, so `guard_enter` reports
//! "not entered" and the hook passes the call through unscaled. `scale` only runs between a
//! successful `guard_enter` and its `guard_leave`, so a handler can never reach it while its own
//! thread holds the lock.
//!
//! The spin is bounded (`SPIN_LIMIT` `pause`s): a lock holder can be suspended indefinitely (a
//! GC's stop-the-world signal, Wine's `SuspendThread`, or a `fork` child that inherited a held
//! lock). On timeout `guard_enter` reports "not entered", so the call passes through unscaled
//! instead of hanging the game, and `scale` reads its slot without the lock.
//!
//! # Lock-free slot reads
//!
//! Every write to a slot happens under the lock, bracketed by two increments of the slot's
//! sequence number (odd while the write is in progress), as in a seqlock. When `scale` can't take
//! the lock it reads the sequence, the slot, and the sequence again, and returns the game time
//! from the slot if the sequence was even and unchanged. x86 keeps loads in order with loads and
//! stores in order with stores, so such a read is consistent. A torn read is still possible in
//! one case: a holder suspended *in the middle* of a slot write leaves the sequence odd, and the
//! read then falls back to the real time (one unscaled reading). That needs the holder to stop
//! within a handful of instructions, and the fallback is what every timed-out call returned before.
//!
//! Entries of the nesting table are claimed under the lock (`guard_enter` only takes key-0
//! entries), so `guard_leave` needs no lock: only the owning thread changes its entry's depth,
//! and at depth 0 it frees the entry with `lock cmpxchg key → 0`, which can't erase an entry
//! that was freed and reclaimed meanwhile (R16 as amended).
use super::{Abi, Kind};

/// `"STLSPD01"`.
pub const OFF_MAGIC: u64 = 0x00;
/// Spinlock word (`u32`): 0 when free, else the owner's tag.
pub const OFF_LOCK: u64 = 0x08;
/// Requested speed (`f64`). The daemon writes it before `gen`.
pub const OFF_SPEED: u64 = 0x10;
/// Generation (`u32`), bumped on every speed change; never 0 once set.
pub const OFF_GEN: u64 = 0x18;
/// Per-clock-domain slots: `{real0 i64, fake0 i64, speed f64, gen u32, pad}`.
pub const OFF_SLOTS: u64 = 0x40;
pub const SLOT_SIZE: u64 = 32;
pub const SLOT_COUNT: u32 = 32;
pub const SLOT_REAL0: u64 = 0x00;
pub const SLOT_FAKE0: u64 = 0x08;
pub const SLOT_SPEED: u64 = 0x10;
/// 0 = never used: the first call sets `real0 = fake0 = real`.
pub const SLOT_GEN: u64 = 0x18;
/// Sequence number (`u32`), odd while the slot is being written (lock-free reads).
pub const SLOT_SEQ: u64 = 0x1c;
/// Per-thread nesting table: 64 × `{key u64, depth u64}`; key 0 is a free entry.
pub const OFF_NEST: u64 = 0x440;
pub const NEST_ENTRY: u64 = 16;
pub const NEST_COUNT: u64 = 64;
/// Recovery record: `count u32`, then entries.
pub const OFF_RECOVERY: u64 = 0x840;
/// Recovery entries: 32 × `{addr u64 @0, len u8 @8, original [16]u8 @0x10}`.
pub const OFF_RECOVERY_ENTRIES: u64 = 0x848;
pub const RECOVERY_ENTRY: u64 = 32;
pub const RECOVERY_MAX: usize = 32;
pub const RECOVERY_ORIGINAL_MAX: usize = 16;
/// Shared code: one routine per fixed offset.
pub const OFF_CODE: u64 = 0x1000;
pub const OFF_SCALE: u64 = OFF_CODE;
pub const OFF_GUARD_ENTER: u64 = OFF_CODE + ROUTINE_MAX;
pub const OFF_GUARD_LEAVE: u64 = OFF_CODE + 2 * ROUTINE_MAX;
/// `scale` for 32-bit millisecond counts (`GetTickCount`, `timeGetTime`), which wrap.
pub const OFF_SCALE32: u64 = OFF_CODE + 3 * ROUTINE_MAX;
/// Room for each shared routine.
pub const ROUTINE_MAX: u64 = 0x200;

/// `guard_enter` results.
const NOT_ENTERED: u32 = 2;
/// Most `pause`s spent waiting for the lock before giving up (about 2^20).
pub const SPIN_LIMIT: u32 = 1 << 20;

/// Takes the lock with owner tag `ecx | 1` (state base in `r10`; clobbers `r11`). Jumps to
/// `{p}_locked` once held, or to `{p}_reentered` if this thread already holds it or the holder
/// doesn't let go within `SPIN_LIMIT` pauses.
fn acquire(p: &str) -> String {
    format!(
        "mov r9d, ecx
or r9d, 1
mov r11d, {SPIN_LIMIT:#x}
{p}_acquire:
xor eax, eax
lock cmpxchg dword ptr [r10+{OFF_LOCK:#x}], r9d
je {p}_locked
cmp eax, r9d
je {p}_reentered
pause
dec r11d
je {p}_reentered
jmp {p}_acquire
"
    )
}

/// The shared routines for a state page at `state`: `(offset, source)`, each assembled at
/// `state + offset`.
pub fn shared_routines(state: u64) -> [(u64, String); 4] {
    [
        (OFF_SCALE, scale(state, false)),
        (OFF_GUARD_ENTER, guard_enter(state)),
        (OFF_GUARD_LEAVE, guard_leave(state)),
        (OFF_SCALE32, scale(state, true)),
    ]
}

/// `scale(rcx = key, rdx = slot, r8 = real) -> rax = game time`, under the lock:
/// rebase the slot when the generation changed, then `fake0 + (f64)max(real − real0, 0) × speed`.
/// Without the lock (the spin gave up), the same from a consistent lock-free read of the slot,
/// or the real time if there is none.
///
/// `wrap32`: `real` is a 32-bit millisecond count that wraps every 49.7 days. The delta is taken
/// modulo 2^32 (a negative one, as a signed 32-bit value, is a reading from before `real0`), the
/// slot is rebased once the delta passes 2^30 so it never overflows, and the caller uses the
/// low 32 bits of the result.
fn scale(state: u64, wrap32: bool) -> String {
    let delta = if wrap32 {
        format!(
            "mov eax, r8d
sub eax, dword ptr [r11+{SLOT_REAL0:#x}]
jns s_forward"
        )
    } else {
        format!(
            "mov rax, r8
sub rax, qword ptr [r11+{SLOT_REAL0:#x}]
jge s_forward"
        )
    };
    // At the same speed for more than 2^30 ms (12.4 days): move the base up to keep the
    // 32-bit delta positive.
    let keep_in_range = if wrap32 {
        format!(
            "mov eax, r8d
sub eax, dword ptr [r11+{SLOT_REAL0:#x}]
cmp eax, 40000000
jl s_now
inc dword ptr [r11+{SLOT_SEQ:#x}]
call s_fake
mov qword ptr [r11+{SLOT_FAKE0:#x}], rax
mov qword ptr [r11+{SLOT_REAL0:#x}], r8
inc dword ptr [r11+{SLOT_SEQ:#x}]
s_now:
"
        )
    } else {
        String::new()
    };
    format!(
        "mov r10, {state:#x}
{acquire}s_reentered:
// No lock: read the slot as a seqlock reader (never written here).
shl rdx, {slot_shift}
lea r11, [r10+rdx+{OFF_SLOTS:#x}]
mov r9d, dword ptr [r11+{SLOT_SEQ:#x}]
test r9d, 1
jne s_real
cmp dword ptr [r11+{SLOT_GEN:#x}], 0
je s_real
call s_fake
cmp r9d, dword ptr [r11+{SLOT_SEQ:#x}]
jne s_real
ret
s_real:
mov rax, r8
ret
s_locked:
shl rdx, {slot_shift}
lea r11, [r10+rdx+{OFF_SLOTS:#x}]
// gen is read before speed: the daemon writes speed first, then gen.
mov r9d, dword ptr [r10+{OFF_GEN:#x}]
mov ecx, dword ptr [r11+{SLOT_GEN:#x}]
cmp ecx, r9d
je s_ready
inc dword ptr [r11+{SLOT_SEQ:#x}]
test ecx, ecx
jne s_rebase
// First use of this slot: game time starts at real time.
mov qword ptr [r11+{SLOT_REAL0:#x}], r8
mov qword ptr [r11+{SLOT_FAKE0:#x}], r8
jmp s_newgen
s_rebase:
// Continue from the game time the old speed gives now.
call s_fake
mov qword ptr [r11+{SLOT_FAKE0:#x}], rax
mov qword ptr [r11+{SLOT_REAL0:#x}], r8
s_newgen:
mov rcx, qword ptr [r10+{OFF_SPEED:#x}]
mov qword ptr [r11+{SLOT_SPEED:#x}], rcx
mov dword ptr [r11+{SLOT_GEN:#x}], r9d
inc dword ptr [r11+{SLOT_SEQ:#x}]
s_ready:
{keep_in_range}call s_fake
mov dword ptr [r10+{OFF_LOCK:#x}], 0
ret
// rax = fake0 + (i64)((f64)max(real - real0, 0) * speed) for slot r11 and real r8.
// Clobbers only rax and xmm0.
s_fake:
{delta}
// Another thread rebased with a later reading: never go back past fake0.
xor eax, eax
s_forward:
cvtsi2sd xmm0, rax
mulsd xmm0, qword ptr [r11+{SLOT_SPEED:#x}]
cvttsd2si rax, xmm0
add rax, qword ptr [r11+{SLOT_FAKE0:#x}]
ret
",
        acquire = acquire("s"),
        slot_shift = SLOT_SIZE.trailing_zeros(),
    )
}

/// `guard_enter(rcx = key) -> eax`: 0 = outermost (entered), 1 = nested (entered), 2 = not
/// entered (the table is full, this thread holds the lock, or the lock stayed taken). Callers
/// treat 1 and 2 as nested, and call `guard_leave` unless the result was 2.
fn guard_enter(state: u64) -> String {
    format!(
        "mov r10, {state:#x}
{acquire}e_reentered:
mov eax, {NOT_ENTERED}
ret
e_locked:
lea rdx, [r10+{OFF_NEST:#x}]
xor r8d, r8d
mov r11d, #{NEST_COUNT}
e_find:
mov rax, qword ptr [rdx]
cmp rax, rcx
je e_found
test rax, rax
jne e_next
test r8, r8
jne e_next
mov r8, rdx
e_next:
add rdx, {NEST_ENTRY:#x}
dec r11d
jne e_find
test r8, r8
je e_full
mov qword ptr [r8], rcx
mov qword ptr [r8+8], 1
xor eax, eax
jmp e_unlock
e_found:
// Depth 0: interrupted in guard_leave between its dec and its key release; outermost again.
xor eax, eax
cmp qword ptr [rdx+8], 0
setne al
inc qword ptr [rdx+8]
jmp e_unlock
e_full:
mov eax, {NOT_ENTERED}
e_unlock:
mov dword ptr [r10+{OFF_LOCK:#x}], 0
ret
",
        acquire = acquire("e")
    )
}

/// `guard_leave(rcx = key)`: one level less for this thread; the entry is freed at depth 0.
/// Lock-free: only this thread changes its entry's depth, and claims only take key-0 entries.
fn guard_leave(state: u64) -> String {
    format!(
        "mov r10, {state:#x}
lea rdx, [r10+{OFF_NEST:#x}]
mov r11d, #{NEST_COUNT}
l_find:
cmp qword ptr [rdx], rcx
je l_found
add rdx, {NEST_ENTRY:#x}
dec r11d
jne l_find
ret
l_found:
dec qword ptr [rdx+8]
jne l_done
mov rax, rcx
xor r8d, r8d
lock cmpxchg qword ptr [rdx], r8
l_done:
ret
"
    )
}

/// `rax = scale(slot in edx)` of the value in `rax`, with the routine at `state + routine`. The
/// thread key is in `r14`.
fn call_scale(state: u64, routine: u64, slot: &str) -> String {
    format!(
        "mov r8, rax
mov rcx, r14
{slot}
mov rax, {:#x}
call rax
",
        state + routine
    )
}

/// `rax` (a count of `unit`s) split back into `[ptr]` = whole seconds and `[ptr+8]` = the rest.
fn split_store(ptr: &str, unit: &str) -> String {
    format!(
        "mov rcx, #{unit}
cqo
idiv rcx
test rdx, rdx
jns h_store
add rdx, rcx
dec rax
h_store:
mov qword ptr [{ptr}], rax
mov qword ptr [{ptr}+8], rdx
"
    )
}

/// The highest slot a target of `kind` uses when its base slot is `slot`.
pub fn last_slot(kind: Kind, slot: u32) -> u32 {
    match kind {
        Kind::ClockGettime => slot + 7,
        _ => slot,
    }
}

/// The hook for `kind` under `abi`, using the state page at `state` and clock slot `slot` (for
/// `ClockGettime`, the base slot: clock id `n` uses `slot + n`). It calls the original at
/// `trampoline_or_original`: the relocated entry (inline hooks), or for `GettimeofdayGot` the
/// function itself (`__vdso_gettimeofday`), through a pointer stored after the code.
///
/// Shape: save → `guard_enter` (D13 thread key) → call the original → if outermost and the call
/// succeeded, convert to ticks, `scale`, convert back → `guard_leave` → restore → `ret`.
/// Seven pushes plus `sub rsp, 20` keep `rsp` 16-byte aligned at every call and give Win64
/// callees their 32 bytes of shadow space. All registers callee-saved under either ABI
/// (`rbx`, `rbp`, `rsi`, `rdi`, `r12`–`r15`) are preserved; `rbp` and `xmm6`–`xmm15` are never
/// touched.
pub fn hook_source(kind: Kind, abi: Abi, state: u64, slot: u32, trampoline_or_original: u64) -> String {
    let (a0, a1, key) = match abi {
        Abi::Win64 => ("rcx", "rdx", "gs:[30]"),
        Abi::Sysv => ("rdi", "rsi", "fs:[0]"),
    };
    let call_original = match kind {
        Kind::GettimeofdayGot => "call qword ptr [h_original]".to_string(),
        _ => format!("call {trampoline_or_original:#x}"),
    };
    let slot_fixed = format!("mov edx, {slot:#x}");
    // After the original: r12 = first argument, rbx = second, r15 = its result. Jump to h_out
    // to leave the result alone.
    let body = match kind {
        // QueryPerformanceCounter returns a BOOL (nonzero = success), NtQueryPerformanceCounter
        // an NTSTATUS (0 = success; Wine returns STATUS_ACCESS_VIOLATION for a bad pointer).
        // The pointer is checked too: Wine's RtlQueryPerformanceCounter returns TRUE whatever
        // the NtQueryPerformanceCounter it calls returned.
        Kind::Qpc | Kind::NtQpc => format!(
            "test r15d, r15d
{}
test r12, r12
je h_out
mov rax, qword ptr [r12]
{}mov qword ptr [r12], rax
",
            if kind == Kind::Qpc { "je h_out" } else { "jne h_out" },
            call_scale(state, OFF_SCALE, &slot_fixed)
        ),
        // A 32-bit count, scaled with wraparound; the result is its low 32 bits, zero-extended.
        Kind::Tick32 => format!("mov eax, r15d\n{}mov r15d, eax\n", call_scale(state, OFF_SCALE32, &slot_fixed)),
        Kind::Tick64 => format!("mov rax, r15\n{}mov r15, rax\n", call_scale(state, OFF_SCALE, &slot_fixed)),
        Kind::ClockGettime => format!(
            "test r15d, r15d
jne h_out
test rbx, rbx
je h_out
// Scale REALTIME, MONOTONIC, MONOTONIC_RAW, REALTIME_COARSE, MONOTONIC_COARSE, BOOTTIME (D14).
cmp r12d, 7
ja h_out
cmp r12d, 2
je h_out
cmp r12d, 3
je h_out
mov rax, qword ptr [rbx]
imul rax, rax, #1000000000
add rax, qword ptr [rbx+8]
{}{}",
            call_scale(state, OFF_SCALE, &format!("lea edx, [r12+{slot:#x}]")),
            split_store("rbx", "1000000000")
        ),
        Kind::Gettimeofday | Kind::GettimeofdayGot => format!(
            "test r15d, r15d
jne h_out
test r12, r12
je h_out
mov rax, qword ptr [r12]
imul rax, rax, #1000000
add rax, qword ptr [r12+8]
{}{}",
            call_scale(state, OFF_SCALE, &slot_fixed),
            split_store("r12", "1000000")
        ),
    };
    let data = match kind {
        Kind::GettimeofdayGot => format!("h_original:\ndq {trampoline_or_original:#x}\n"),
        _ => String::new(),
    };
    format!(
        "endbr64
push rbx
push rsi
push rdi
push r12
push r13
push r14
push r15
sub rsp, 20
mov r12, {a0}
mov rbx, {a1}
mov r14, qword ptr {key}
mov rcx, r14
mov rax, {enter:#x}
call rax
mov r13d, eax
mov {a0}, r12
mov {a1}, rbx
{call_original}
mov r15, rax
test r13d, r13d
jne h_out
{body}h_out:
cmp r13d, {NOT_ENTERED}
je h_done
mov rcx, r14
mov rax, {leave:#x}
call rax
h_done:
mov rax, r15
add rsp, 20
pop r15
pop r14
pop r13
pop r12
pop rdi
pop rsi
pop rbx
ret
{data}",
        enter = state + OFF_GUARD_ENTER,
        leave = state + OFF_GUARD_LEAVE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm;
    use iced_x86::{Decoder, DecoderOptions, Mnemonic};

    const STATE: u64 = 0x7f12_3456_0000;
    const KINDS: [Kind; 7] = [Kind::Qpc, Kind::NtQpc, Kind::Tick32, Kind::Tick64, Kind::ClockGettime, Kind::Gettimeofday, Kind::GettimeofdayGot];

    #[test]
    fn layout_fits_the_state_page() {
        assert_eq!(OFF_SLOTS + SLOT_SIZE * SLOT_COUNT as u64, OFF_NEST);
        assert_eq!(OFF_NEST + NEST_ENTRY * NEST_COUNT, OFF_RECOVERY);
        assert!(OFF_RECOVERY_ENTRIES + RECOVERY_ENTRY * RECOVERY_MAX as u64 <= OFF_CODE);
        assert!(OFF_SCALE32 + ROUTINE_MAX <= super::super::STATE_PAGE_SIZE);
        assert!(SLOT_SEQ + 4 <= SLOT_SIZE);
        // The speed (f64) and gen (u32) are one contiguous 12-byte write.
        assert_eq!(OFF_SPEED + 8, OFF_GEN);
        assert!(SLOT_SIZE.is_power_of_two());
    }

    #[test]
    fn shared_routines_assemble_and_fit() {
        for (off, src) in shared_routines(STATE) {
            let a = asm::assemble(&src, STATE + off, &|_| None).unwrap_or_else(|e| panic!("routine at {off:#x}: {e}\n{src}"));
            assert!(a.bytes.len() as u64 <= ROUTINE_MAX, "routine at {off:#x} is {} bytes", a.bytes.len());
            let ins: Vec<_> = Decoder::with_ip(64, &a.bytes, STATE + off, DecoderOptions::NONE).iter().collect();
            let m: Vec<Mnemonic> = ins.iter().map(|i| i.mnemonic()).collect();
            // Every routine uses `lock cmpxchg`: to take the lock, or (guard_leave) to free its entry.
            assert!(ins.iter().any(|i| i.mnemonic() == Mnemonic::Cmpxchg && i.has_lock_prefix()), "{m:?}");
            if off == OFF_GUARD_LEAVE {
                // Lock-free: it never spins and never touches the lock word.
                assert!(!m.contains(&Mnemonic::Pause), "{m:?}");
                let lock_word = |i: &iced_x86::Instruction| i.memory_base() == iced_x86::Register::R10 && i.memory_displacement64() == OFF_LOCK;
                assert!(!ins.iter().any(lock_word), "{m:?}");
            } else {
                // The spin is bounded: the counter starts at SPIN_LIMIT.
                assert!(m.contains(&Mnemonic::Pause), "{m:?}");
                assert!(ins.iter().any(|i| i.mnemonic() == Mnemonic::Mov && i.op1_kind() == iced_x86::OpKind::Immediate32 && i.immediate32() == SPIN_LIMIT), "{m:?}");
            }
        }
    }

    #[test]
    fn every_template_assembles_and_fits_the_hook_page() {
        let page = 0x7f00_0000_0000u64;
        for kind in KINDS {
            for abi in [Abi::Win64, Abi::Sysv] {
                let src = hook_source(kind, abi, STATE, 9, page + 0x800);
                let a = asm::assemble(&src, page, &|_| None).unwrap_or_else(|e| panic!("{kind:?}/{abi:?}: {e}\n{src}"));
                assert!(a.bytes.len() < 0x400, "{kind:?}/{abi:?} is {} bytes", a.bytes.len());
                let ins: Vec<_> = Decoder::with_ip(64, &a.bytes, page, DecoderOptions::NONE).iter().collect();
                // The thread key comes from the ABI's thread pointer (D13).
                let seg = match abi {
                    Abi::Win64 => iced_x86::Register::GS,
                    Abi::Sysv => iced_x86::Register::FS,
                };
                assert!(ins.iter().any(|i| i.segment_prefix() == seg), "{kind:?}/{abi:?} has no {seg:?} access");
            }
        }
    }

    #[test]
    fn templates_keep_the_stack_aligned_and_balanced() {
        // Walk the straight-line prologue: rsp must be 16-byte aligned at every call, given
        // rsp % 16 == 8 at entry. Pushes and pops must balance before `ret`.
        let page = 0x7f00_0000_0000u64;
        for kind in KINDS {
            for abi in [Abi::Win64, Abi::Sysv] {
                let a = asm::assemble(&hook_source(kind, abi, STATE, 9, page + 0x800), page, &|_| None).unwrap();
                let mut depth: i64 = 8;
                for i in Decoder::with_ip(64, &a.bytes, page, DecoderOptions::NONE).iter() {
                    match i.mnemonic() {
                        Mnemonic::Push => depth += 8,
                        Mnemonic::Pop => depth -= 8,
                        Mnemonic::Sub if i.op0_register() == iced_x86::Register::RSP => depth += i.immediate(1) as i64,
                        Mnemonic::Add if i.op0_register() == iced_x86::Register::RSP => depth -= i.immediate(1) as i64,
                        Mnemonic::Call => assert_eq!(depth % 16, 0, "{kind:?}/{abi:?}: misaligned call at {:#x}", i.ip()),
                        Mnemonic::Ret => {
                            assert_eq!(depth, 8, "{kind:?}/{abi:?}: unbalanced stack at ret");
                            break;
                        }
                        _ => {}
                    }
                }
                // Win64 callees get their 32 bytes of shadow space.
                assert!(depth == 8);
            }
        }
    }

    #[test]
    fn got_template_calls_the_original_through_its_pointer() {
        let page = 0x7f00_0000_0000u64;
        let vdso = 0x7ffd_1234_5000u64;
        let src = hook_source(Kind::GettimeofdayGot, Abi::Sysv, STATE, 8, vdso);
        let a = asm::assemble(&src, page, &|_| None).unwrap();
        let ptr = a.labels["h_original"];
        let at = (ptr - page) as usize;
        assert_eq!(a.bytes[at..at + 8], vdso.to_le_bytes());
        let call = Decoder::with_ip(64, &a.bytes, page, DecoderOptions::NONE)
            .iter()
            .find(|i| i.mnemonic() == Mnemonic::Call && i.is_ip_rel_memory_operand())
            .expect("an indirect call through the pointer");
        assert_eq!(call.ip_rel_memory_address(), ptr);
    }

    /// A state page in this test process (rwx, never freed while the test runs), at `speed`,
    /// generation 1.
    struct LocalState(u64);

    impl LocalState {
        fn new(speed: f64) -> LocalState {
            let size = super::super::STATE_PAGE_SIZE as usize;
            let prot = libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC;
            let p = unsafe { libc::mmap(std::ptr::null_mut(), size, prot, libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0) };
            assert_ne!(p, libc::MAP_FAILED);
            let page = p as u64;
            let img = super::super::state_image(page).unwrap();
            unsafe { std::ptr::copy_nonoverlapping(img.as_ptr(), p as *mut u8, img.len()) };
            let st = LocalState(page);
            st.put(OFF_SPEED, speed.to_bits());
            st.put32(OFF_GEN, 1);
            st
        }
        fn put(&self, off: u64, v: u64) {
            unsafe { std::ptr::write_volatile((self.0 + off) as *mut u64, v) }
        }
        fn put32(&self, off: u64, v: u32) {
            unsafe { std::ptr::write_volatile((self.0 + off) as *mut u32, v) }
        }
        /// Call the routine at `off` with the shared routines' own convention.
        fn call(&self, off: u64, key: u64, slot: u64, real: u64) -> u64 {
            let out: u64;
            unsafe {
                std::arch::asm!(
                    "call {f}",
                    f = in(reg) self.0 + off,
                    inout("rcx") key => _,
                    inout("rdx") slot => _,
                    inout("r8") real => _,
                    out("rax") out,
                    out("r9") _,
                    out("r10") _,
                    out("r11") _,
                    out("xmm0") _,
                );
            }
            out
        }
    }

    impl Drop for LocalState {
        fn drop(&mut self) {
            unsafe { libc::munmap(self.0 as *mut libc::c_void, super::super::STATE_PAGE_SIZE as usize) };
        }
    }

    const KEY: u64 = 0x7f00_dead_b000;

    #[test]
    fn tick32_time_keeps_counting_across_the_32_bit_wrap() {
        let st = LocalState::new(2.0);
        let tick = |real: u64| st.call(OFF_SCALE32, KEY, 10, real) as u32;
        // First use: game time starts at real time, 256 ms before GetTickCount wraps.
        assert_eq!(tick(0xffff_ff00), 0xffff_ff00);
        // A reading from before the slot's base (taken by a thread that got the lock later) never
        // turns time back.
        assert_eq!(tick(0xffff_fe00), 0xffff_ff00);
        // 512 ms later, after the wrap: 1024 ms of game time, wrapped the same way.
        assert_eq!(tick(0x100), 0xffff_ff00u32.wrapping_add(0x400));
        // More than 2^31 ms (24.8 days) at one speed: the routine rebases on the way, so the
        // delta never overflows a signed 32-bit value.
        let mut real = 0x100u32;
        let mut game = 0x300u32;
        for _ in 0..4 {
            real = real.wrapping_add(0x5000_0000);
            game = game.wrapping_add(0xa000_0000);
            assert_eq!(tick(real as u64), game, "real {real:#x}");
        }
    }

    #[test]
    fn scale_is_64_bit_and_clamps_backwards_readings() {
        let st = LocalState::new(2.0);
        let qpc = |real: u64| st.call(OFF_SCALE, KEY, 9, real);
        assert_eq!(qpc(0x1_0000_0000), 0x1_0000_0000);
        assert_eq!(qpc(0x0_ffff_0000), 0x1_0000_0000);
        assert_eq!(qpc(0x1_0000_1000), 0x1_0000_2000);
    }

    #[test]
    fn a_held_lock_still_gives_game_time_from_a_consistent_slot() {
        let st = LocalState::new(2.0);
        assert_eq!(st.call(OFF_SCALE, KEY, 9, 1000), 1000);
        // Another thread holds the lock and never lets go: after the bounded spin, the slot is
        // read without the lock, so the game keeps its game time instead of jumping to real time.
        st.put32(OFF_LOCK, 0x1234_5679);
        assert_eq!(st.call(OFF_SCALE, KEY, 9, 2000), 3000);
        // A slot caught mid-update (odd sequence) can't be trusted: real time is passed through.
        let seq = OFF_SLOTS + 9 * SLOT_SIZE + SLOT_SEQ;
        st.put32(seq, 1);
        assert_eq!(st.call(OFF_SCALE, KEY, 9, 2000), 2000);
        // A slot never used has no game time yet.
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 5000), 5000);
    }
}
