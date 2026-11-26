//! Speed hook code as CE-style Intel text for `asm::assemble` (D11, D13), and the state page
//! layout it works on. Numbers in the text are hex unless written `#decimal`.
//!
//! # Calling convention of the shared routines
//!
//! `scale`, `unscale`, `guard_enter` and `guard_leave` live in the state page at fixed offsets and use their
//! own convention, valid under both ABIs: arguments in `rcx`, `rdx`, `r8` (and `r9`); result in `rax`; they
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
//! lock). On timeout `guard_enter` reports "timed out": the hook doesn't hang the game, skips the
//! nesting table (no entry was claimed, so no `guard_leave` follows), and still scales: `scale`
//! times out too and reads its slot without the lock, so the game keeps its game time. Nesting is
//! not tracked on that degraded path, so a nested hooked call made during it is scaled twice.
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
use super::targets::{SLOT_CLOCK, SLOT_GETTIMEOFDAY};
use super::{Abi, Kind};

/// `clock_gettime(CLOCK_REALTIME)`'s slot. It and gettimeofday's are one clock in two units (ns
/// and µs): `scale` starts whichever is used second from the other's game time, so they agree,
/// and a REALTIME wait converts through gettimeofday's when only that one was read.
const SLOT_REALTIME: u32 = SLOT_CLOCK;

/// `"STLSPD01"`.
pub const OFF_MAGIC: u64 = 0x00;
/// Spinlock word (`u32`): 0 when free, else the owner's tag.
pub const OFF_LOCK: u64 = 0x08;
/// Requested speed (`f64`). The daemon writes it before `gen`.
pub const OFF_SPEED: u64 = 0x10;
/// Generation (`u32`), bumped on every speed change; never 0 once set.
pub const OFF_GEN: u64 = 0x18;
/// Landed slots (`u32`, bit per slot, set with `lock or`): the slot's landing clamp engaged
/// (M4 D3). Only meaningful while the speed is `LANDING`.
pub const OFF_LAND_MASK: u64 = 0x20;
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
/// `unscale`, the inverse of `scale`: a game-time deadline to real time (M4 D2).
pub const OFF_UNSCALE: u64 = OFF_CODE + 4 * ROUTINE_MAX;
/// Room for each shared routine.
pub const ROUTINE_MAX: u64 = 0x300;

/// The global speed sentinel for the session-end glide (M4 D3), never a speed the RPC accepts:
/// each slot rebases toward real time at `LAND_SLOW` (ahead) or `LAND_FAST` (behind), and from
/// then on is clamped so it never passes real time.
pub const LANDING: f64 = 0.0;
pub const LAND_SLOW: f64 = 0.5;
pub const LAND_FAST: f64 = 2.0;

/// After a rebase of the slot at `slot` (its `fake0`/`real0` written), with the global speed in
/// `val`: when that is `LANDING`, `val` becomes the slot's landing speed instead, `LAND_SLOW` if
/// its game time is ahead of real time, else `LAND_FAST`. Clobbers `tmp` and flags. `wrap32`
/// compares the 32-bit difference (`scale32`'s wrapping counts).
fn pick_speed(label: &str, slot: &str, val: &str, tmp: &str, wrap32: bool) -> String {
    let compare = if wrap32 {
        let t32 = match tmp {
            "rax" => "eax",
            other => panic!("pick_speed wrap32 needs rax, got {other}"),
        };
        format!("mov {t32}, dword ptr [{slot}+{SLOT_FAKE0:#x}]\nsub {t32}, dword ptr [{slot}+{SLOT_REAL0:#x}]\ntest {t32}, {t32}")
    } else {
        format!("mov {tmp}, qword ptr [{slot}+{SLOT_FAKE0:#x}]\ncmp {tmp}, qword ptr [{slot}+{SLOT_REAL0:#x}]")
    };
    format!(
        "test {val}, {val}
jne {label}
{compare}
// mov keeps the flags.
mov {val}, {fast:#x}
jle {label}
mov {val}, {slow:#x}
{label}:
",
        fast = LAND_FAST.to_bits(),
        slow = LAND_SLOW.to_bits(),
    )
}

/// Where glibc keeps a condvar's flags: `__wrefs` of `struct __pthread_cond_s`, whose bit 1 is
/// its clock (set by `pthread_condattr_setclock(CLOCK_MONOTONIC)`, else REALTIME). 0x1c since
/// glibc 2.41 removed `__g_refs` (checked on 2.44: offsetof, and the bit after setclock); it was
/// 0x24 before, so `targets::native` hooks `pthread_cond_timedwait` only on glibc 2.41 or later.
pub const COND_FLAGS_OFFSET: u64 = 0x1c;
pub const COND_CLOCK_MONOTONIC_MASK: u32 = 2;

/// `guard_enter` results: 0 outermost, 1 nested (both entered), `NOT_ENTERED` (pass the call
/// through), `TIMED_OUT` (not entered, but scale: the lock holder is stuck).
const NOT_ENTERED: u32 = 2;
const TIMED_OUT: u32 = 3;
/// Most `pause`s spent waiting for the lock before giving up (about 2^20).
pub const SPIN_LIMIT: u32 = 1 << 20;

/// Takes the lock with owner tag `ecx | 1` (state base in `r10`; clobbers `r11`). Jumps to
/// `{p}_locked` once held, to `{p}_reentered` if this thread already holds it, or to
/// `{p}_timeout` if the holder doesn't let go within `SPIN_LIMIT` pauses.
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
je {p}_timeout
jmp {p}_acquire
"
    )
}

/// The shared routines for a state page at `state`: `(offset, source)`, each assembled at
/// `state + offset`.
pub fn shared_routines(state: u64) -> [(u64, String); 5] {
    [
        (OFF_SCALE, scale(state, false)),
        (OFF_GUARD_ENTER, guard_enter(state)),
        (OFF_GUARD_LEAVE, guard_leave(state)),
        (OFF_SCALE32, scale(state, true)),
        (OFF_UNSCALE, unscale(state)),
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
    // REALTIME (ns) and gettimeofday (µs) are one clock: the slot used second starts from the
    // game time the other gives now, not from real time, so a game mixing them (a deadline built
    // from gettimeofday, waited for on REALTIME) sees one consistent clock.
    let pair = if wrap32 {
        String::new()
    } else {
        let rt = OFF_SLOTS + SLOT_REALTIME as u64 * SLOT_SIZE;
        let tod = OFF_SLOTS + SLOT_GETTIMEOFDAY as u64 * SLOT_SIZE;
        format!(
            "// A partner still at an older generation is rebased to now first, so it is seeded from
// at the new speed (and the pair stays on one formula).
mov rax, r8
call s_pair
lea rax, [r10+{rt:#x}]
cmp r11, rax
je s_from_tod
lea rax, [r10+{tod:#x}]
cmp r11, rax
jne s_newgen
// gettimeofday (µs): from REALTIME's game time at r8 × 1000 ns.
cmp dword ptr [r10+{rt_gen:#x}], 0
je s_newgen
push r11
push r8
imul r8, r8, #1000
lea r11, [r10+{rt:#x}]
call s_fake
pop r8
pop r11
mov rcx, #1000
cqo
idiv rcx
mov qword ptr [r11+{SLOT_FAKE0:#x}], rax
jmp s_newgen
s_from_tod:
// REALTIME (ns): from gettimeofday's game time at r8 / 1000 µs. The sub-µs leftover moves
// real0 back instead of adding to fake0, so REALTIME is exactly gettimeofday × 1000 on the µs
// grid at any speed.
cmp dword ptr [r10+{tod_gen:#x}], 0
je s_newgen
push r11
push r8
mov rax, r8
mov rcx, #1000
cqo
idiv rcx
push rdx
mov r8, rax
lea r11, [r10+{tod:#x}]
call s_fake
pop rdx
pop r8
pop r11
imul rax, rax, #1000
mov qword ptr [r11+{SLOT_FAKE0:#x}], rax
mov rax, r8
sub rax, rdx
mov qword ptr [r11+{SLOT_REAL0:#x}], rax
",
            rt_gen = rt + SLOT_GEN,
            tod_gen = tod + SLOT_GEN,
        )
    };
    // The landing clamp (D3): while the speed is LANDING and the slot is at its generation, the
    // game time never passes real time (max for LAND_SLOW, min for LAND_FAST); the first time it
    // would, the slot sets its bit in the land mask.
    // game − real: as a signed 32-bit value for the wrapping counts.
    let (diff, d) = if wrap32 { ("mov ecx, eax\nsub ecx, r8d", "ecx") } else { ("mov rcx, rax\nsub rcx, r8", "rcx") };
    let land = format!(
        "// rax = the clamped game time for slot r11 and real r8. Clobbers rcx, rdx and flags.
s_land:
mov ecx, dword ptr [r10+{OFF_GEN:#x}]
cmp ecx, dword ptr [r11+{SLOT_GEN:#x}]
jne s_land_done
cmp qword ptr [r10+{OFF_SPEED:#x}], 0
jne s_land_done
{diff}
mov rdx, {slow:#x}
cmp rdx, qword ptr [r11+{SLOT_SPEED:#x}]
jne s_land_fast
// Ahead: max(game, real).
test {d}, {d}
jg s_land_done
jmp s_land_hit
s_land_fast:
// Behind: min(game, real).
test {d}, {d}
jl s_land_done
s_land_hit:
mov rax, r8
mov rcx, r11
sub rcx, r10
sub rcx, {OFF_SLOTS:#x}
shr rcx, {slot_shift}
mov edx, 1
shl edx, cl
test dword ptr [r10+{OFF_LAND_MASK:#x}], edx
jne s_land_done
lock or dword ptr [r10+{OFF_LAND_MASK:#x}], edx
s_land_done:
ret
",
        slow = LAND_SLOW.to_bits(),
        slot_shift = SLOT_SIZE.trailing_zeros(),
    );
    let (rebase_pair, pair_sub) = if wrap32 {
        (String::new(), String::new())
    } else {
        ("mov rax, r8\ncall s_pair\n".to_string(), pair_rebase("s"))
    };
    format!(
        "mov r10, {state:#x}
{acquire}s_reentered:
s_timeout:
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
jmp s_land
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
// First use of this slot: game time starts at real time (or REALTIME's partner's game time).
mov qword ptr [r11+{SLOT_REAL0:#x}], r8
mov qword ptr [r11+{SLOT_FAKE0:#x}], r8
{pair}jmp s_newgen
s_rebase:
// Continue from the game time the old speed gives now.
call s_fake
mov qword ptr [r11+{SLOT_FAKE0:#x}], rax
mov qword ptr [r11+{SLOT_REAL0:#x}], r8
{rebase_pair}s_newgen:
mov rcx, qword ptr [r10+{OFF_SPEED:#x}]
{pick}mov qword ptr [r11+{SLOT_SPEED:#x}], rcx
mov dword ptr [r11+{SLOT_GEN:#x}], r9d
inc dword ptr [r11+{SLOT_SEQ:#x}]
s_ready:
{keep_in_range}call s_fake
call s_land
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
{land}{pair_sub}",
        acquire = acquire("s"),
        slot_shift = SLOT_SIZE.trailing_zeros(),
        pick = pick_speed("s_picked", "r11", "rcx", "rax", wrap32),
    )
}

/// `unscale(rcx = key, rdx = slot, r8 = game, r9 = real now) -> rax = real time`, under the
/// lock: when the slot's generation is behind, rebase it first exactly as `scale` would for a
/// reading of `r9`; then `max(real0 + (game − fake0) / speed, 0)`. A slot never used (gen 0) has
/// no game time yet, so the game's deadline is already real time: `game` is returned as is (and
/// the slot stays unused). Without the lock, the same from a consistent lock-free read of the
/// slot, or `game` if there is none.
fn unscale(state: u64) -> String {
    format!(
        "mov r10, {state:#x}
// The real time now is only needed to rebase; r9 holds the lock tag from here on.
push r9
{acquire}u_reentered:
u_timeout:
// No lock: read the slot as a seqlock reader (never written here).
shl rdx, {slot_shift}
lea r11, [r10+rdx+{OFF_SLOTS:#x}]
mov r9d, dword ptr [r11+{SLOT_SEQ:#x}]
test r9d, 1
jne u_game
cmp dword ptr [r11+{SLOT_GEN:#x}], 0
je u_game
call u_land
cmp r9d, dword ptr [r11+{SLOT_SEQ:#x}]
jne u_game
add rsp, 8
ret
u_game:
mov rax, r8
add rsp, 8
ret
u_locked:
shl rdx, {slot_shift}
lea r11, [r10+rdx+{OFF_SLOTS:#x}]
mov ecx, dword ptr [r11+{SLOT_GEN:#x}]
test ecx, ecx
je u_unused
// gen is read before speed: the daemon writes speed first, then gen.
mov r9d, dword ptr [r10+{OFF_GEN:#x}]
cmp ecx, r9d
je u_ready
// Rebase as scale does: continue from the game time the old speed gives now.
inc dword ptr [r11+{SLOT_SEQ:#x}]
mov rdx, qword ptr [rsp]
call u_fake
mov qword ptr [r11+{SLOT_FAKE0:#x}], rax
mov qword ptr [r11+{SLOT_REAL0:#x}], rdx
mov rax, rdx
call u_pair
mov rcx, qword ptr [r10+{OFF_SPEED:#x}]
{pick}mov qword ptr [r11+{SLOT_SPEED:#x}], rcx
mov dword ptr [r11+{SLOT_GEN:#x}], r9d
inc dword ptr [r11+{SLOT_SEQ:#x}]
u_ready:
call u_land
jmp u_unlock
u_unused:
mov rax, r8
u_unlock:
mov dword ptr [r10+{OFF_LOCK:#x}], 0
add rsp, 8
ret
// rax = fake0 + (i64)((f64)max(rdx - real0, 0) * speed) for slot r11: scale's s_fake for the
// real time in rdx. Clobbers only rax and xmm0.
u_fake:
mov rax, rdx
sub rax, qword ptr [r11+{SLOT_REAL0:#x}]
jge u_forward
xor eax, eax
u_forward:
cvtsi2sd xmm0, rax
mulsd xmm0, qword ptr [r11+{SLOT_SPEED:#x}]
cvttsd2si rax, xmm0
add rax, qword ptr [r11+{SLOT_FAKE0:#x}]
ret
// rax = real0 + (i64)((f64)(game - fake0) / speed) for slot r11 and game time r8: the inverse
// of s_fake (a deadline before fake0 maps before real0). Below 0 it is 0 (already past); past
// i64 range it saturates to i64::MAX, so a far-future wait-forever deadline stays far away at low
// speeds. Clobbers only rax, rdx and xmm0.
u_real:
mov rax, r8
sub rax, qword ptr [r11+{SLOT_FAKE0:#x}]
jo u_overflow
cvtsi2sd xmm0, rax
divsd xmm0, qword ptr [r11+{SLOT_SPEED:#x}]
cvttsd2si rax, xmm0
// cvttsd2si gives the integer indefinite value: the quotient is out of i64 range.
mov rdx, 8000000000000000
cmp rax, rdx
je u_overflow
add rax, qword ptr [r11+{SLOT_REAL0:#x}]
jo u_overflow
jns u_done
u_zero:
xor eax, eax
u_done:
ret
// Out of range one way or the other: the sign of game - fake0 says which.
u_overflow:
mov rax, r8
cmp rax, qword ptr [r11+{SLOT_FAKE0:#x}]
jl u_zero
mov rax, 7fffffffffffffff
ret
// u_real, then the inverse of scale's landing clamp (D3) while the speed is LANDING and the slot
// at its generation: a game clock max(F, real) reaches game time g at min(F⁻¹(g), g), and
// min(F, real) at max(F⁻¹(g), g). Clobbers rax, rcx, rdx, xmm0 and flags.
u_land:
call u_real
mov ecx, dword ptr [r10+{OFF_GEN:#x}]
cmp ecx, dword ptr [r11+{SLOT_GEN:#x}]
jne u_land_done
cmp qword ptr [r10+{OFF_SPEED:#x}], 0
jne u_land_done
mov rdx, {slow:#x}
cmp rdx, qword ptr [r11+{SLOT_SPEED:#x}]
jne u_land_behind
cmp rax, r8
jle u_land_done
mov rax, r8
ret
u_land_behind:
cmp rax, r8
jge u_land_done
mov rax, r8
u_land_done:
ret
{pair_sub}",
        pick = pick_speed("u_picked", "r11", "rcx", "rax", false),
        slow = LAND_SLOW.to_bits(),
        pair_sub = pair_rebase("u"),
        acquire = acquire("u"),
        slot_shift = SLOT_SIZE.trailing_zeros(),
    )
}

/// `{p}_pair` (a local subroutine of `scale` and `unscale`, run under the lock): when the slot in
/// `r11` is REALTIME's or gettimeofday's, rebase its partner, if in use and at an older
/// generation, to the same instant: `rax` is the slot's real reading in its own unit (ns or µs).
/// The two then always change speed at the same real time, so they never drift apart (a pair
/// rebased on their separate next reads would differ by the time between them × the speed
/// change, for good). In: `r9d` the global generation, `r10` the state. Clobbers only `rax`,
/// `rcx`, `rdx` and `xmm0`.
fn pair_rebase(p: &str) -> String {
    let rt = OFF_SLOTS + SLOT_REALTIME as u64 * SLOT_SIZE;
    let tod = OFF_SLOTS + SLOT_GETTIMEOFDAY as u64 * SLOT_SIZE;
    format!(
        "{p}_pair:
lea rcx, [r10+{rt:#x}]
cmp r11, rcx
je {p}_pair_rt
lea rcx, [r10+{tod:#x}]
cmp r11, rcx
jne {p}_pair_done
// gettimeofday's reading (µs) as REALTIME's (ns).
imul rax, rax, #1000
lea rcx, [r10+{rt:#x}]
jmp {p}_pair_rebase
{p}_pair_rt:
// REALTIME's reading (ns) as gettimeofday's (µs).
mov rcx, #1000
cqo
idiv rcx
lea rcx, [r10+{tod:#x}]
{p}_pair_rebase:
mov edx, dword ptr [rcx+{SLOT_GEN:#x}]
test edx, edx
je {p}_pair_done
cmp edx, r9d
je {p}_pair_done
inc dword ptr [rcx+{SLOT_SEQ:#x}]
push rax
sub rax, qword ptr [rcx+{SLOT_REAL0:#x}]
jge {p}_pair_forward
xor eax, eax
{p}_pair_forward:
cvtsi2sd xmm0, rax
mulsd xmm0, qword ptr [rcx+{SLOT_SPEED:#x}]
cvttsd2si rax, xmm0
add rax, qword ptr [rcx+{SLOT_FAKE0:#x}]
mov qword ptr [rcx+{SLOT_FAKE0:#x}], rax
pop rax
mov qword ptr [rcx+{SLOT_REAL0:#x}], rax
mov rdx, qword ptr [r10+{OFF_SPEED:#x}]
// Landing: the partner's own direction, from its own game time vs real.
{pick}mov qword ptr [rcx+{SLOT_SPEED:#x}], rdx
mov dword ptr [rcx+{SLOT_GEN:#x}], r9d
inc dword ptr [rcx+{SLOT_SEQ:#x}]
{p}_pair_done:
ret
",
        pick = pick_speed(&format!("{p}_pair_picked"), "rcx", "rdx", "rax", false),
    )
}

/// `guard_enter(rcx = key) -> eax`: 0 = outermost (entered), 1 = nested (entered), 2 = not
/// entered (the table is full or this thread holds the lock), 3 = timed out (the lock stayed
/// taken; not entered). Callers scale on 0 and 3, pass through on 1 and 2, and call
/// `guard_leave` only after 0 or 1.
fn guard_enter(state: u64) -> String {
    format!(
        "mov r10, {state:#x}
{acquire}e_reentered:
mov eax, {NOT_ENTERED}
ret
e_timeout:
mov eax, {TIMED_OUT}
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
        // Clock-indexed: clock id `n` uses `slot + n`.
        Kind::ClockGettime | Kind::ClockNanosleep | Kind::CondTimedwait | Kind::CondClockwait | Kind::SemTimedwait | Kind::SemClockwait => slot + 7,
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
        Kind::ClockNanosleep | Kind::CondTimedwait | Kind::CondClockwait | Kind::SemTimedwait | Kind::SemClockwait => {
            unreachable!("{kind:?} is a wait: wait_hook_source")
        }
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
je h_body
cmp r13d, {TIMED_OUT}
jne h_out
h_body:
{body}h_out:
cmp r13d, 1
ja h_done
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

/// The hook for the absolute-deadline wait `kind` (SysV only), using the state page at `state`
/// and the clock slots from `slot_base` (clock id `n` uses `slot_base + n`, as `clock_gettime`'s
/// hook does). It calls the original at `trampoline`, and reads real time through
/// `__vdso_clock_gettime` at `vdso_clock` (stored after the code as `h_vdso_clock`): libc's
/// `clock_gettime` is hooked and would return game time.
///
/// Shape: save → the deadline's clock id (REALTIME for `sem_timedwait`, the cond's flags for
/// `cond_timedwait`, else the argument) → pass through unless the id is one `clock_gettime`
/// scales (0, 1, 4, 5, 6, 7), the deadline pointer is non-null and the deadline valid (an
/// out-of-range `tv_nsec` gets the original's EINVAL; one too far for i64 ns is left alone), and
/// for `clock_nanosleep` TIMER_ABSTIME is set → the real time now of that clock → `guard_enter`
/// → if outermost (or timed out, where `unscale` reads its slot without the lock, as `scale`
/// does): `unscale` the deadline into a 16-byte stack local, which replaces the deadline
/// argument → `guard_leave` if entered → call the original → restore → `ret`. The guard is
/// never held across the wait: a nesting entry per blocked thread would run out (64 entries).
/// A REALTIME deadline converts through gettimeofday's slot (µs) when only that one was read.
/// Five pushes plus `sub rsp, 30` keep `rsp` 16-byte aligned at every call.
pub fn wait_hook_source(kind: Kind, state: u64, slot_base: u32, trampoline: u64, vdso_clock: u64) -> String {
    // Arguments are kept in r12 = rdi, r13 = rsi, r14 = rdx, r15 = rcx; `deadline` names the
    // register holding the deadline pointer. `clock` leaves the clock id in eax.
    let (deadline, clock) = match kind {
        Kind::ClockNanosleep => ("r14", "test r13d, 1\nje w_call\nmov eax, r12d\n".to_string()),
        Kind::CondTimedwait => (
            "r14",
            format!(
                "test r12, r12
je w_call
mov eax, dword ptr [r12+{COND_FLAGS_OFFSET:#x}]
and eax, {COND_CLOCK_MONOTONIC_MASK:#x}
// 0 = CLOCK_REALTIME, 1 = CLOCK_MONOTONIC.
shr eax, {shift}
",
                shift = COND_CLOCK_MONOTONIC_MASK.trailing_zeros()
            ),
        ),
        Kind::CondClockwait => ("r15", "mov eax, r14d\n".to_string()),
        Kind::SemTimedwait => ("r13", "xor eax, eax\n".to_string()),
        Kind::SemClockwait => ("r14", "mov eax, r13d\n".to_string()),
        _ => unreachable!("{kind:?} is not a wait: hook_source"),
    };
    format!(
        "endbr64
push rbx
push r12
push r13
push r14
push r15
// [rsp] the converted deadline, [rsp+10] guard_enter's result, [rsp+18] real now (ns),
// [rsp+20] the game's deadline (ns).
sub rsp, 30
mov r12, rdi
mov r13, rsi
mov r14, rdx
mov r15, rcx
{clock}// Only the clocks clock_gettime scales (D14): REALTIME, MONOTONIC, MONOTONIC_RAW, the
// coarse ones and BOOTTIME.
cmp eax, 7
ja w_call
cmp eax, 2
je w_call
cmp eax, 3
je w_call
mov ebx, eax
test {deadline}, {deadline}
je w_call
cmp qword ptr [{deadline}+8], #999999999
ja w_call
mov rax, qword ptr [{deadline}]
// A negative tv_sec gets the original's EINVAL.
test rax, rax
js w_call
imul rax, rax, #1000000000
jo w_call
add rax, qword ptr [{deadline}+8]
jo w_call
mov qword ptr [rsp+20], rax
mov edi, ebx
mov rsi, rsp
call qword ptr [h_vdso_clock]
test eax, eax
jne w_call
mov rax, qword ptr [rsp]
imul rax, rax, #1000000000
add rax, qword ptr [rsp+8]
mov qword ptr [rsp+18], rax
mov rcx, qword ptr fs:[0]
mov rax, {enter:#x}
call rax
mov dword ptr [rsp+10], eax
cmp eax, 1
je w_leave
cmp eax, {NOT_ENTERED}
je w_call
test ebx, ebx
jne w_unscale
// REALTIME whose clock_gettime slot was never read, but gettimeofday's was: the deadline was
// built from gettimeofday, so convert it in that slot's microseconds.
mov rax, {rt_gen:#x}
cmp dword ptr [rax], 0
jne w_unscale
mov rax, {tod_gen:#x}
cmp dword ptr [rax], 0
je w_unscale
mov rcx, #1000
mov rax, qword ptr [rsp+20]
cqo
idiv rcx
mov qword ptr [rsp+28], rdx
mov r8, rax
mov rax, qword ptr [rsp+18]
cqo
idiv rcx
mov r9, rax
mov rcx, qword ptr fs:[0]
mov edx, {SLOT_GETTIMEOFDAY:#x}
mov rax, {unscale:#x}
call rax
imul rax, rax, #1000
jo w_max
add rax, qword ptr [rsp+28]
jno w_split
w_max:
mov rax, 7fffffffffffffff
jmp w_split
w_unscale:
mov r8, qword ptr [rsp+20]
mov r9, qword ptr [rsp+18]
mov rcx, qword ptr fs:[0]
lea edx, [rbx+{slot_base:#x}]
mov rax, {unscale:#x}
call rax
w_split:
{split}mov {deadline}, rsp
w_leave:
cmp dword ptr [rsp+10], 1
ja w_call
mov rcx, qword ptr fs:[0]
mov rax, {leave:#x}
call rax
w_call:
mov rdi, r12
mov rsi, r13
mov rdx, r14
mov rcx, r15
call {trampoline:#x}
add rsp, 30
pop r15
pop r14
pop r13
pop r12
pop rbx
ret
h_vdso_clock:
dq {vdso_clock:#x}
",
        split = split_store("rsp", "1000000000"),
        enter = state + OFF_GUARD_ENTER,
        leave = state + OFF_GUARD_LEAVE,
        unscale = state + OFF_UNSCALE,
        // Clock id 0's slot.
        rt_gen = state + OFF_SLOTS + slot_base as u64 * SLOT_SIZE + SLOT_GEN,
        tod_gen = state + OFF_SLOTS + SLOT_GETTIMEOFDAY as u64 * SLOT_SIZE + SLOT_GEN,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm;
    use iced_x86::{Decoder, DecoderOptions, Mnemonic};

    const STATE: u64 = 0x7f12_3456_0000;
    const KINDS: [Kind; 7] = [Kind::Qpc, Kind::NtQpc, Kind::Tick32, Kind::Tick64, Kind::ClockGettime, Kind::Gettimeofday, Kind::GettimeofdayGot];
    const WAIT_KINDS: [Kind; 5] = [Kind::ClockNanosleep, Kind::CondTimedwait, Kind::CondClockwait, Kind::SemTimedwait, Kind::SemClockwait];
    const VDSO: u64 = 0x7ffd_1234_5000;

    /// Every hook source the templates make, with a name for messages: each clock kind under
    /// each ABI, and each wait (SysV only).
    fn all_hooks(page: u64) -> Vec<(String, Abi, String)> {
        let mut v = vec![];
        for kind in KINDS {
            for abi in [Abi::Win64, Abi::Sysv] {
                v.push((format!("{kind:?}/{abi:?}"), abi, hook_source(kind, abi, STATE, 9, page + 0x800)));
            }
        }
        for kind in WAIT_KINDS {
            v.push((format!("{kind:?}"), Abi::Sysv, wait_hook_source(kind, STATE, 0, page + 0x800, VDSO)));
        }
        v
    }

    #[test]
    fn layout_fits_the_state_page() {
        assert_eq!(OFF_SLOTS + SLOT_SIZE * SLOT_COUNT as u64, OFF_NEST);
        assert_eq!(OFF_NEST + NEST_ENTRY * NEST_COUNT, OFF_RECOVERY);
        assert!(OFF_RECOVERY_ENTRIES + RECOVERY_ENTRY * RECOVERY_MAX as u64 <= OFF_CODE);
        assert!(OFF_UNSCALE + ROUTINE_MAX <= super::super::STATE_PAGE_SIZE);
        assert_eq!(OFF_UNSCALE, 0x1c00);
        assert!(SLOT_SEQ + 4 <= SLOT_SIZE);
        // The speed (f64) and gen (u32) are one contiguous 12-byte write.
        assert_eq!(OFF_SPEED + 8, OFF_GEN);
        assert!(SLOT_SIZE.is_power_of_two());
    }

    #[test]
    fn shared_routines_assemble_and_fit() {
        for (off, src) in shared_routines(STATE) {
            let a = asm::assemble(&src, STATE + off, asm::Bits::B64, &|_| None).unwrap_or_else(|e| panic!("routine at {off:#x}: {e}\n{src}"));
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
                let a = asm::assemble(&src, page, asm::Bits::B64, &|_| None).unwrap_or_else(|e| panic!("{kind:?}/{abi:?}: {e}\n{src}"));
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
        for (what, _, src) in all_hooks(page) {
            let a = asm::assemble(&src, page, asm::Bits::B64, &|_| None).unwrap();
            let mut depth: i64 = 8;
            for i in Decoder::with_ip(64, &a.bytes, page, DecoderOptions::NONE).iter() {
                match i.mnemonic() {
                    Mnemonic::Push => depth += 8,
                    Mnemonic::Pop => depth -= 8,
                    Mnemonic::Sub if i.op0_register() == iced_x86::Register::RSP => depth += i.immediate(1) as i64,
                    Mnemonic::Add if i.op0_register() == iced_x86::Register::RSP => depth -= i.immediate(1) as i64,
                    Mnemonic::Call => assert_eq!(depth % 16, 0, "{what}: misaligned call at {:#x}", i.ip()),
                    Mnemonic::Ret => {
                        assert_eq!(depth, 8, "{what}: unbalanced stack at ret");
                        break;
                    }
                    _ => {}
                }
            }
            // Win64 callees get their 32 bytes of shadow space.
            assert!(depth == 8);
        }
    }

    #[test]
    fn wait_hook_assembles_for_each_kind() {
        let page = 0x7f00_0000_0000u64;
        for kind in WAIT_KINDS {
            let src = wait_hook_source(kind, STATE, 0, page + 0x800, VDSO);
            let a = asm::assemble(&src, page, asm::Bits::B64, &|_| None).unwrap_or_else(|e| panic!("{kind:?}: {e}\n{src}"));
            assert!(a.bytes.len() < 0x400, "{kind:?} is {} bytes", a.bytes.len());
            let ins: Vec<_> = Decoder::with_ip(64, &a.bytes, page, DecoderOptions::NONE).iter().collect();
            // The thread key is the SysV thread pointer (D13).
            assert!(ins.iter().any(|i| i.segment_prefix() == iced_x86::Register::FS), "{kind:?}");
            // Real time comes through the stored vDSO pointer.
            let ptr = a.labels["h_vdso_clock"];
            assert_eq!(a.bytes[(ptr - page) as usize..][..8], VDSO.to_le_bytes(), "{kind:?}");
            let calls: Vec<_> = ins.iter().filter(|i| i.mnemonic() == Mnemonic::Call).collect();
            assert!(calls.iter().any(|i| i.is_ip_rel_memory_operand() && i.ip_rel_memory_address() == ptr), "{kind:?}");
            // The original is called once, after the guard is left.
            let tramp: Vec<_> = calls.iter().filter(|i| i.near_branch_target() == page + 0x800).collect();
            assert_eq!(tramp.len(), 1, "{kind:?}");
            // The cond's clock comes from its flags word.
            let flags = ins.iter().any(|i| i.memory_base() == iced_x86::Register::R12 && i.memory_displacement64() == COND_FLAGS_OFFSET);
            assert_eq!(flags, kind == Kind::CondTimedwait, "{kind:?}");
        }
    }

    #[test]
    fn got_template_calls_the_original_through_its_pointer() {
        let page = 0x7f00_0000_0000u64;
        let vdso = 0x7ffd_1234_5000u64;
        let src = hook_source(Kind::GettimeofdayGot, Abi::Sysv, STATE, 8, vdso);
        let a = asm::assemble(&src, page, asm::Bits::B64, &|_| None).unwrap();
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

    impl LocalState {
        /// `unscale(key, slot, game, real now)`.
        fn unscale(&self, key: u64, slot: u64, game: u64, now: u64) -> u64 {
            let out: u64;
            unsafe {
                std::arch::asm!(
                    "call {f}",
                    f = in(reg) self.0 + OFF_UNSCALE,
                    inout("rcx") key => _,
                    inout("rdx") slot => _,
                    inout("r8") game => _,
                    inout("r9") now => _,
                    out("rax") out,
                    out("r10") _,
                    out("r11") _,
                    out("xmm0") _,
                );
            }
            out
        }
        fn get(&self, off: u64) -> u64 {
            unsafe { std::ptr::read_volatile((self.0 + off) as *const u64) }
        }
        fn get32(&self, off: u64) -> u32 {
            unsafe { std::ptr::read_volatile((self.0 + off) as *const u32) }
        }
    }

    impl Drop for LocalState {
        fn drop(&mut self) {
            unsafe { libc::munmap(self.0 as *mut libc::c_void, super::super::STATE_PAGE_SIZE as usize) };
        }
    }

    const KEY: u64 = 0x7f00_dead_b000;

    #[test]
    fn unscale_inverts_scale_for_every_slot_kind() {
        const S: u64 = 1_000_000_000;
        let st = LocalState::new(2.0);
        let slot = |n: u64| OFF_SLOTS + n * SLOT_SIZE;
        for n in 0..SLOT_COUNT as u64 {
            // A fresh page per slot: REALTIME and gettimeofday's slots start from each other
            // (`realtime_and_gettimeofday_share_one_clock`).
            let st = LocalState::new(2.0);
            // A slot never used: the game's deadline is real time already, and the slot stays unused.
            assert_eq!(st.unscale(KEY, n, 1234 * S, 1000 * S), 1234 * S, "slot {n}");
            assert_eq!(st.get32(slot(n) + SLOT_GEN), 0, "slot {n}");
            // In use at 2.0: real time 10 s later is game time 20 s later, and back.
            assert_eq!(st.call(OFF_SCALE, KEY, n, 1000 * S), 1000 * S);
            let game = st.call(OFF_SCALE, KEY, n, 1010 * S);
            assert_eq!(game, 1020 * S);
            // A deadline 20 ms of game time ahead is 10 ms of real time ahead.
            assert_eq!(st.unscale(KEY, n, game + 20_000_000, 1010 * S), 1010 * S + 10_000_000, "slot {n}");
            // A deadline before the slot's base is before real0; never below 0.
            assert_eq!(st.unscale(KEY, n, 998 * S, 1010 * S), 999 * S);
        }
        // Far enough back, the real time would be negative: 0 instead.
        let n = 31;
        st.call(OFF_SCALE, KEY, n, 1000 * S);
        st.put(slot(n) + SLOT_REAL0, S);
        st.put(slot(n) + SLOT_FAKE0, 100 * S);
        assert_eq!(st.unscale(KEY, n, 0, 2 * S), 0);
        // The speed changes (generation 2, 0.5) and no clock was read since: unscale rebases the
        // slot exactly as scale would have at the real time now, so the two stay inverses.
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 1000 * S), 1000 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 1010 * S), 1020 * S);
        st.put(OFF_SPEED, 0.5f64.to_bits());
        st.put32(OFF_GEN, 2);
        let n = 3;
        assert_eq!(st.unscale(KEY, n, 1030 * S, 1012 * S), 1024 * S, "game time is 1024 s now; 6 s more at 0.5x take 12 s");
        assert_eq!((st.get32(slot(n) + SLOT_GEN), st.get(slot(n) + SLOT_REAL0), st.get(slot(n) + SLOT_FAKE0)), (2, 1012 * S, 1024 * S));
        assert_eq!(st.get(slot(n) + SLOT_SPEED), 0.5f64.to_bits());
        assert_eq!(st.get32(slot(n) + SLOT_SEQ) % 2, 0, "the sequence is even after the write");
        assert_eq!(st.call(OFF_SCALE, KEY, n, 1016 * S), 1026 * S, "scale continues from the rebased slot");
        // The lock stays held by another thread: unscale reads the slot without it.
        st.put32(OFF_LOCK, 0x1234_5679);
        assert_eq!(st.unscale(KEY, n, 1026 * S, 1020 * S), 1016 * S);
        // A slot mid-update can't be trusted, and an unused one has no game time: the deadline
        // passes through.
        st.put32(slot(n) + SLOT_SEQ, st.get32(slot(n) + SLOT_SEQ) + 1);
        assert_eq!(st.unscale(KEY, n, 1026 * S, 1020 * S), 1026 * S);
        st.put32(OFF_LOCK, 0);
    }

    #[test]
    fn unscale_saturates_far_deadlines_instead_of_making_them_past() {
        const S: u64 = 1_000_000_000;
        // At 0.1x a wait-forever deadline (tv_sec = INT32_MAX on MONOTONIC, ~2.1e18 ns) is
        // ~2.1e19 ns of real time away: past i64. It stays far in the future.
        let st = LocalState::new(0.1);
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1000 * S), 1000 * S);
        assert_eq!(st.unscale(KEY, 1, i32::MAX as u64 * S, 1001 * S), i64::MAX as u64);
        assert_eq!(st.unscale(KEY, 1, i64::MAX as u64, 1001 * S), i64::MAX as u64, "game − fake0 within range, quotient not");
        // At 10x nothing overflows: a near deadline is still converted.
        assert_eq!(st.unscale(KEY, 1, 1000 * S + 100_000_000, 1001 * S), 1001 * S);
        // A huge real0 + quotient wraps i64: saturated too.
        let st = LocalState::new(1.0);
        st.call(OFF_SCALE, KEY, 2, 1000 * S);
        st.put(OFF_SLOTS + 2 * SLOT_SIZE + SLOT_REAL0, i64::MAX as u64 - S);
        assert_eq!(st.unscale(KEY, 2, 1000 * S + 2 * S, 0), i64::MAX as u64);
        // And far in the past is 0, still.
        let st = LocalState::new(0.1);
        st.call(OFF_SCALE, KEY, 1, i64::MAX as u64 / 2);
        assert_eq!(st.unscale(KEY, 1, 0, i64::MAX as u64 / 2), 0);
    }

    #[test]
    fn realtime_and_gettimeofday_share_one_clock() {
        const S: u64 = 1_000_000_000;
        let (rt, tod) = (SLOT_REALTIME as u64, SLOT_GETTIMEOFDAY as u64);
        // gettimeofday used first (µs), at 2.0 since real 1000 s.
        let st = LocalState::new(2.0);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1000 * 1_000_000), 1000 * 1_000_000);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1010 * 1_000_000), 1020 * 1_000_000);
        // REALTIME read for the first time 10 s later starts at gettimeofday's game time, not
        // real time, with the sub-µs part of the reading kept.
        // (1010 s + 1.5 µs is gettimeofday's 1010.000001 s, 1020.000002 s of game time; the
        // 500 ns left over run at 2x from a real0 moved back by them.)
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1010 * S + 1_500), 1020 * S + 3_000);
        // On the µs grid REALTIME is exactly gettimeofday × 1000.
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1012 * S), 1024 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1012 * 1_000_000), 1024 * 1_000_000);
        // The other way round: REALTIME first, gettimeofday starts from it (in µs, rounded down).
        let st = LocalState::new(0.5);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1000 * S), 1000 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1010 * 1_000_000), 1005 * 1_000_000);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1012 * S), 1006 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1012 * 1_000_000), 1006 * 1_000_000);
        // Other slots stay independent: MONOTONIC starts at real time.
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1012 * S), 1012 * S);
    }

    /// A SysV wait hook in this process, on a stand-in original that copies the deadline it was
    /// given (and its other arguments) to `seen`, with a stand-in vDSO clock returning `now`.
    struct LocalWait {
        page: u64,
        hook: u64,
        seen: u64,
        now: u64,
    }

    impl LocalWait {
        fn new(st: &LocalState, kind: Kind) -> LocalWait {
            let prot = libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC;
            let p = unsafe { libc::mmap(std::ptr::null_mut(), 0x2000, prot, libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0) };
            assert_ne!(p, libc::MAP_FAILED);
            let page = p as u64;
            let (orig, vdso, seen, now, hook) = (page, page + 0x100, page + 0x200, page + 0x240, page + 0x1000);
            let dl = match kind {
                Kind::CondClockwait => "rcx",
                Kind::SemTimedwait => "rsi",
                _ => "rdx",
            };
            // seen: [0] the deadline's tv_sec, [8] tv_nsec, [10] rdi, [18] rsi, [20] rdx, [28] rcx,
            // [30] the clock id the vDSO was asked for.
            let orig_src = format!(
                "mov rax, {seen:#x}\ntest {dl}, {dl}\nje o_args\nmov r8, qword ptr [{dl}]\nmov qword ptr [rax], r8\nmov r8, qword ptr [{dl}+8]\nmov qword ptr [rax+8], r8\n\
                 o_args:\nmov qword ptr [rax+10], rdi\nmov qword ptr [rax+18], rsi\nmov qword ptr [rax+20], rdx\nmov qword ptr [rax+28], rcx\nmov eax, #77\nret\n"
            );
            let vdso_src = format!(
                "mov rax, {now:#x}\nmov r8, qword ptr [rax]\nmov qword ptr [rsi], r8\nmov r8, qword ptr [rax+8]\nmov qword ptr [rsi+8], r8\n\
                 mov rax, {clock:#x}\nmov qword ptr [rax], rdi\nxor eax, eax\nret\n",
                clock = seen + 0x30
            );
            let hook_src = wait_hook_source(kind, st.0, 0, orig, vdso);
            for (at, src) in [(orig, orig_src), (vdso, vdso_src), (hook, hook_src)] {
                let a = asm::assemble(&src, at, asm::Bits::B64, &|_| None).unwrap_or_else(|e| panic!("{e}\n{src}"));
                unsafe { std::ptr::copy_nonoverlapping(a.bytes.as_ptr(), at as *mut u8, a.bytes.len()) };
            }
            LocalWait { page, hook, seen, now }
        }
        /// Call the hook with these four arguments at real time `now` (s, ns); returns its result
        /// and the deadline the original saw.
        fn call(&self, now: (u64, u64), args: [u64; 4]) -> (u64, (u64, u64)) {
            unsafe {
                std::ptr::write_volatile(self.now as *mut [u64; 2], [now.0, now.1]);
                std::ptr::write_volatile(self.seen as *mut [u64; 7], [0; 7]);
                let f: extern "C" fn(u64, u64, u64, u64) -> u64 = std::mem::transmute(self.hook as usize);
                let r = f(args[0], args[1], args[2], args[3]);
                let seen = std::ptr::read_volatile(self.seen as *const [u64; 7]);
                (r, (seen[0], seen[1]))
            }
        }
        fn args_seen(&self) -> [u64; 5] {
            let s = unsafe { std::ptr::read_volatile(self.seen as *const [u64; 7]) };
            [s[2], s[3], s[4], s[5], s[6]]
        }
    }

    impl Drop for LocalWait {
        fn drop(&mut self) {
            unsafe { libc::munmap(self.page as *mut libc::c_void, 0x2000) };
        }
    }

    fn nest_is_empty(st: &LocalState) -> bool {
        let nest = unsafe { std::slice::from_raw_parts((st.0 + OFF_NEST) as *const u64, (NEST_COUNT * 2) as usize) };
        nest.iter().step_by(2).all(|&k| k == 0)
    }

    #[test]
    fn wait_hooks_wait_for_the_real_time_of_a_game_deadline() {
        const S: u64 = 1_000_000_000;
        let st = LocalState::new(2.0);
        // MONOTONIC (slot 1) in use at 2.0 since real 1000 s; REALTIME (slot 0) never read.
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1000 * S), 1000 * S);
        // At real 1010 s the game reads 1020 s and waits until 1020.02 s: 1010.01 s of real time.
        let deadline = [1020u64, 20_000_000];
        let d = deadline.as_ptr() as u64;
        let real = (1010, 10_000_000);
        let w = LocalWait::new(&st, Kind::ClockNanosleep);
        assert_eq!(w.call((1010, 0), [1, 1, d, 0xbad]), (77, real), "clock_nanosleep(MONOTONIC, TIMER_ABSTIME)");
        let a = w.args_seen();
        assert_eq!((a[0], a[1], a[3], a[4]), (1, 1, 0xbad, 1), "the other arguments pass unchanged; the vDSO read clock 1");
        assert_ne!(a[2], d, "the deadline argument is the converted copy");
        assert_eq!(deadline, [1020, 20_000_000], "the game's timespec is never written");
        // Relative sleeps, clocks not scaled (THREAD_CPUTIME_ID = 3, CPU clocks < 0), unused slots
        // (REALTIME here), and invalid deadlines pass through unchanged.
        assert_eq!(w.call((1010, 0), [1, 0, d, 0]).1, (1020, 20_000_000), "no TIMER_ABSTIME");
        assert_eq!(w.call((1010, 0), [3, 1, d, 0]).1, (1020, 20_000_000), "THREAD_CPUTIME_ID");
        assert_eq!(w.call((1010, 0), [(-6i64) as u64, 1, d, 0]).1, (1020, 20_000_000), "a CPU clock");
        assert_eq!(w.call((1010, 0), [0, 1, d, 0]).1, (1020, 20_000_000), "REALTIME was never read");
        let bad = [1020u64, 1_000_000_000];
        assert_eq!(w.call((1010, 0), [1, 1, bad.as_ptr() as u64, 0]).1, (1020, 1_000_000_000), "tv_nsec out of range");
        let neg = [(-5i64) as u64, 0];
        assert_eq!(w.call((1010, 0), [1, 1, neg.as_ptr() as u64, 0]).1, ((-5i64) as u64, 0), "a negative tv_sec");
        let far = [u64::MAX / 2, 0];
        assert_eq!(w.call((1010, 0), [1, 1, far.as_ptr() as u64, 0]).1, (u64::MAX / 2, 0), "too far for i64 ns");
        assert_eq!(w.call((1010, 0), [1, 1, 0, 0]).0, 77, "a null deadline reaches the original");
        assert!(nest_is_empty(&st), "the guard is not held after the call");

        // The other waits, by where their deadline and clock are.
        let mut mono_cond = [0u32; 12];
        mono_cond[(COND_FLAGS_OFFSET / 4) as usize] = COND_CLOCK_MONOTONIC_MASK | 1; // pshared too
        let rt_cond = [0u32; 12];
        let w = LocalWait::new(&st, Kind::CondTimedwait);
        assert_eq!(w.call((1010, 0), [mono_cond.as_ptr() as u64, 0x5555, d, 0]), (77, real), "cond_timedwait on a MONOTONIC cond");
        assert_eq!(w.call((1010, 0), [rt_cond.as_ptr() as u64, 0x5555, d, 0]).1, (1020, 20_000_000), "a REALTIME cond (slot unused)");
        assert_eq!(w.args_seen()[1], 0x5555, "the mutex passes unchanged");
        let w = LocalWait::new(&st, Kind::CondClockwait);
        assert_eq!(w.call((1010, 0), [0x1111, 0x2222, 1, d]), (77, real), "cond_clockwait(MONOTONIC)");
        let w = LocalWait::new(&st, Kind::SemClockwait);
        assert_eq!(w.call((1010, 0), [0x1111, 1, d, 0]), (77, real), "sem_clockwait(MONOTONIC)");
        // sem_timedwait is REALTIME: once slot 0 is in use, it converts too.
        assert_eq!(st.call(OFF_SCALE, KEY, 0, 1000 * S), 1000 * S);
        let w = LocalWait::new(&st, Kind::SemTimedwait);
        assert_eq!(w.call((1010, 0), [0x1111, d, 0, 0]), (77, real), "sem_timedwait (REALTIME)");
        assert!(nest_is_empty(&st));
        // Another thread holds the lock and is stuck: the deadline is still converted, from the
        // lock-free slot read, and no nesting entry is left behind.
        st.put32(OFF_LOCK, 0x1234_5679);
        assert_eq!(w.call((1010, 0), [0x1111, d, 0, 0]), (77, real), "with the lock stuck");
        assert!(nest_is_empty(&st));
        st.put32(OFF_LOCK, 0);
    }

    #[test]
    fn a_speed_change_rebases_realtime_and_gettimeofday_together() {
        const S: u64 = 1_000_000_000;
        const US: u64 = 1_000_000;
        let (rt, tod) = (SLOT_REALTIME as u64, SLOT_GETTIMEOFDAY as u64);
        // Both read at 2.0 from real 1000 s.
        let st = LocalState::new(2.0);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1000 * US), 1000 * US);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1000 * S), 1000 * S);
        // 1.0 at real 1001 s; only gettimeofday is read then. REALTIME is next read 59 s later.
        st.put(OFF_SPEED, 1.0f64.to_bits());
        st.put32(OFF_GEN, 2);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1001 * US), 1002 * US);
        assert_eq!(st.get32(OFF_SLOTS + rt * SLOT_SIZE + SLOT_GEN), 2, "REALTIME was rebased with it");
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1060 * S), 1061 * S, "not 1120 s (59 s more at 2x)");
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1100 * US), 1101 * US);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1100 * S), 1101 * S);
        // A gettimeofday deadline (1101.02 s) waited for on REALTIME converts to 20 ms from now.
        let deadline = [1101u64, 20_000_000];
        let w = LocalWait::new(&st, Kind::SemTimedwait);
        assert_eq!(w.call((1100, 0), [0x1111, deadline.as_ptr() as u64, 0, 0]).1, (1100, 20_000_000));
        // The same through unscale's rebase: 0.5 at real 1100 s, the first touch is a REALTIME
        // wait (unscale), and gettimeofday follows.
        st.put(OFF_SPEED, 0.5f64.to_bits());
        st.put32(OFF_GEN, 3);
        assert_eq!(w.call((1100, 0), [0x1111, deadline.as_ptr() as u64, 0, 0]).1, (1100, 40_000_000));
        assert_eq!(st.get32(OFF_SLOTS + tod * SLOT_SIZE + SLOT_GEN), 3, "gettimeofday was rebased with it");
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1140 * US), 1121 * US);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1140 * S), 1121 * S);
        // A slot first used while its partner is still at an older generation: the partner is
        // rebased to now first, then the new slot starts from it.
        let st = LocalState::new(2.0);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1000 * US), 1000 * US);
        st.put(OFF_SPEED, 1.0f64.to_bits());
        st.put32(OFF_GEN, 2);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1010 * S), 1020 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1050 * US), 1060 * US, "at 1.0 since 1010 s, not 2.0 until its own read");
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1050 * S), 1060 * S);
    }

    #[test]
    fn realtime_waits_use_gettimeofday_when_only_it_was_read() {
        const S: u64 = 1_000_000_000;
        const US: u64 = 1_000_000;
        // The game reads only gettimeofday (2.0 since real 1000 s) and builds a REALTIME deadline
        // from it: at real 1010 s it reads 1020 s and waits until 1020.02 s.
        let st = LocalState::new(2.0);
        assert_eq!(st.call(OFF_SCALE, KEY, SLOT_GETTIMEOFDAY as u64, 1000 * US), 1000 * US);
        let deadline = [1020u64, 20_000_500];
        let d = deadline.as_ptr() as u64;
        let w = LocalWait::new(&st, Kind::SemTimedwait);
        assert_eq!(w.call((1010, 0), [0x1111, d, 0, 0]), (77, (1010, 10_000_500)), "sem_timedwait (REALTIME) via gettimeofday's slot");
        assert_eq!(st.get32(OFF_SLOTS + SLOT_REALTIME as u64 * SLOT_SIZE + SLOT_GEN), 0, "REALTIME's slot stays unused");
        // MONOTONIC is not REALTIME: unused, passed through.
        let w = LocalWait::new(&st, Kind::ClockNanosleep);
        assert_eq!(w.call((1010, 0), [1, 1, d, 0]).1, (1020, 20_000_500));
        // Once REALTIME was read too it starts from gettimeofday's game time, so converting
        // through it gives the same real time.
        assert_eq!(st.call(OFF_SCALE, KEY, SLOT_REALTIME as u64, 1010 * S), 1020 * S);
        let w = LocalWait::new(&st, Kind::SemTimedwait);
        assert_eq!(w.call((1010, 0), [0x1111, d, 0, 0]).1, (1010, 10_000_250), "sem_timedwait via REALTIME's slot");
        assert!(nest_is_empty(&st));
        // A wait-forever deadline at 0.1x stays far in the future through gettimeofday's slot too.
        let st = LocalState::new(0.1);
        assert_eq!(st.call(OFF_SCALE, KEY, SLOT_GETTIMEOFDAY as u64, 1000 * US), 1000 * US);
        let forever = [i64::MAX as u64 / S, 0];
        let w = LocalWait::new(&st, Kind::SemTimedwait);
        let (_, (sec, _)) = w.call((1010, 0), [0x1111, forever.as_ptr() as u64, 0, 0]);
        assert_eq!(sec, i64::MAX as u64 / S, "saturated, not 0");
    }

    /// Start landing: the sentinel speed with a new generation, as `speed::land` writes it.
    fn start_landing(st: &LocalState, gen: u32) {
        st.put(OFF_SPEED, LANDING.to_bits());
        st.put32(OFF_GEN, gen);
    }

    #[test]
    fn landing_glides_each_slot_onto_real_time() {
        const S: u64 = 1_000_000_000;
        let slot = |n: u64| OFF_SLOTS + n * SLOT_SIZE;
        let mask = |st: &LocalState| st.get32(OFF_LAND_MASK);
        let st = LocalState::new(2.0);
        // Slot 1 ahead: 2.0 since real 1000 s. Slot 3 behind: 0.5 (set by hand) since 1000 s.
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1000 * S), 1000 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 1000 * S), 1000 * S);
        st.put(slot(3) + SLOT_SPEED, 0.5f64.to_bits());
        start_landing(&st, 2);
        // Ahead (1024 s at real 1012 s): continues from its game time at LAND_SLOW, never below real.
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1012 * S), 1024 * S);
        assert_eq!(st.get(slot(1) + SLOT_SPEED), LAND_SLOW.to_bits());
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1020 * S), 1028 * S);
        assert_eq!(mask(&st), 0, "not landed yet");
        // A wait while ahead: the deadline is reached at the earlier of F⁻¹ and real = game.
        assert_eq!(st.unscale(KEY, 1, 1029 * S, 1020 * S), 1022 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1036 * S), 1036 * S, "lands on real time");
        assert_eq!(mask(&st), 1 << 1);
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1040 * S), 1040 * S, "and stays on it");
        assert_eq!(st.unscale(KEY, 1, 1040 * S + 20_000_000, 1040 * S), 1040 * S + 20_000_000, "not 1044.04 s");
        // Behind (1006 s at real 1012 s): LAND_FAST, never past real time.
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 1012 * S), 1006 * S);
        assert_eq!(st.get(slot(3) + SLOT_SPEED), LAND_FAST.to_bits());
        assert_eq!(st.unscale(KEY, 3, 1010 * S, 1014 * S), 1014 * S, "max(F⁻¹ = 1014 s, 1010 s)");
        assert_eq!(st.unscale(KEY, 3, 1007 * S, 1012 * S), 1012 * S + 500_000_000, "max(F⁻¹ = 1012.5 s, 1007 s)");
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 1015 * S), 1012 * S);
        assert_eq!(mask(&st), 1 << 1);
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 1020 * S), 1020 * S, "min(1022 s, real)");
        assert_eq!(mask(&st), (1 << 1) | (1 << 3));
        assert_eq!(st.unscale(KEY, 3, 1020 * S + 20_000_000, 1020 * S), 1020 * S + 20_000_000, "not F⁻¹ = 1019.01 s");
        // A slot first used while landing is on real time at once.
        assert_eq!(st.call(OFF_SCALE, KEY, 5, 1020 * S), 1020 * S);
        assert_eq!(mask(&st) & (1 << 5), 1 << 5);
        // The lock is stuck: the lock-free read is clamped too.
        st.put32(OFF_LOCK, 0x1234_5679);
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1050 * S), 1050 * S);
        st.put32(OFF_LOCK, 0);
        // A normal speed of 0.5 or 2.0 (not landing) is never clamped.
        let st = LocalState::new(0.5);
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1000 * S), 1000 * S);
        assert_eq!(st.call(OFF_SCALE, KEY, 1, 1010 * S), 1005 * S);
        assert_eq!(st.unscale(KEY, 1, 1006 * S, 1010 * S), 1012 * S);
        assert_eq!(st.get32(OFF_LAND_MASK), 0);
    }

    #[test]
    fn landing_picks_each_paired_clocks_own_direction() {
        const S: u64 = 1_000_000_000;
        const US: u64 = 1_000_000;
        let (rt, tod) = (SLOT_REALTIME as u64, SLOT_GETTIMEOFDAY as u64);
        let slot = |n: u64| OFF_SLOTS + n * SLOT_SIZE;
        let st = LocalState::new(2.0);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1000 * US), 1000 * US);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1000 * S), 1000 * S);
        // Make REALTIME behind real time by hand (gettimeofday stays ahead).
        st.put(slot(rt) + SLOT_FAKE0, 990 * S);
        start_landing(&st, 2);
        // gettimeofday's read rebases REALTIME too, each from its own game time vs real.
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1001 * US), 1002 * US);
        assert_eq!(st.get(slot(tod) + SLOT_SPEED), LAND_SLOW.to_bits());
        assert_eq!(st.get32(slot(rt) + SLOT_GEN), 2);
        assert_eq!(st.get(slot(rt) + SLOT_SPEED), LAND_FAST.to_bits(), "REALTIME is at 992 s at real 1001 s");
        // The other way round, through unscale's rebase (a REALTIME wait first).
        let st = LocalState::new(2.0);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1000 * US), 1000 * US);
        assert_eq!(st.call(OFF_SCALE, KEY, rt, 1000 * S), 1000 * S);
        st.put(slot(tod) + SLOT_FAKE0, 990 * US);
        start_landing(&st, 2);
        st.unscale(KEY, rt, 1003 * S, 1001 * S);
        assert_eq!(st.get(slot(rt) + SLOT_SPEED), LAND_SLOW.to_bits());
        assert_eq!(st.get(slot(tod) + SLOT_SPEED), LAND_FAST.to_bits());
        // The partner's clamp sets its own bit on its own read.
        assert_eq!(st.get32(OFF_LAND_MASK), 0);
        assert_eq!(st.call(OFF_SCALE, KEY, tod, 1010 * US), 1010 * US);
        assert_eq!(st.get32(OFF_LAND_MASK), 1 << tod);
    }

    #[test]
    fn tick32_lands_across_the_32_bit_wrap() {
        let st = LocalState::new(2.0);
        let tick = |real: u64| st.call(OFF_SCALE32, KEY, 10, real) as u32;
        assert_eq!(tick(0xffff_ff00), 0xffff_ff00);
        // 0x200 ms ahead after the wrap.
        assert_eq!(tick(0x100), 0x300);
        start_landing(&st, 2);
        assert_eq!(tick(0x100), 0x300);
        assert_eq!(st.get(OFF_SLOTS + 10 * SLOT_SIZE + SLOT_SPEED), LAND_SLOW.to_bits());
        assert_eq!(tick(0x300), 0x400);
        assert_eq!(st.get32(OFF_LAND_MASK), 0);
        assert_eq!(tick(0x500), 0x500);
        assert_eq!(st.get32(OFF_LAND_MASK), 1 << 10);
        assert_eq!(tick(0x600), 0x600);
    }

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
        // Another thread holds the lock and never lets go: after the bounded spin, `scale` reads
        // the slot without the lock (the hook-level path is `a_hook_keeps_game_time_while_the_lock_is_stuck`).
        st.put32(OFF_LOCK, 0x1234_5679);
        assert_eq!(st.call(OFF_SCALE, KEY, 9, 2000), 3000);
        // A slot caught mid-update (odd sequence) can't be trusted: real time is passed through.
        let seq = OFF_SLOTS + 9 * SLOT_SIZE + SLOT_SEQ;
        st.put32(seq, 1);
        assert_eq!(st.call(OFF_SCALE, KEY, 9, 2000), 2000);
        // A slot never used has no game time yet.
        assert_eq!(st.call(OFF_SCALE, KEY, 3, 5000), 5000);
    }

    /// What a Win64 call to a hook left in the registers the ABI says it must preserve.
    #[derive(Debug, PartialEq)]
    struct Saved {
        rbx: u64,
        rsi: u64,
        rdi: u64,
        r12: u64,
        r13: u64,
        r14: u64,
        r15: u64,
        xmm6: f64,
    }

    const SENTINELS: Saved = Saved {
        rbx: 0x1111_0000_0000_00b0,
        rsi: 0x1111_0000_0000_0051,
        rdi: 0x1111_0000_0000_0d1,
        r12: 0x1111_0000_0000_0012,
        r13: 0x1111_0000_0000_0013,
        r14: 0x1111_0000_0000_0014,
        r15: 0x1111_0000_0000_0015,
        xmm6: 6.25,
    };

    /// Call `f` as a Win64 function (32 bytes of shadow space, rsp 16-aligned at the call) with
    /// `rcx = arg` and the sentinels in every callee-saved register; returns `rax` and what the
    /// callee-saved registers held afterwards.
    fn call_win64(f: u64, arg: u64) -> (u64, Saved) {
        let s = &SENTINELS;
        let (rax, rbx, rsi, rdi, r12, r13, r14, r15, xmm6): (u64, u64, u64, u64, u64, u64, u64, u64, f64);
        unsafe {
            std::arch::asm!(
                // rbx can't be an asm operand: save it by hand, and keep every operand in a
                // named register so none of them lands in rbx. push + 0x28 keeps rsp aligned.
                "push rbx",
                "sub rsp, 0x28",
                "mov rbx, r10",
                "call rax",
                "mov r11, rbx",
                "add rsp, 0x28",
                "pop rbx",
                inout("rax") f => rax,
                inout("r10") s.rbx => _,
                out("r11") rbx,
                inout("rcx") arg => _,
                inout("rsi") s.rsi => rsi,
                inout("rdi") s.rdi => rdi,
                inout("r12") s.r12 => r12,
                inout("r13") s.r13 => r13,
                inout("r14") s.r14 => r14,
                inout("r15") s.r15 => r15,
                inout("xmm6") s.xmm6 => xmm6,
                out("rdx") _, out("r8") _, out("r9") _,
                out("xmm0") _, out("xmm1") _, out("xmm2") _, out("xmm3") _, out("xmm4") _, out("xmm5") _,
            );
        }
        (rax, Saved { rbx, rsi, rdi, r12, r13, r14, r15, xmm6 })
    }

    /// A Win64 `Tick64` hook on a stand-in `GetTickCount64` (returns the `u64` at `value`),
    /// called on a thread with a fake TEB in GS (`gs:[30]` = the TEB), as under Wine.
    struct LocalHook {
        page: u64,
        hook: u64,
        value: u64,
    }

    impl LocalHook {
        fn new(st: &LocalState) -> LocalHook {
            let prot = libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC;
            let p = unsafe { libc::mmap(std::ptr::null_mut(), 0x1000, prot, libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0) };
            assert_ne!(p, libc::MAP_FAILED);
            let page = p as u64;
            let (orig, value, hook) = (page, page + 0x100, page + 0x200);
            // The original clobbers the Win64 volatile registers, as a real one may.
            let orig_src = format!("mov rax, {value:#x}\nmov rax, qword ptr [rax]\nxor ecx, ecx\nxor edx, edx\nxor r8d, r8d\nxor r9d, r9d\nxor r10d, r10d\nxor r11d, r11d\nxorps xmm0, xmm0\nxorps xmm5, xmm5\nret\n");
            let hook_src = hook_source(Kind::Tick64, Abi::Win64, st.0, 11, orig);
            for (at, src) in [(orig, orig_src), (hook, hook_src)] {
                let a = asm::assemble(&src, at, asm::Bits::B64, &|_| None).unwrap_or_else(|e| panic!("{e}\n{src}"));
                unsafe { std::ptr::copy_nonoverlapping(a.bytes.as_ptr(), at as *mut u8, a.bytes.len()) };
            }
            LocalHook { page, hook, value }
        }
        /// Call the hook with the stand-in returning `v`.
        fn call(&self, v: u64) -> (u64, Saved) {
            unsafe { std::ptr::write_volatile(self.value as *mut u64, v) };
            call_win64(self.hook, 0)
        }
    }

    impl Drop for LocalHook {
        fn drop(&mut self) {
            unsafe { libc::munmap(self.page as *mut libc::c_void, 0x1000) };
        }
    }

    /// Run `f` on a new thread whose GS base is a fake TEB (Rust and glibc use FS, not GS).
    fn with_fake_teb(f: impl FnOnce(u64) + Send + 'static) {
        std::thread::spawn(move || {
            let teb = Box::leak(Box::new([0u64; 32]));
            let addr = teb.as_ptr() as u64;
            teb[6] = addr; // TEB.Self at 0x30
            const ARCH_SET_GS: libc::c_long = 0x1001;
            assert_eq!(unsafe { libc::syscall(libc::SYS_arch_prctl, ARCH_SET_GS, addr) }, 0);
            f(addr);
        })
        .join()
        .unwrap();
    }

    #[test]
    fn win64_hook_preserves_callee_saved_registers() {
        with_fake_teb(|teb| {
            let st = LocalState::new(2.0);
            let h = LocalHook::new(&st);
            // Outermost and scaled.
            assert_eq!(h.call(1000), (1000, SENTINELS));
            assert_eq!(h.call(1500), (2000, SENTINELS));
            // Passed through: the lock is held under this thread's own tag (as when a signal
            // handler interrupts its thread inside a hook).
            st.put32(OFF_LOCK, (teb as u32) | 1);
            assert_eq!(h.call(1600), (1600, SENTINELS));
            st.put32(OFF_LOCK, 0);
        });
    }

    #[test]
    fn a_hook_keeps_game_time_while_the_lock_is_stuck() {
        with_fake_teb(|teb| {
            let st = LocalState::new(2.0);
            let h = LocalHook::new(&st);
            assert_eq!(h.call(1000).0, 1000);
            assert_eq!(h.call(2000).0, 3000);
            // Another thread took the lock and is suspended: guard_enter and scale both time out,
            // and the hook still returns game time (from the lock-free slot read).
            st.put32(OFF_LOCK, (teb as u32 ^ 0x1000_0000) | 1);
            let (r, saved) = h.call(3000);
            assert_eq!((r, saved), (5000, SENTINELS), "game time, not real time (3000)");
            // No nesting entry was claimed on that path, so none is left behind.
            let nest = unsafe { std::slice::from_raw_parts((st.0 + OFF_NEST) as *const u64, (NEST_COUNT * 2) as usize) };
            assert!(nest.iter().step_by(2).all(|&k| k == 0), "{nest:x?}");
            // The holder lets go: back to normal.
            st.put32(OFF_LOCK, 0);
            assert_eq!(h.call(4000).0, 7000);
        });
    }
}
