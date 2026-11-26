# 32-bit games on the native engine — design

Date: 2026-11-25. Status: draft for approval.

## Intent

Cheat tables for 32-bit games should run on Starlight's own engine (starlightd) without Cheat Engine, just like 64-bit tables do today. Right now every table for a 32-bit game ends up in Cheat Engine: its scripts use 32-bit registers, and our assembler only builds 64-bit code.

There's also a safety problem to fix along the way. Allocating memory in a 32-bit game process **kills the game** today. Game speed allocates memory first, and a 32-bit game with no table already sends speed to starlightd. So the speed slider can crash a player's game right now.

## What we found (recon on our own PE32 test target under Proton 11)

- **Proton 11's default mode runs a 32-bit game as a real 32-bit Linux process.** The process has an i386 `wine-preloader` (ELF class 1), i386 libc, and `wow64cpu.dll` mapped.
- **With `PROTON_USE_WOW64=1`, a 32-bit game runs in a 64-bit process.** The process has an x86_64 preloader running 32-bit PE code, and the exe is still at 0x400000. This mode is opt-in today, so both kinds of process must work.
- **What already works:** module listing (PE32 `SizeOfImage` included), reads and writes, scans, and PE32 export lookup.
- **What's broken:**
  - `pointer::resolve` reads 8 bytes per step, so chains come out wrong (we saw `0x404580000004d2`).
  - `remote::syscall_site` looks for a 64-bit `syscall` instruction and runs it with 64-bit syscall numbers and registers. In a 32-bit process that kills the target ("did not finish the remote syscall", then the process died).
- **The table corpus:**
  - 29 tables fail only on 32-bit assembly. About 16 of them would run fully natively once this lands.
  - Of those 29, all use `alloc` and 27 use `aobscan`, 17 have pointer records, 12 use x87, 6 use near `alloc`, 5 use `dq`, and 1 uses `pushad`.

## Goals

1. Tables for 32-bit games are routed to the native engine when everything in them assembles. The share of tables that run natively rises measurably on the existing corpus count, from 111/284 today.
2. On a 32-bit game, pointer chains, `alloc`/`free`, the assembler, patches/AOB-exec and Lua (`readPointer`, `writePointer`, `targetIs64Bit`, `autoAssemble`) all behave as CE does for that game.
3. Nothing in starlightd can crash a 32-bit game: any operation that isn't supported is refused with a clear error.
4. 64-bit games behave exactly as before. Every existing test still passes unchanged.

## Non-goals

- **Game speed for 32-bit games (the user's choice A).** starlightd refuses `speed_set` on a 32-bit game, and the app shows "Game speed doesn't work with 32-bit games yet." Native speed for 32-bit games is a later follow-up.
- ELF32 symbol and export lookup for *native Linux* 32-bit games. Module listing, reads and scans already work for them. They are rare in the corpus.
- A separate 32-bit build of starlightd.
- Changing how games are launched. We never turn on `PROTON_USE_WOW64` for the player.

## Anti-goals

- Anything that crashes or hangs a player's game. When we're unsure, refuse.
- Any change in behavior for 64-bit games.
- Anything from the standing list: no anti-cheat evasion, no multiplayer features, and no Lua capability that reaches the player's machine.

## Approaches considered

1. **One daemon that knows both sizes (picked).** At attach, starlightd works out two facts about the game and stores them on the target. Pointer size, remote calls, the assembler, Lua and speed all read from those facts. This means one binary and one code path, and it covers both Proton modes.
2. **A separate i386 daemon for 32-bit games.** Rejected: two binaries to build, ship and install, every fix lands twice, and we'd still need the same detection to pick which daemon to start.
3. **Always launch games in Proton's 64-bit mode (`PROTON_USE_WOW64=1`).** This would avoid the 32-bit remote-call work. Rejected:
   - the mode is opt-in and can break games;
   - it doesn't help when we attach to a game the player started;
   - it changes the player's launch.

The user picked approach 1.

## Design

### Two facts per target

- **`process_bits` (32 or 64): how to talk to the kernel inside the game.**
  - It comes from the ELF class of `/proc/<pid>/exe`: `wine-preloader` (i386) versus `wine64-preloader`, or a native game binary.
  - It is known at `attach`.
- **`code_bits` (32, 64 or unknown): what the game's own code is.**
  - For a Wine/Proton game, it comes from the PE optional-header magic of the game's exe: 0x10b means 32, 0x20b means 64.
  - For a native Linux game (no PE modules at all), it equals `process_bits`.
  - **The game's exe** is the module named by an optional `main_module` param on `attach`. The desktop already knows it and passes it. Without the param, it is the first mapped `.exe` that isn't one of Wine's own programs (`start.exe`, `wineboot.exe`, `services.exe`, `winedevice.exe`, `plugplay.exe`, `explorer.exe`, `rpcss.exe`, `svchost.exe`, `conhost.exe`).
  - System DLLs never decide it. A WoW64 process maps 64-bit `ntdll` and `wow64*.dll` next to a 32-bit exe.

The combinations:

| | `process_bits` | `code_bits` |
|---|---|---|
| Proton default, 32-bit game | 32 | 32 |
| Proton WoW64 mode, 32-bit game | 64 | 32 |
| Any 64-bit game | 64 | 64 |

**`code_bits` can be unknown at first.** The desktop attaches before `waitForModules`, so on a fresh launch the exe may not be mapped yet. Because of that, `code_bits` is resolved lazily:

- Every operation that depends on it re-checks the modules until it is known, then caches it.
- While it is still unknown, those operations (pointer resolve without `pointer_size`, `assemble` with a handle and no `bits`, `alloc`, `patch`, `aob_exec`, hooks, speed and Lua's pointer functions) refuse with `target_not_ready`.
- Plain reads, writes, scans and module listing never need it.
- **There's no guessing 64.** A wrong guess is exactly the crash the anti-goals forbid.

**The RPC surface:**

- `attach` returns `{ handle, process_bits, code_bits }`, with `code_bits` set to null while unknown.
- `target_info { handle }` returns the same, current values.
- Older clients ignore the extra fields.

### Pointers (`code_bits`)

- `pointer::resolve` takes a pointer size of 4 or 8. With 4, each step reads a `u32`, zero-extends it, and adds the offset with wrapping in 32 bits.
- The `resolve_pointer` RPC uses the target's `code_bits` by default. It also accepts an optional `pointer_size` for callers that know better.
- `packages/engine/src/pointer-chain.ts` drops its 8-byte assumption in the comment and the code, and leaves the size to the daemon.
- **Lua:** `readPointer` and `writePointer` use 4 bytes when `code_bits` is 32, and `targetIs64Bit()` returns `code_bits == 64`.

### Remote calls (`process_bits`)

**Which thread makes the call.** A remote call runs only on a stopped thread whose code segment matches the instruction we're going to run:

- `cs == 0x33` (64-bit) for `syscall`;
- `cs == 0x23` (32-bit) for `int 0x80`.

Threads that don't match are skipped. If none match, the call is refused with `remote_call_failed` before any register is changed.

- **WoW64 processes** keep the 64-bit `syscall` path, but this rule matters there: their game threads are often in 32-bit code, while the threads waiting in the kernel are in 64-bit code.
- **64-bit games** always have `cs == 0x33`, so the check never changes their behavior.
- **The guard below covers WoW64 too** until the live check proves alloc there.

When `process_bits` is 32, `remote.rs` and `tracer.rs` use the i386 kernel interface:

- **The instruction:** an `int 0x80` (`CD 80`) found in the tracee. The i386 vDSO's `__kernel_vsyscall` contains one; i386 libc is the fallback. If neither has one, the operation fails with an error and no call is made.
- **The calls:** i386 syscall numbers (`mmap2` = 192, `munmap` = 91). `mmap2`'s offset is in pages.
- **The registers:** arguments go in `ebx, ecx, edx, esi, edi, ebp`, set through the 64-bit `user_regs_struct`, which the kernel maps for compat tracees.
- **The result:** read from `eax` as a sign-extended `i32`.

If the call doesn't finish, the error is `remote_call_failed` and the target's registers are restored. That's the same contract as today, now tested for i386.

**Address range.** Memory for 32-bit code (`code_bits` 32) must land below 4 GiB, whichever `process_bits` it has.

- In a 32-bit process this is automatic.
- In a WoW64 (64-bit) process, `alloc` limits its candidates (and `MAX_ADDR`) to below 4 GiB.
- With `code_bits` 32, any rel32 jump reaches any address. So near `alloc` doesn't need the reach search, but stays as a preference for locality.

### Assembler (`code_bits`)

`asm::assemble` takes a bitness of 32 or 64. With 32:

- The candidates are 32-bit-mode iced `Code`s, and the encoder runs at bitness 32.
- There is no RIP-relative addressing. `[symbol]` is an absolute `disp32`.
- 64-bit registers and REX-only registers (`r8`–`r15`, `spl`/`sil`…) are errors.
- `push eax` and `pushfd` are real 32-bit forms, without the 64-bit leniency mapping.
- `pushad`, `popad`, `pushfd`, `popfd` and `pusha`/`popa` are accepted.
- `dq` still emits 8 bytes, as CE does.

The 64-bit path stays byte-for-byte as it is.

**x87 is in scope, for both bitnesses.** 12 of the 29 tables need it, and it's the same kind of work in both modes. That covers:

- the `st`/`st(0)`–`st(7)` operands;
- `fld`/`fst`/`fstp`, `fild`/`fistp`, `fadd`/`fsub`/`fmul`/`fdiv` and their `p`/`r` variants;
- `fcom`/`fcomp`/`fcomip`, `fxch`, `fchs`, `fabs`, `fldz`/`fld1` and `fstsw ax`;
- memory size keywords (`dword`/`qword`/`tword ptr`).

Anything outside that set stays an `asm:error`.

**The `assemble` RPC** takes an optional `bits`. With a handle and no `bits`, it uses the target's `code_bits`; with neither, it uses 64, as today. The same applies to whatever re-encodes hook bodies and trampolines (`hook.rs` uses `BlockEncoder` at the target's `code_bits`).

### Routing

`ct-runner.routeTable` checks that every script assembles before it picks the native engine. Today that check always assembles at 64 bits. It now takes the game's `code_bits`:

- **Finding the bitness.** The desktop gets `code_bits` from a new pid-level query, `process_info { pid, main_module? }`. It reads `/proc` and the modules without a session, using the same detection as attach. If that query says unknown, routing waits for the game's modules, the same way the session already does. If it's still unknown after that, the check uses 64, as today.
- **Re-checking at session start.** When the session's real `code_bits` becomes known and differs from the bitness the route was checked at, the scripts are checked again at the real bitness before any cheat runs.
  - If they pass, the session stays native.
  - If they fail, the session moves to Cheat Engine through the existing "native backend couldn't start the table" fallback, so a table is never run with code of the wrong bitness.
- **The log line** includes the bitness, for example `native (32-bit, 40 records)`.

The compiler's CE-only reasons don't change.

### Game speed on 32-bit games

- `speed_set` and `speed_*` refuse a target whose `code_bits` is 32, returning a new error code `unsupported_target` with the message "Game speed doesn't work with 32-bit games yet." The refusal happens before any allocation or patch.
- The desktop shows that message in place of the generic failure.
- When the session knows the game is 32-bit, the speed control is disabled, with the message as its tooltip.
- If Cheat Engine is running the table, speed still goes to CE (unchanged).

### Safety guard (first commit, before everything else)

The following refuse with `unsupported_target` when `process_bits` is 32, or when `code_bits` is 32 in a 64-bit (WoW64) process:

- `alloc`, `alloc_own` and `free`;
- `patch`, for the parts that need remote calls;
- `aob_exec`, hooks and `speed_*`.

This closes the crash on its own and could ship before the rest. Later work lifts the refusal for everything except speed:

- the i386 remote-call work lifts it for 32-bit processes;
- the code-segment thread rule, once the live check proves alloc there, lifts it for WoW64.

## Testing

- **Rust unit tests:**
  - 4-byte pointer chains, including 32-bit wrapping.
  - The 32-bit assembler, with a byte-for-byte table checked against known encodings for each new form, x87 included.
  - `code_bits`/`process_bits` detection from fixture headers.
- **Rust integration tests against an i386 Linux target,** built with `gcc -m32` (the system has 32-bit gcc support): remote `mmap2`/`munmap`, `alloc`/`free`, patch plus AOB-exec, and register restore after a failed call. If the i386 toolchain isn't available, these tests skip with a printed reason, and the Proton live check covers the same ground.
- **A live check script (`scripts/live-32.mjs`):**
  - It runs our own PE32 target (i686 mingw), in a throwaway prefix with its own `STEAM_COMPAT_*` env (the `live-m4.mjs` pattern), in both default and `PROTON_USE_WOW64=1` modes.
  - It covers attach facts, a pointer chain, alloc, assemble plus patch of a 32-bit script, a Lua `readPointer`, and the speed refusal.
  - It kills only the processes it started.
- **TypeScript:** routing passes `code_bits` into the assemble check, the speed refusal message is mapped, and existing tests are unchanged.
- **Corpus:** the corpus has no bitness for each game, so the coverage script (`scripts/ct-coverage.mjs --assemble`) works it out from the table itself, using the same rule as the "29 tables" analysis:
  - A table whose scripts use 32-bit address registers (`[eax…]`, `[esp…]` and so on) and no 64-bit registers counts as 32-bit and is checked at 32.
  - Every other table is checked at 64, as today.
  - The report prints the 32-bit and 64-bit counts separately, and the plan's final notes record the before and after.

  This rule is only for measuring; at run time the game's real bitness decides.

## Left to the builder

- Where in `Target` the two facts live, and how `Stopped`/`Tracer` read them.
- Exactly how to find `int 0x80` in the vDSO or libc.
- How `MAX_ADDR` and the candidate search are parameterised.
- How the assembler's 32-bit candidate filter is written, and the precise x87 operand-form coverage beyond the list above, if a corpus table needs more.
- Whether `process_info` reuses the attach code path or is a thin wrapper.
- The UI details of the disabled speed control, within the existing speed component's style.
