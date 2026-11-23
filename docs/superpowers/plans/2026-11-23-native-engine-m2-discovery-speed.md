# Native Engine — Milestone 2 (Discovery + Speed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `starlightd` the discovery tools (value scans, pointer scans, watchpoints, disassembly, signatures), code injection (remote alloc, an Intel-syntax assembler, reversible patches) and game speed, expose them through `@starlight/engine`, and move the existing Memory scanner panel onto `starlightd` value scans without changing how it looks.

**Architecture:** The daemon keeps its newline-delimited JSON-RPC protocol, bumped to version 2 with capabilities in `hello`. Slow methods run on worker threads so a long scan never blocks a cheat toggle. A per-process ptrace **tracer thread** owns every ptrace operation (stop-the-world, remote `mmap`, debug registers). Every change the daemon makes to game code is recorded with its original bytes in a per-connection **teardown owner**, which reverts it on unpatch, detach, connection close, stdin EOF and SIGTERM. Speed is built on that machinery: hooks written as Intel-syntax text, assembled by our own assembler, installed as inline hooks with relocated trampolines.

**Tech Stack:** Rust 1.95.0 (pinned in `rust-toolchain.toml`, edition 2021; deps `serde`, `serde_json`, `libc`, plus `iced-x86` (MIT)), TypeScript, Node 20, Electron 32, React + zustand, vitest. Live Proton checks use the user's installed Proton 11.0 and `x86_64-w64-mingw32-gcc` (Homebrew).

**Spec:** `docs/superpowers/specs/2026-11-23-native-engine-agent-design.md`: milestone 2 of §11, covering §6.3, §6.4 and §6.5, plus §6.2's revert rule for code patches. The M1 plan (`docs/superpowers/plans/2026-11-23-native-engine-m1-core.md`) defines protocol v1, which this plan extends.

## Global Constraints

- **No anti-cheat evasion, no features aimed at hiding from detection, no multiplayer features.** Anti-cheat refusal (M1, `anti-cheat.ts`) stays on both engines and is not weakened by anything here.
- **No copying of Cheat Engine source.** CE is a behavioral reference only (syntax it accepts, what its scanner does).
- Linux x86-64 only. Nothing is loaded into the game as a library. All code changes are made from outside: `pwrite` on `/proc/<pid>/mem` and ptrace.
- Rust dependencies: `serde`, `serde_json`, `libc`, and **`iced-x86` (MIT)** for decode, encode and format. Any other dependency must have a permissive license (MIT/Apache-2.0/BSD), with the reason in the commit message. **Keystone is GPLv2 and is not allowed.**
- The assembler **must accept CE-style Intel syntax** (subset in Task 6). M4's AA compiler reuses it, so it is a library module (`asm`), not RPC-only code.
- Remote alloc uses a **ptrace-driven remote `mmap` syscall on a stopped thread**, and the thread is resumed cleanly (registers, including `orig_rax`, restored exactly).
- **Never patch the vDSO.** (Reading it to find `__vdso_gettimeofday` is allowed.)
- **Speed 1.0 keeps the hooks (continuous time); the original bytes are restored when the session ends.**
- Speed on Proton hooks `QueryPerformanceCounter`, `GetTickCount`/`GetTickCount64`, `timeGetTime` and `NtQueryPerformanceCounter` (in the PE modules). Native games: `clock_gettime`/`gettimeofday` in libc.
- Code patches always record the original bytes and revert on disable **and on session end**. Session end means detach, connection close, stdin EOF and SIGTERM/SIGINT/SIGHUP. Restoring bytes comes **before** the daemon exits.
- Watchpoints use DR0–DR3 via ptrace on **every thread, including threads created after the watch starts**. They are time-boxed (default 10 s, max 60 s) and always cleaned up on stop and detach.
- Scan results live in `starlightd` per scan session. Only counts and a page of results (at most 1000 entries) cross the socket.
- Protocol version is **`2`**. `hello` reports `protocol: 2` and the capability list. The TS client refuses any other protocol. The `READY 1` startup banner is unchanged (see Decisions).
- Addresses on the wire are lowercase `"0x…"` hex strings. Byte buffers are lowercase hex without spaces (as in M1).
- Debug-only RPC surface (`debug_sleep`, `debug_on_cleanup`, the `targets` override on `speed_set`) exists only under `cfg(debug_assertions)`. CI and the dev app's release build never expose it.
- Tests: vitest with at most 2 workers (configs already set this; keep them). Rust tests run with `cargo test --manifest-path packages/starlightd/Cargo.toml` (there is no root Cargo workspace). Live tests only touch processes the test launches itself: the C test target, or a Windows test program run under Proton with a **throwaway** `STEAM_COMPAT_DATA_PATH`. **Never the user's running game.**
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A game thread is executing inside the bytes being patched.** Hot timing functions are called thousands of times a second. Writing a 5-byte jump under a running thread crashes the game. Expected behavior: the write happens only while every thread is stopped and no thread's RIP lies inside the site. The test is in Task 8 (`patch_waits_until_no_thread_is_inside_the_site`).
2. **Starlight quits or the connection drops while hooks or watchpoints are live.** Expected behavior: original bytes are back and debug registers are cleared before the daemon exits, and the game keeps running. The tests are in Task 8 (`stdin_eof_restores_patched_bytes`, `connection_drop_restores_patched_bytes`) and Task 9 (`closing_connection_clears_watch_and_detaches`).
3. **Threads created after a watch starts** (Wine creates threads all the time). Expected behavior: they get the same debug registers before they run. The test is in Task 9 (`late_thread_hits_are_reported`).
4. **The game exits mid-scan, mid-watch, or with hooks installed.** Expected behavior: the daemon keeps serving, the scan fails with `-32002`, the watch ends with reason `process_exited`, and nothing tries to restore bytes in a dead process forever. The tests are in Task 2 (`scan_next_after_target_exit_is_32002`) and Task 9 (`watch_ends_when_target_exits`).
5. **Nested timing calls.** Wine's `timeGetTime` calls `QueryPerformanceCounter`. If both are hooked, time is scaled twice (4× instead of 2×). Expected behavior: a call made from inside another hooked call is passed through unscaled. The tests are in Task 11 (`nested_sysv_calls_scale_once`) and Task 12 (`nested_win64_calls_scale_once`).

---

## Decisions made while planning

| # | Decision | Reason |
|---|---|---|
| D1 | **Assembler = own CE-style Intel parser + `iced-x86` encoder.** The parser maps a mnemonic and parsed operands to an iced `Code` by filtering `Code::values()` on `mnemonic()` and `OpCodeInfo` operand kinds, encodes every candidate, and keeps the shortest. Labels and branches go through iced's `BlockEncoder`. | MIT license; a table-driven matcher covers the whole instruction set instead of a hand-written list, which M4's AA compiler needs. |
| D2 | **Numbers in assembly are hex by default, as in CE.** `#123` is decimal and `0x` is accepted. An identifier that is a valid hex number is a number unless it is a register, label or supplied symbol. A memory operand with an immediate and no size defaults to `dword`, as in CE. | CE tables (M4) rely on these rules. |
| D3 | **Disassembly text uses the same CE style** (uppercase hex, no prefix, RIP-relative operands shown as absolute addresses). `assemble(disassemble(x)) == x` is a tested property. | Agents (M3) paste disassembly into scripts. Round-tripping removes a whole class of mistakes. |
| D4 | **Slow methods run on worker threads and respond out of order.** The slow methods are `scan_first`, `scan_next`, `pointer_scan`, `pointer_rescan`, `make_signature`, `alloc`, `free`, `patch`, `unpatch`, `speed_set` and `debug_sleep`. Everything else stays inline. Responses are matched by id (the TS client already does this). | Desktop shares one connection between trainer cheats and the scanner, so a 5 s scan must not stall a cheat toggle. |
| D5 | **One ptrace tracer thread per pid, shared by every connection through a global registry**, refcounted. ptrace requests must come from the thread that attached, and a process can only have one tracer. It waits with `waitpid(-1, __WALL \| __WNOTHREAD \| WNOHANG)` so tracers of different pids never steal each other's events. It uses `PTRACE_SEIZE` with `PTRACE_O_TRACECLONE` and **never `PTRACE_O_EXITKILL`**. | Linux ptrace rules. A daemon crash must never kill the game. |
| D6 | **Remote syscall:** stop all threads, pick the main thread (`tid == pid`, falling back to any stopped thread), save registers, set `rip` to a `syscall` (`0f 05`) found in an r-x file-backed Linux mapping (preferring libc), set `orig_rax = -1`, single-step, read `rax`, restore the saved registers exactly. Signals that arrive meanwhile are queued and re-injected on resume. | The standard debugger technique. Restoring `orig_rax` keeps an interrupted syscall restarting correctly. |
| D7 | **Near alloc** picks gaps from `/proc/<pid>/maps` within ±(2 GiB − size) of `near`, aligned to 64 KiB, and maps them with `MAP_FIXED_NOREPLACE`. A result address that differs from the request is unmapped and the next gap is tried. If none fits → `-32011 AllocFailed`. | Only true gaps are used, so Wine's own reserved (PROT_NONE) areas are never clobbered. 64 KiB matches Windows allocation granularity. |
| D8 | **Code patches are written with all threads stopped**, after checking that no thread's RIP is strictly inside `(site, site+len)`. If one is, the daemon resumes for 1 ms and retries, up to 200 times, then fails with `-32013 Busy`. | Review Focus 1. |
| D9 | **Allocated hook and trampoline pages are never freed automatically**, not even at speed 1.0 or on detach. Only an explicit `free` unmaps memory. | A thread can sit in a syscall with a return address inside a trampoline. Unmapping would crash it. A few KiB per session is the price. |
| D10 | **Inline hooks refuse sites whose displaced instructions contain a call, a relative branch, a `ret` or `int3`**, and functions shorter than 5 bytes. Such a function is reported as `skipped` with a reason. RIP-relative memory operands are allowed and relocated (the trampoline is near-allocated). | A thread blocked in a callee would return into overwritten bytes, and relocating branches inside the displaced range isn't sound. |
| D11 | **Speed hooks share one rwx state page.** It holds the speed (`f64`), a generation number, per-clock-domain slots `{real0, fake0, speed, gen}`, a spinlock, a 64-entry per-thread nesting table, and a **recovery record** (magic `STLSPD01`, then each hooked address with its original bytes). Each hook rebases its slot under the lock whenever the generation changes, so fake time stays continuous across speed changes. | Continuous time. The recovery record lets a later daemon undo hooks left behind by a daemon that was SIGKILLed (D12). |
| D12 | **If the daemon is SIGKILLed with hooks installed**, the hooks stay and the game keeps running at the last speed. Debug registers set by a live watch also stay (at most 60 s of exposure, since watches are time-boxed; a hit after that delivers SIGTRAP to the game). **Mitigation:** every `speed_set` and `speed_get` first looks for an orphaned state page (a private anonymous rwx mapping of exactly `STATE_PAGE_SIZE` whose first 8 bytes are `STLSPD01`) and restores its recorded bytes before doing anything else. Connection drop, stdin EOF and SIGTERM always restore first (Task 1 shutdown path). | SIGKILL can't be intercepted. Recovery on the next use is the best possible. |
| D13 | **Nesting guard keyed by the thread pointer:** `gs:[0x30]` (TEB.Self) for Win64 hooks, `fs:[0]` (TCB self) for SysV hooks. A hook entered while its thread is already inside a hook passes the value through unscaled. | Wine's `timeGetTime` calls QPC through its import table, and glibc may call `clock_gettime` internally (Review Focus 5). A static "leaf" analysis can't see those paths. |
| D14 | **Clock domains:** QPC and `NtQueryPerformanceCounter` share one slot, since they use the same counter. `GetTickCount`, `GetTickCount64`, `timeGetTime`, `gettimeofday`, and each `clock_gettime` clock id each get their own slot. `clock_gettime` scales ids 0, 1, 4, 5, 6, 7 (REALTIME, MONOTONIC, MONOTONIC_RAW, REALTIME_COARSE, MONOTONIC_COARSE, BOOTTIME) and passes CPU-time clocks (2, 3) and others through. | A game that mixes QPC and NtQPC must see one consistent clock. CPU-time clocks don't drive game time. |
| D15 | **Proton targets:** resolve `ntdll.dll!RtlQueryPerformanceCounter`, `ntdll.dll!NtQueryPerformanceCounter`, `kernel32.dll!QueryPerformanceCounter`, `kernel32.dll!GetTickCount`, `kernel32.dll!GetTickCount64`, and `winmm.dll!timeGetTime` (only if winmm is loaded). Export forwarders are followed, and targets are deduplicated by final address. Wine mode is chosen when a PE module named `ntdll.dll` is mapped. In that mode the Linux libc is **not** hooked. | Wine's kernel32 QPC forwards to ntdll. Hooking the same body twice is impossible, and hooking Wine's own Linux libc would scale time twice. |
| D16 | **Native targets:** `clock_gettime` gets an inline hook in the module that exports it (`libc.so.6`, or musl's `ld-musl-x86_64.so.1`). `gettimeofday` gets an inline hook if it is a plain function. If its dynsym entry is `STT_GNU_IFUNC` (glibc x86-64 resolves it straight to the vDSO), the daemon instead rewrites the GOT slots for `gettimeofday` in every loaded ELF module to point at a hook that calls `__vdso_gettimeofday`. Each slot write is a recorded patch. | Inline-patching an IFUNC resolver does nothing, and the vDSO must not be patched. |
| D17 | **Speed range 0.1–10.0.** 1.0 keeps the hooks (continuous time); session end uninstalls. Anything outside the range → `-32602`. | The UI offers 0.5–8×. 0 would hang games that wait for time to pass. |
| D18 | **Value-scan storage:** a first scan that matches by value stores a **sparse** list (addresses plus previous-value bytes). `unknown` initial scans store a **dense** form: region snapshots streamed into an unlinked file under `$XDG_CACHE_HOME/starlight/scans` (falling back to `~/.cache`), plus an in-RAM candidate bitmap with one bit per aligned slot. A dense session converts to sparse once its count is ≤ 1,000,000. Scanned regions are readable, writable and **private**, excluding `[vvar]`, `[vdso]`, `[vsyscall]` and `/dev/*`. Reads use 4 worker threads (`std::thread::scope`) and 1 MiB chunks. | Unknown-value scans of a 4 GB game can't live in RAM on a machine that also runs the game. Shared mappings are GPU/driver memory and are slow or unsafe to read. |
| D19 | **Scan values are strings on the wire** (`"100"`, `"1.5"`, `"-3"`). Float/double `exact` matches when the value, rounded to the number of decimals typed, equals the input (`"100"` matches 99.5 ≤ x < 100.5). `increased_by`/`decreased_by` use the same tolerance. Default alignment is `min(size, 4)`, and 1 for string/bytes. Besides the spec's modes, scans support `bigger`/`smaller`, because the existing panel offers them. | Lossless for int64. Matches what players type. Keeps the panel's options. |
| D20 | **Pointer scan:** CE-style reverse BFS. Build a sorted `(value → location)` index of every 8-aligned qword in scanned regions whose value points into a readable+writable region. Then walk back from the target, level by level (`max_depth` default 5, at most 7; `max_offset` default `0x1000`, at most `0x10000`). A location inside a module image ends a path as `module + offset`. At most 100,000 frontier entries per level, `max_results` default 10,000 (at most 100,000), and an index cap of 50 million entries (`-32602` with a "too much memory" message). Paths are sorted by depth, then by total offset. Pointer-scan sessions belong to the connection, **not** the handle, so `pointer_rescan` works against a new handle after a game restart. | The spec leaves the algorithm and limits to the builder. These bound time and memory on a 4 GB game. |
| D21 | **Watchpoint reporting:** a data breakpoint traps *after* the instruction. The daemon reports the instruction **start**, found by decoding back from `rip`: the start in `rip-15 … rip-1` whose single decoded instruction ends exactly at `rip`, preferring the earliest such start. It also reports `next = rip`, a hit count, and the **first** register snapshot per site. Defaults are `duration_ms` 10,000 (at most 60,000) and `max_hits` 5,000. `kind: "write"` uses R/W=01 and `"access"` uses R/W=11. `size` ∈ 1, 2, 4, 8, and the address must be aligned to `size`. A SIGTRAP whose DR6 doesn't name one of our slots is re-injected into the game. | The spec leaves the time-box defaults to the builder. |
| D22 | **Signature builder is forward-only.** Starting at the instruction, append whole instructions and wildcard displacement and immediate bytes that are RIP-relative, rel32 branch targets, or values that look like addresses (inside any mapped region). Stop at the first unique pattern or at `max_length` (default 64). If the pattern is still not unique, return it with `unique: false` and the match count. | Simple and predictable. Backward extension is a follow-up. |
| D23 | **Scanner panel contract unchanged.** The renderer (`ScannerPanel.tsx`, `scanner-store.ts`) is untouched. Main routes the panel's commands (`scan_first`, `scan_next`, `scan_status`, `scan_results`, `scan_reset`, `mem_read`, `mem_write`, `freeze_set`, `freeze_clear`) to a new `scanner-host.ts` on `starlightd`, with the same reply shapes and CE's address format (uppercase hex, no prefix). | "No change in look", and the existing store tests keep guarding the contract. |
| D24 | **Game speed in the desktop UI stays on CE in M2.** `starlightd` speed ships in the engine API and is verified live, but `CeSessionView`'s speed buttons keep calling CE's `set_speed`. | In a CE session, CE owns the game (spec §6.6). Two engines hooking the same timing functions would stack. The engine-agnostic session in M4 moves the buttons. |
| D25 | New error codes: `-32008` SymbolNotFound, `-32009` UnknownId (scan/pointer-scan/watch/patch/alloc id), `-32010` AssembleFailed (message starts `line N:`), `-32011` AllocFailed, `-32012` PtraceFailed (e.g. "another debugger is attached (Cheat Engine?)"), `-32013` Busy, `-32014` PatchConflict. The TS client keeps mapping them to `EngineError` with `.code`, and exports `RpcCode` constants. | Callers branch on the code. New error classes would add nothing. |
| D26 | The `READY 1` banner stays. The protocol lives only in `hello`. | The banner is a startup handshake format, not the protocol. Changing it would break `startEngine` for no gain. |

---

## File Structure

**`packages/starlightd/`**
- `Cargo.toml` — add `iced-x86 = { version = "1.21", default-features = false, features = ["std", "decoder", "encoder", "block_encoder", "op_code_info", "intel", "instr_info"] }`
- `src/rpc.rs` — protocol 2, capabilities, new error constructors, slow-method dispatch on worker threads
- `src/cleanup.rs` (new) — `Owner` (per-connection teardown registry), global registry, `shutdown_all`, signal thread
- `src/main.rs` — stdin-EOF and signal paths call `cleanup::shutdown_all` before `exit(0)`
- `src/process.rs` — `Handles` becomes `Sync` (`&self` methods, atomic ids) and owns an `Arc<cleanup::Owner>`
- `src/regions.rs` (new) — scannable-region selection shared by value and pointer scans
- `src/scan/mod.rs`, `src/scan/value.rs`, `src/scan/store.rs` (new) — value scan sessions
- `src/symbols.rs` (new) — PE exports (with forwarders), ELF dynsym and GOT relocations, all parsed from memory
- `src/disasm.rs` (new) — decoding, CE-style formatting, `module+offset` annotation
- `src/signature.rs` (new)
- `src/asm/mod.rs`, `src/asm/parse.rs`, `src/asm/encode.rs` (new) — the assembler library
- `src/tracer.rs` (new) — per-pid ptrace thread
- `src/remote.rs` (new) — remote syscall, `alloc`, `free`
- `src/patch.rs` (new) — recorded patches, stop-the-world writes
- `src/hook.rs` (new) — inline hooks with relocated trampolines
- `src/watch.rs` (new)
- `src/pointer_scan.rs` (new)
- `src/speed/mod.rs`, `src/speed/templates.rs`, `src/speed/targets.rs` (new)
- `tests/common/mod.rs` — `Client::call_timeout`; `Target::spawn` unchanged (new target lines print before `offset hp_in_stats`)
- `tests/protocol.rs`, `tests/values.rs`, `tests/symbols.rs`, `tests/disasm.rs`, `tests/code.rs`, `tests/watch.rs`, `tests/pointer_scan.rs`, `tests/speed.rs` (new)

**`packages/engine/test-target/`**
- `target.c` — new flags: `--writer`, `--late-writer <ms>`, `--spin`, `--heap-chain`, `--decoy`, `--clocks`, `--win64-clocks`; prints the new `addr`/`offset` lines **before** `offset hp_in_stats` (the last line both test helpers wait for)
- `Makefile` — add `-pthread`
- `win/clocks.c`, `win/Makefile` (new; live verification only, built with `x86_64-w64-mingw32-gcc`)

**`packages/engine/`**
- `src/client.ts` — `PROTOCOL_VERSION = 2`; `EngineClient.capabilities`
- `src/errors.ts` — `RpcCode`
- `src/scan.ts`, `src/pointer-scan.ts`, `src/watch.ts`, `src/code.ts`, `src/speed.ts`, `src/symbols.ts` (new); `src/types.ts`, `src/index.ts`, `README.md`
- `test/scan.test.ts`, `test/discovery.test.ts`, `test/code.test.ts` (new); `test/client.test.ts`

**`apps/desktop/`**
- `src/main/scanner-host.ts` (new), `test/main/scanner-host.test.ts` (new)
- `src/main/ce-session.ts` — `SessionState.pid`; scanner commands go to `scanner-host`; `endSession` ends the scanner

---

## Protocol v2 (shared reference for Tasks 1–12)

Every v1 method is unchanged. Additions:

| Method | Params | Result |
|---|---|---|
| `hello` | `{}` | `{ protocol: 2, version, capabilities }`. Capabilities are the v1 list plus `"read_many","scan","symbols","disasm","signature","assemble","alloc","patch","watch","pointer_scan","speed"`. Each is added by the task that implements it. |
| `read_many` | `{ handle, items: [{ address, length }] }` (≤ 4096 items, each ≤ 4096 bytes) | `{ values: (string \| null)[] }`, where `null` means unreadable |
| `scan_first` | `{ handle, type, mode, value?, min?, max?, encoding?, alignment? }` | `{ scan, count }` |
| `scan_next` | `{ scan, mode, value?, min?, max? }` | `{ count }` |
| `scan_results` | `{ scan, offset? (0), limit? (100, ≤ 1000) }` | `{ count, results: [{ address, value: string \| null }] }` (current values, read live) |
| `scan_end` | `{ scan }` | `{}` |
| `module_exports` | `{ handle, module }` | `{ exports: [{ name, address, kind: "func" \| "ifunc" \| "object", forwarder?: string }] }` |
| `resolve_symbol` | `{ handle, module, name }` | `{ address }` (forwarders followed) |
| `disassemble` | `{ handle, address, count? (20, ≤ 500) }` | `{ instructions: [{ address, length, bytes, text, symbol: string \| null, target?: { address, symbol } }] }` |
| `make_signature` | `{ handle, address, max_length? (64) }` | `{ pattern, offset: 0, module, length, unique, matches }` |
| `assemble` | `{ handle?, address, source, symbols?: { [name]: "0x…" } }` | `{ bytes, length, labels: { [name]: "0x…" } }` |
| `alloc` | `{ handle, size, near?, prot?: "rwx" \| "rw" \| "rx" }` (default `rwx`) | `{ address, size }` |
| `free` | `{ handle, address }` | `{}` |
| `patch` | `{ handle, address, bytes }` | `{ id, original }` |
| `unpatch` | `{ id, force? }` | `{}` |
| `watch_start` | `{ handle, address, size, kind, duration_ms?, max_hits? }` | `{ id }` |
| `watch_poll` / `watch_stop` | `{ id }` | `{ active, reason: null \| "timeout" \| "max_hits" \| "stopped" \| "process_exited" \| "detached", hits: [Hit] }` |
| `pointer_scan` | `{ handle, address, max_depth?, max_offset?, max_results?, modules?: string[] }` | `{ id, count, truncated }` (`truncated`: a frontier or `max_results` limit was hit) |
| `pointer_results` | `{ id, offset?, limit? }` | `{ count, results: [{ module, base, offsets: string[] }] }` |
| `pointer_rescan` | `{ id, handle, address? }` | `{ count }`. A rescan that keeps no path returns `count: 0` and leaves the session's paths and target unchanged. |
| `pointer_end` | `{ id }` | `{}` |
| `speed_set` | `{ handle, speed, targets? (debug builds only) }` | `{ speed, hooks: [{ name, address, status: "hooked" \| "skipped", reason? }] }` |
| `speed_get` | `{ handle }` | same as `speed_set` |

- `type` is one of `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`, `float`, `double`, `string`, `bytes`. `encoding` (`utf-8` default, or `utf-16le`) applies to `string`. For `bytes`, `value` is an AOB pattern (M1 `aob::Pattern`).
- First-scan `mode` ∈ `exact`, `bigger`, `smaller`, `range`, `unknown`. Next-scan `mode` ∈ `exact`, `bigger`, `smaller`, `range`, `changed`, `unchanged`, `increased`, `decreased`, `increased_by`, `decreased_by`. `string`/`bytes` allow only `exact`, `changed` and `unchanged`.
- `Hit = { address, next, module: string | null, text, count, registers: { rax, rbx, rcx, rdx, rsi, rdi, rbp, rsp, r8…r15, rip, eflags } }` (all `"0x…"`).
- Notification `watch_ended { id, reason }` is sent once, when a watch ends for any reason other than `watch_stop`.
- Ownership: scans, watches, patches, allocations and speed hooks belong to the **handle** that created them and go away on its detach. Pointer-scan sessions belong to the **connection**. Teardown order on detach or connection close: patches and speed hooks (newest first) → watches → freezes → scans.

---

### Task 1: Protocol v2 foundation: async dispatch, teardown owner, safe shutdown

**Files:**
- Create: `packages/starlightd/src/cleanup.rs`, `packages/starlightd/tests/protocol.rs`
- Modify: `packages/starlightd/src/rpc.rs`, `src/main.rs`, `src/process.rs`, `tests/common/mod.rs`, `tests/server.rs` (protocol assertion), `packages/engine/src/client.ts`, `packages/engine/src/errors.ts`, `packages/engine/test/client.test.ts`, `packages/engine/test-target/Makefile` (`-pthread`)

**Interfaces:**
- Consumes: M1 `rpc::Session`, `Conn`, `RpcError`, `process::Handles`, `freeze::Freezes`.
- Produces (Rust):
  - `rpc::PROTOCOL = 2`; `rpc::CAPABILITIES` stays a `&[&str]` constant, and each later task appends its capability name.
  - `RpcError` constructors `symbol_not_found`, `unknown_id`, `assemble_failed`, `alloc_failed`, `ptrace_failed`, `busy`, `patch_conflict` (codes in D25).
  - `rpc::Session { conn: Conn, state: Arc<ConnState> }`, `ConnState { handles: Handles, owner: Arc<cleanup::Owner> }`. Later tasks add their per-connection tables to `ConnState`.
  - `fn is_slow(method: &str) -> bool` (the D4 list). Slow methods are dispatched on `std::thread::spawn` with clones of `conn` and `state`.
  - `cleanup::Teardown` enum, ordered: `Patch = 0, Watch = 1, Freeze = 2, Scan = 3`.
  - `cleanup::Owner::add(&self, handle: Option<u32>, kind: Teardown, f: Box<dyn FnOnce() + Send>) -> u64`, `remove(&self, token: u64) -> bool` (dropped without running), `run_handle(&self, handle: u32)`, `run_all(&self)`. Within one `kind`, newest runs first.
  - `cleanup::register(owner: &Arc<Owner>)` (global `Weak` list) and `cleanup::shutdown_all(deadline: Duration)`, which runs every live owner's `run_all` on a helper thread and returns when done or at the deadline (3 s from `main`).
  - `cleanup::spawn_signal_thread()`: blocks SIGTERM, SIGINT and SIGHUP in `main` **before any other thread starts**, then a thread `sigwait`s and calls `shutdown_all` → `exit(0)`.
  - `Handles::{attach, detach, detach_all}` take `&self`. `detach(h)` and the exit watcher call `owner.run_handle(h)` before removing the handle.
  - Debug only: `debug_sleep { ms }` (slow) and `debug_on_cleanup { handle?, path }`, which registers a `Teardown::Scan` action that creates the file `path`.
- Produces (tests): `Client::call_timeout(method, params, timeout) -> Result<Value, (i64, String)>`.
- Produces (TS): `PROTOCOL_VERSION = 2`; `EngineClient.capabilities: readonly string[]` (from `hello`); `export const RpcCode = { PermissionDenied: -32001, …, PatchConflict: -32014 } as const`.

- [ ] **Step 1: Write the failing tests**

`tests/protocol.rs`:
```rust
#[test] fn hello_reports_protocol_2() { /* v["protocol"] == 2 */ }
#[test] fn slow_call_does_not_block_fast_calls() {
    // client A: send debug_sleep {ms: 1500} without waiting; same connection: call hello
    // hello answers in < 300 ms; then the debug_sleep response arrives
}
#[test] fn stdin_eof_runs_cleanup_before_exit() {
    // debug_on_cleanup {path: tmp/x}; d.close_stdin(); wait_exit(3s).is_some(); tmp/x exists
}
#[test] fn sigterm_runs_cleanup_before_exit() { /* same, with libc::kill(child, SIGTERM) */ }
#[test] fn connection_close_runs_cleanup() { /* debug_on_cleanup; drop client; file appears within 1 s; daemon still answers hello on a new client */ }
#[test] fn detach_runs_handle_cleanup_only() {
    // attach two targets; debug_on_cleanup on each handle; detach first → only its file exists
}
```
Owner unit tests in `cleanup.rs`: `runs_patches_before_scans`, `newest_patch_runs_first`, `removed_token_never_runs`.
`packages/engine/test/client.test.ts`: change the fake server to answer `protocol: 2` in the happy path, and `rejects a daemon with the wrong protocol` uses `protocol: 1` → rejects `/protocol 1, expected 2/`. Add `it('exposes capabilities from hello')`.

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test protocol`
Expected: FAIL (protocol is 1; `debug_sleep` is -32601).

- [ ] **Step 3: Implement**

The stdin thread in `main.rs` becomes: read until EOF → `cleanup::shutdown_all(Duration::from_secs(3))` → `exit(0)`. Every connection's `ConnState` is registered at creation. `serve` calls `state.owner.run_all()` after the read loop ends, and `Handles::drop` still detaches. Freezes register a `Teardown::Freeze` action per handle (replacing the direct `stop_handle` calls) so the order in Protocol v2 holds.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml && cargo build --manifest-path packages/starlightd/Cargo.toml && pnpm --filter @starlight/engine build && pnpm --filter @starlight/engine test`
Expected: all pass, including every M1 test.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine
git commit -m "feat(starlightd): protocol 2, async slow methods, teardown before exit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Value scan sessions and batch reads

**Files:**
- Create: `packages/starlightd/src/regions.rs`, `src/scan/mod.rs`, `src/scan/value.rs`, `src/scan/store.rs`, `tests/values.rs`
- Modify: `src/rpc.rs`, `src/main.rs` (mods), `packages/engine/test-target/target.c` (`--writer`)

**Interfaces:**
- Consumes: `ConnState`, `Owner::add(Some(handle), Teardown::Scan, …)`, `maps::read`, `mem::read_bytes`, `aob::Pattern`.
- Produces (Rust):
  - `regions::scannable(regions: &[maps::Region]) -> Vec<(u64, u64)>`: readable, writable and private, excluding `[vvar]`, `[vdso]`, `[vsyscall]` and paths starting with `/dev/`.
  - `scan::value::ScanType` (the 12 types), `ScanType::size(&self) -> Option<usize>`; `Matcher::first(ty, mode, value, min, max, encoding) -> Result<Matcher, RpcError>`; `Matcher::next(…)`; `fn format(ty, bytes: &[u8]) -> String`.
  - `scan::Scans` (in `ConnState`): `first(&self, t: Arc<Target>, handle, req) -> Result<(u32, u64), RpcError>`, `next(id, req) -> Result<u64, RpcError>` (`Busy` while that scan is running), `results(id, offset, limit) -> Result<(u64, Vec<(u64, Option<String>)>), RpcError>`, `end(id)`.
  - `scan::store::Store::{Sparse { addrs: Vec<u64>, prev: Vec<u8> }, Dense { file: File, regions: Vec<(u64, u64)>, bitmap: Vec<u64>, count: u64 }}` (D18).
  - RPC: `scan_first`, `scan_next`, `scan_results`, `scan_end`, `read_many`. Capabilities `"scan"`, `"read_many"`.
- Produces (test target): `--writer` starts a thread that runs `noinline void bump_counter(void)` (`g_counter += 1`) every 50 ms. It prints `addr g_counter=…` and `addr bump_counter=…`.

- [ ] **Step 1: Write the failing tests**

Unit (`scan/value.rs`):
```rust
#[test] fn float_exact_matches_rounded_input() { // "100" matches 99.6f32 and 100.4f32, not 100.6f32; "1.5" matches 1.54, not 1.56
}
#[test] fn int64_values_are_lossless() { /* "9007199254740993" exact-matches that i64 */ }
#[test] fn increased_by_uses_typed_arithmetic() { /* uint8 250 → 4 is not "increased_by 10" (wraps) */ }
#[test] fn bytes_scan_accepts_wildcards() { /* "DE AD ?? EF" */ }
#[test] fn string_scan_rejects_increased() { /* -32602 */ }
```
Integration (`tests/values.rs`, C target):
```rust
#[test] fn exact_int32_finds_g_health() {
    // scan_first {type:"int32", mode:"exact", value:"100"} → count ≥ 1; results contain addr("g_health")
}
#[test] fn next_scan_narrows_after_write() {
    // first exact 100; write g_health = 101; scan_next {mode:"increased"} → results contain g_health, count < first count
}
#[test] fn unknown_then_changed_finds_counter() {
    // Target --writer; scan_first {type:"int32", mode:"unknown"}; sleep 200 ms; scan_next changed; sleep 200 ms; scan_next increased
    // → results contain addr("g_counter")
}
#[test] fn results_are_paged() { /* limit:2 → 2 results, count unchanged; limit:5000 → -32602 */ }
#[test] fn float_and_double_and_string() { /* g_speed "1.5" float; g_pi "3.14" double; g_name string "Hero" */ }
#[test] fn scan_next_after_target_exit_is_32002() { /* first scan; t.kill(); scan_next → -32002; hello still answers */ }
#[test] fn detach_ends_scans() { /* first scan; detach; scan_results → -32009 */ }
#[test] fn read_many_mixes_good_and_unreadable() { /* [g_health 4, 0x0 4] → ["64000000", null] */ }
```

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test values`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow D18/D19. Compare typed values (signed/unsigned/float by `ScanType`). `changed`/`unchanged` compare bytes. When a region stops being readable between scans, its candidates are dropped rather than failing the scan. A target that has exited (pidfd readable, or `maps::read` → ENOENT/ESRCH) → `ProcessNotFound`. The dense snapshot file is opened with `O_TMPFILE` in the cache dir (falling back to create + unlink) and closed at `end`/teardown.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target
git commit -m "feat(starlightd): value scan sessions and batch reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Symbols: PE exports and ELF dynamic symbols from memory

**Files:**
- Create: `packages/starlightd/src/symbols.rs`, `tests/symbols.rs`
- Modify: `src/rpc.rs`, `tests/common/mod.rs` (`minimal_pe` gains an optional export table)

**Interfaces:**
- Consumes: `modules::{list, find, Module, Kind}`, `mem::read_bytes`.
- Produces (Rust):
  - `symbols::Export { name: String, address: u64, kind: SymKind /* Func | Ifunc | Object */, forwarder: Option<String> }`
  - `symbols::exports(t: &Target, m: &Module) -> Result<Vec<Export>, RpcError>`: PE via data directory 0 (an RVA inside the export directory is a forwarder `"DLL.Name"` or `"DLL.#ord"`); ELF via `PT_DYNAMIC` → `DT_SYMTAB`, `DT_STRTAB`, with the symbol count from `DT_HASH` nchain or by walking `DT_GNU_HASH`.
  - `symbols::resolve(t: &Target, mods: &[Module], module: &str, name: &str) -> Result<u64, RpcError>`: follows forwarders across modules case-insensitively (appending `.dll`), at most 8 hops.
  - `symbols::got_slots(t: &Target, m: &Module, name: &str) -> Result<Vec<u64>, RpcError>`: addresses of `R_X86_64_JUMP_SLOT` (7) and `R_X86_64_GLOB_DAT` (6) relocations for `name` from `DT_JMPREL`/`DT_PLTRELSZ` and `DT_RELA`/`DT_RELASZ`.
  - Dynamic-section pointer rule: a `d_ptr` that lies inside `[m.base, m.base+m.size)` is absolute (glibc relocates them in place). Otherwise add the load bias (`m.base` minus the first `PT_LOAD` `p_vaddr`).
  - RPC: `module_exports`, `resolve_symbol`. Capability `"symbols"`.

- [ ] **Step 1: Write the failing tests**

Unit: `pe_exports_by_name`, `pe_forwarder_is_reported` (export RVA inside the export dir → `forwarder: Some("NTDLL.RtlQueryPerformanceCounter")`), `gnu_hash_symbol_count`, and `got_slots_from_rela_tables` (a `DT_JMPREL` entry and a `DT_RELA` `GLOB_DAT` entry for `gettimeofday` → both slot addresses), all on hand-built byte buffers. Live GOT rewriting is covered by Task 11's `gettimeofday` rate test.
Integration:
```rust
#[test] fn libc_exports_clock_gettime() { // module_exports {module:"libc.so.6"} has "clock_gettime" kind "func"
}
#[test] fn libc_gettimeofday_kind_is_ifunc_or_func() { // "gettimeofday" is present with kind "ifunc" or "func" (glibc x86-64: "ifunc")
}
#[test] fn resolve_symbol_matches_dlsym() {
    // Target prints `addr libc_clock_gettime=` (via dlsym(RTLD_DEFAULT)); resolve_symbol {module:"libc.so.6", name:"clock_gettime"} equals it
}
#[test] fn unknown_symbol_is_32008() {}
#[test] fn pe_export_from_mapped_file() { // --map a minimal PE with export "Foo" at RVA 0x1000 → resolve_symbol == mapped + 0x1000
}
```
The target gains `addr libc_clock_gettime=%p` (from `dlsym`; link with `-ldl` is unnecessary on glibc ≥ 2.34 but harmless).

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --test symbols`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. All reads are bounds-checked against the module range. A malformed table yields an empty list, not a panic.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target
git commit -m "feat(starlightd): PE exports and ELF dynamic symbols from memory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Disassembly

**Files:**
- Create: `packages/starlightd/src/disasm.rs`, `tests/disasm.rs`
- Modify: `Cargo.toml` (add `iced-x86`, with features as in File Structure; commit message notes "iced-x86: MIT"), `src/rpc.rs`

**Interfaces:**
- Consumes: `modules::list`, `mem::read_bytes`.
- Produces (Rust):
  - `disasm::Symbolizer` built from `&[Module]`, with `name(addr) -> Option<String>` returning `"<module>+0x<off>"` (lowercase hex offset).
  - `disasm::formatter() -> iced_x86::IntelFormatter` with CE style: uppercase hex, empty hex prefix and suffix, no leading zeros, no space after the operand comma, RIP-relative shown as absolute, no branch size.
  - `disasm::decode(bytes: &[u8], ip: u64, count: usize) -> Vec<Insn>`, where `Insn { address, length, bytes: Vec<u8>, text: String, target: Option<u64> }`. Undecodable bytes become `db XX` of length 1. `target` is set for near branches and RIP-relative memory.
  - `disasm::instruction_before(t, rip) -> Option<u64>` (D21's backward decode; used by Task 9).
  - RPC: `disassemble`. It reads up to `count * 15` bytes and shrinks the read when it crosses into an unreadable page. Capability `"disasm"`.

- [ ] **Step 1: Write the failing tests**

Unit:
```rust
#[test] fn formats_ce_style() { // 8B 05 10 00 00 00 at ip 0x1000 → "mov eax,[1016]"; 48 89 4C 24 08 → "mov [rsp+8],rcx"
}
#[test] fn bad_byte_is_db() { /* [0x06] in 64-bit → "db 06" */ }
#[test] fn instruction_before_finds_start() { /* buffer "89 05 xx xx xx xx" then "C3": instruction_before(end of mov) == mov start */ }
```
Integration:
```rust
#[test] fn disassembles_bump_counter_with_symbol() {
    // --writer; disassemble {address: addr("bump_counter"), count: 8} → first symbol starts "target+0x";
    // some instruction's text contains "[" and its target.address == addr("g_counter") (RIP-relative, or absolute in a -no-pie build)
}
#[test] fn count_over_500_is_32602() {}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml disasm`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "feat(starlightd): CE-style disassembly with module annotation (iced-x86: MIT)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Signature builder

**Files:**
- Create: `packages/starlightd/src/signature.rs`
- Modify: `src/rpc.rs`, `tests/disasm.rs`

**Interfaces:**
- Consumes: `disasm::decode`, `aob::{Pattern, scan, module_range}`, `modules::list`, `maps::read`.
- Produces (Rust):
  - `signature::wildcard_mask(insn: &iced_x86::Instruction, bytes: &[u8], looks_like_address: impl Fn(u64) -> bool) -> Vec<bool>`, using `Decoder::get_constant_offsets`. It wildcards the displacement when the memory base is RIP or the displacement looks like an address, the immediate when it looks like an address, and the branch offset of rel32 near branches. rel8 branches are kept.
  - `signature::build(t: &Target, address: u64, max_len: usize) -> Result<Signature, RpcError>`, where `Signature { pattern: String /* "8B 05 ?? ?? ?? ??" */, module: String, length: usize, unique: bool, matches: usize }` (D22). An address outside every module → `-32005`.
  - RPC: `make_signature` (slow). Capability `"signature"`.

- [ ] **Step 1: Write the failing tests**

Unit: `rip_relative_displacement_is_wildcarded`, `rel32_call_is_wildcarded_rel8_jump_is_not`, `small_immediate_is_kept` (`83 C0 01` stays exact).
Integration (`tests/disasm.rs`):
```rust
#[test] fn signature_for_bump_counter_is_unique_and_scans_back() {
    // make_signature {address: addr("bump_counter")} → unique == true, matches == 1;
    // aob_scan {module:"target", pattern} → matches == [addr("bump_counter")]
}
#[test] fn signature_outside_modules_is_32005() { /* address "0x1000" */ }
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml signature`
Expected: FAIL.

- [ ] **Step 3: Implement** per D22.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "feat(starlightd): unique AOB signature builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Assembler (CE-style Intel syntax)

**Files:**
- Create: `packages/starlightd/src/asm/mod.rs`, `src/asm/parse.rs`, `src/asm/encode.rs`
- Modify: `src/rpc.rs`, `tests/disasm.rs` (round-trip against live code)

**Interfaces:**
- Consumes: `disasm::{decode, formatter}` (round-trip tests), `modules::list` (resolver for `assemble` with a handle).
- Produces (Rust, library API reused by Tasks 11–12 and M4):
  - `asm::assemble(source: &str, address: u64, resolve: &dyn Fn(&str) -> Option<u64>) -> Result<Assembled, AsmError>`, where `Assembled { bytes: Vec<u8>, labels: BTreeMap<String, u64> }` and `AsmError { line: usize, message: String }`. `RpcError::assemble_failed(format!("line {}: {}", line, message))`.
  - `asm::parse::Line` = `Label(String)` | `Insn { mnemonic: String, operands: Vec<Operand> }` | `Data { width: 1|2|4|8, items: Vec<DataItem> }`. `Operand` = `Reg(Register)` | `Imm(Expr)` | `Mem { size: Option<MemSize>, seg: Option<Register>, base, index, scale, disp: Expr }`. `Expr` = `Num(i128)` | `Sym { name, addend: i64 }`.
- **Accepted subset (state it in the module doc comment; M4 extends it):**
  - One statement per line. `label:` may stand alone or prefix an instruction. Comments: `//…`, `;…`, `{ … }` (may span lines). Case-insensitive mnemonics, registers and size keywords.
  - Registers: all 8/16/32/64-bit GPRs (including `r8b`–`r15b`, `r8w`, `r8d`, `spl`/`bpl`/`sil`/`dil`), `xmm0`–`xmm15`, and the segment overrides `fs`/`gs`.
  - Numbers: hex by default (`10` = 16), `0x` prefix, `#` decimal, leading `-` (D2).
  - Memory: `[base + index*scale ± disp]` with any subset; `[symbol]`, `[symbol+disp]` and `[label]` encode RIP-relative (error if out of rel32 range); `fs:[…]`/`gs:[…]` and `[gs:30]`; size keywords `byte|word|dword|qword|xmmword` with optional `ptr`. A memory operand with an immediate and no size → `dword` (D2).
  - Symbols: labels defined in the source; otherwise the `resolve` callback, which handles `name`, `name+hex`, `name-hex`, `module.dll+hex` and `"Module Name.dll"+hex`.
  - Branches: `jmp`/`call`/`jcc` to labels, symbols or numbers (short or near chosen by `BlockEncoder`; error if the target is out of rel32 range). Aliases: `jz/je`, `jnz/jne`, `jc/jb/jnae`, `jnc/jae/jnb`, `jna/jbe`, `jnbe/ja`, `jnge/jl`, `jnl/jge`, `jng/jle`, `jnle/jg`, `jpe/jp`, `jpo/jnp`, the same for `setcc`/`cmovcc`, and `retn` → `ret`.
  - Data: `db`, `dw`, `dd` and `dq` with comma- or space-separated items. `db 'text'` takes string bytes. `dd (float)1.5` and `dq (double)1.5` are accepted.
  - Encoding: candidates are `Code::values()` with `code.mnemonic()` equal to the mnemonic and operand kinds compatible with each parsed operand. Every candidate is encoded and the shortest kept (D1). Missing size information that `dword` can't resolve → `AsmError`.
  - RPC: `assemble` (fast). A `handle` adds module-name resolution. `symbols` adds names. Capability `"assemble"`.

- [ ] **Step 1: Write the failing tests**

Unit (`asm/mod.rs`):
```rust
#[test] fn hex_by_default_and_hash_decimal() { // "mov eax,10" → B8 10 00 00 00 ; "mov eax,#10" → B8 0A 00 00 00
}
#[test] fn ce_style_memory_and_sizes() { // "mov dword ptr [rax+10],1" == "mov [rax+10],1" == C7 40 10 01 00 00 00
}
#[test] fn labels_and_short_branches() { // "a:\n jmp a" → EB FE ; labels["a"] == address
}
#[test] fn rip_relative_label_data() { // "mov rax,[v]\nret\nv:\ndq 1122334455667788" → 48 8B 05 01 00 00 00 C3 88 77 ...
}
#[test] fn segment_override_thread_pointer() { // "mov rax,gs:[30]" → 65 48 8B 04 25 30 00 00 00 ; "mov rax,fs:[0]" → 64 48 8B 04 25 00 00 00 00
}
#[test] fn sse_and_lock_forms() { // cvtsi2sd xmm0,rax / mulsd xmm0,[rcx] / cvttsd2si rax,xmm0 / lock cmpxchg [rdx],rcx / pause each encode
}
#[test] fn aliases() { /* "jz a" == "je a"; "retn" == C3 */ }
#[test] fn data_with_float_cast() { // "dd (float)1.5" → 00 00 C0 3F
}
#[test] fn errors_carry_line_numbers() { // "nop\nmov eax,\n" → AsmError { line: 2, .. }; unknown mnemonic → line given
}
#[test] fn out_of_range_branch_is_error() { /* "jmp 7FFF00000000" at 0x1000 */ }
#[test] fn round_trips_disassembly_corpus() {
    // for each of ~40 encoded instructions (mov/lea/add/sub/cmp/test/jcc/call/movss/movsd/cvt*/imul/push/pop/xor/and/or/shl/shr/inc/dec/lock xadd/setcc/cmovcc):
    // assemble(format(decode(bytes, ip)), ip) == bytes
}
```
Integration (`tests/disasm.rs`):
```rust
#[test] fn round_trips_live_bump_counter() {
    // disassemble 8 instructions of bump_counter; assemble each text at its address → identical bytes
}
#[test] fn assemble_resolves_module_symbols() { // assemble {handle, address: base, source:"jmp target+10"} decodes to a jump to module base + 0x10
}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml asm`
Expected: FAIL.

- [ ] **Step 3: Implement** per the subset above. `BlockEncoder::encode(64, InstructionBlock::new(&insns, address), BlockEncoderOptions::NONE)`. Labels are handled by giving each instruction a provisional IP (index-based placeholder addresses) and pointing branch and RIP-relative operands at the label's placeholder.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "feat(starlightd): CE-style Intel assembler on iced-x86

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Tracer thread, remote syscall, alloc/free

**Files:**
- Create: `packages/starlightd/src/tracer.rs`, `src/remote.rs`, `tests/code.rs`
- Modify: `src/rpc.rs`, `src/process.rs` (`Target` gets `tracer() -> Result<Arc<Tracer>, RpcError>`), `packages/engine/test-target/target.c` (`--spin`)

**Interfaces:**
- Consumes: `maps::read`, `mem::{read_bytes, write_bytes}`, `Owner`.
- Produces (Rust):
  - `tracer::for_pid(pid: i32) -> Result<Arc<Tracer>, RpcError>`: global `Mutex<HashMap<i32, Weak<Tracer>>>`. The first call spawns the tracer thread and seizes every thread in `/proc/<pid>/task`, re-listing until stable. `EPERM` → `-32012 PtraceFailed` ("another debugger is attached to this game (Cheat Engine?)" when `/proc/<pid>/status` `TracerPid` ≠ 0). Dropping the last `Arc` clears debug registers and `PTRACE_DETACH`es every thread.
  - `Tracer::with_stopped<R: Send>(&self, f: impl FnOnce(&mut Stopped) -> R + Send) -> Result<R, RpcError>`: interrupts every thread, waits for each stop, runs `f` on the tracer thread, and resumes every thread (re-injecting queued signals).
  - `Stopped::{tids() -> &[i32], regs(tid) -> libc::user_regs_struct, set_regs(tid, &regs), syscall(nr: i64, args: [u64; 6]) -> Result<i64, RpcError>, set_debugreg(tid, idx: usize, value: u64)}`.
  - `Tracer::set_watch_slot(&self, slot: usize, cfg: Option<DrConfig>)` and `Tracer::subscribe_traps(&self) -> mpsc::Receiver<Trap>`, where `Trap { tid, regs, dr6 }`. A slot config applies to every current thread and to every new thread on its `PTRACE_EVENT_STOP` before it first runs. Used in Task 9.
  - Event loop (D5): signal stops not caused by our traps are re-injected with `PTRACE_CONT sig`; group-stops use `PTRACE_LISTEN`; exits remove the tid. When the whole process is gone, every pending `with_stopped` fails with `ProcessNotFound`.
  - `remote::syscall_site(t) -> Result<u64, RpcError>` (a `0f 05` in an r-x file-backed mapping, libc first; cached per tracer) and `remote::mmap(stopped, len, prot, hint: Option<u64>) -> Result<u64, RpcError>` (D6).
  - `remote::alloc(t, size, near: Option<u64>, prot) -> Result<u64, RpcError>` (D7) and `remote::free(t, addr, size)`.
  - RPC: `alloc`, `free` (slow). Allocations are recorded per handle so `free` only accepts addresses this handle allocated (`-32009` otherwise). Allocations are **not** freed on teardown (D9). Capability `"alloc"`.
- Produces (test target): `--spin` starts a thread that calls `noinline int spin_target(int)` in a tight loop. It prints `addr spin_target=` and `addr g_spin_calls=` (a counter the loop increments).

- [ ] **Step 1: Write the failing tests**

`tests/code.rs`:
```rust
#[test] fn alloc_returns_rwx_memory_we_can_use() {
    // alloc {size: 100} → address page-aligned, size 4096; write/read round-trips; /proc/pid/maps shows rwxp at it
}
#[test] fn alloc_near_is_within_2gb() { // near = addr("bump_counter") → |address - near| < 2^31 - 4096
}
#[test] fn target_keeps_running_after_alloc() {
    // --spin; read g_spin_calls; alloc 5 times; sleep 100 ms; g_spin_calls increased; target alive (kill(pid, 0) == 0)
}
#[test] fn blocked_syscall_resumes_after_alloc() {
    // the target's main thread sits in sleep(1); after alloc, the target still prints/updates (g_spin_calls rising), and t.kill() then wait works (not stuck in ptrace-stop)
}
#[test] fn free_unknown_address_is_32009() {}
#[test] fn second_tracer_is_32012() { // the test process itself PTRACE_SEIZEs the target (libc); alloc → -32012 with "another debugger" in the message; test detaches after
}
#[test] fn detach_releases_ptrace() { // alloc; detach; /proc/pid/status TracerPid == 0 within 1 s
}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test code`
Expected: FAIL.

- [ ] **Step 3: Implement** per D5–D7. ptrace calls go through `libc::ptrace`. Debug registers: `PTRACE_POKEUSER` at `offset_of!(libc::user, u_debugreg) + 8 * idx`. The handle holds its `Arc<Tracer>` only while it has allocations, patches, watches or speed hooks, so a plain attach never ptraces the game (spec §6.1: "no ptrace stop for read/write/scan").

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target
git commit -m "feat(starlightd): ptrace tracer thread and remote mmap alloc

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Recorded patches and inline hooks, reverted on session end

**Files:**
- Create: `packages/starlightd/src/patch.rs`, `src/hook.rs`
- Modify: `src/rpc.rs`, `tests/code.rs`

**Interfaces:**
- Consumes: `Tracer::with_stopped`, `remote::alloc`, `asm::assemble`, `disasm::decode`, `Owner::add(Some(handle), Teardown::Patch, …)`.
- Produces (Rust):
  - `patch::write_code(t: &Target, tracer: &Tracer, addr: u64, bytes: &[u8]) -> Result<Vec<u8> /* original */, RpcError>` (D8: stop-the-world, RIP check, retry, `-32013` after 200 tries).
  - `patch::Patches` (per connection): `apply(handle, t, addr, bytes) -> Result<(u32, Vec<u8>), RpcError>`. It rejects an overlap with a live patch (`-32014`) and registers a teardown that reverts only if the current bytes still equal the written ones. `revert(id, force) -> Result<(), RpcError>` returns `-32014` if the bytes changed and `!force`.
  - `hook::install(t, tracer, patches, handle, func: u64, body: &dyn Fn(u64 /* trampoline */) -> String /* asm source */) -> Result<Hook, HookError>`, where `Hook { func, patch_id: u32, code: u64, trampoline: u64, displaced: Vec<u8> }` and `HookError::Skipped(String) | Rpc(RpcError)` (D10). Layout of the near-allocated page: `[hook body][trampoline: relocated displaced instructions (BlockEncoder at the new IP) + jmp func+len]`. The entry patch is `E9 rel32` padded with `0x90` to the displaced length.
  - RPC: `patch`, `unpatch` (slow). Capability `"patch"`.

- [ ] **Step 1: Write the failing tests**

`tests/code.rs`:
```rust
#[test] fn patch_and_unpatch_restore_original_bytes() {
    // patch bump_counter's first instruction with NOPs of the same length; g_counter stops increasing; unpatch → bytes == original, g_counter increases again
}
#[test] fn patch_waits_until_no_thread_is_inside_the_site() {
    // --spin: patch spin_target with its own original bytes 500 times in a loop; target never dies; g_spin_calls keeps rising
}
#[test] fn overlapping_patch_is_32014() {}
#[test] fn unpatch_after_game_changed_bytes_is_32014_unless_forced() {}
#[test] fn detach_restores_patched_bytes() {}
#[test] fn connection_drop_restores_patched_bytes() { /* client A patches; drop A; new client reads original bytes within 1 s */ }
#[test] fn stdin_eof_restores_patched_bytes() {
    // patch; d.close_stdin(); daemon exits within 3 s; reading /proc/<pid>/mem from the test (same uid, ptrace_scope 0) shows original bytes
}
#[test] fn inline_hook_runs_body_and_trampoline() {
    // hook spin_target with body "inc qword [<addr of a counter in an alloc'd page>]\njmp <trampoline>"; counter rises, spin_target still returns right (g_spin_calls rising), revert restores bytes
}
```
Unit (`hook.rs`): `refuses_call_in_displaced_range`, `refuses_short_function`, `relocates_rip_relative_mov` (decode the relocated trampoline: its memory operand targets the same absolute address).

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --test code`
Expected: FAIL.

- [ ] **Step 3: Implement** per D8–D10. Teardown of a dead process is a no-op (the write fails; ignore it, log nothing to the client).

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "feat(starlightd): reversible code patches and inline hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Watchpoints ("what writes / accesses this address")

**Files:**
- Create: `packages/starlightd/src/watch.rs`, `tests/watch.rs`
- Modify: `src/rpc.rs`, `packages/engine/test-target/target.c` (`--late-writer <ms>`)

**Interfaces:**
- Consumes: `Tracer::{set_watch_slot, subscribe_traps}`, `disasm::{instruction_before, decode, Symbolizer}`, `Owner::add(Some(handle), Teardown::Watch, …)`.
- Produces (Rust):
  - `watch::Watches` (per connection): `start(handle, t, addr, size, kind, duration, max_hits) -> Result<u32, RpcError>` (`-32013 Busy` when all 4 slots of that pid are taken; `-32602` for a bad size, misalignment, or a duration over 60,000), `poll(id)`, `stop(id) -> Result<Report, RpcError>`.
  - `DrConfig { addr: u64, len: 1|2|4|8, rw: Write | Access }` → DR7 bits: local-enable `L<n>`, `R/W<n>` = 01 or 11, `LEN<n>` = 00/01/11/10 for 1/2/4/8.
  - A collector thread per watch aggregates `Trap`s (DR6 bit `n` set) by instruction start (D21). It ends the watch at the deadline, at `max_hits`, when the process exits or on detach, clears the slot on every thread, and sends `watch_ended`.
  - RPC: `watch_start`, `watch_poll`, `watch_stop`. Capability `"watch"`.
- Produces (test target): `--late-writer <ms>` starts the `bump_counter` thread only after `<ms>`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn write_watch_reports_bump_counter() {
    // --writer; watch_start {address: g_counter, size: 4, kind: "write", duration_ms: 1000}; sleep 400 ms; watch_stop
    // → one hit whose address is inside bump_counter (≥ addr("bump_counter")), module starts "target+0x", count ≥ 3, text contains "[", registers.rip == hit.next
}
#[test] fn access_watch_reports_reads_too() { /* kind "access" on g_health while the main loop touches it each second → hit within 1.5 s */ }
#[test] fn late_thread_hits_are_reported() { // --late-writer 300; start watch; sleep 800 ms; stop → hits non-empty
}
#[test] fn watch_times_out_and_notifies() { // duration_ms 300 → notification watch_ended {reason:"timeout"} within 1 s; poll → active false
}
#[test] fn watch_ends_when_target_exits() { /* start; t.kill() → watch_ended {reason:"process_exited"} */ }
#[test] fn closing_connection_clears_watch_and_detaches() {
    // client A starts a watch; drop A; within 1 s /proc/pid/status TracerPid == 0; the target is still alive after 500 ms (no stray SIGTRAP)
}
#[test] fn fifth_watch_is_busy() {}
#[test] fn misaligned_address_is_32602() {}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test watch`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block and D21. Register values are captured from `Trap.regs`.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target
git commit -m "feat(starlightd): hardware watchpoints on every thread

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Pointer scan and rescan

**Files:**
- Create: `packages/starlightd/src/pointer_scan.rs`, `tests/pointer_scan.rs`
- Modify: `src/rpc.rs`, `packages/engine/test-target/target.c` (`--heap-chain`, `--decoy`)

**Interfaces:**
- Consumes: `regions::scannable`, `modules::list`, `pointer::resolve`, `mem::read_bytes`.
- Produces (Rust):
  - `pointer_scan::Path { module: String, base: u64 /* module-relative */, offsets: Vec<u64> }`. Its semantics are exactly M1's `resolve_pointer`: `addr = module_base + base`, then `addr = read_u64(addr) + off` for each offset.
  - `pointer_scan::scan(t, target: u64, opts: Opts) -> Result<Vec<Path>, RpcError>` (D20); `Opts { max_depth: u8, max_offset: u64, max_results: usize, modules: Option<Vec<String>> }`.
  - `pointer_scan::PointerScans` (per connection, not per handle): `start`, `results(id, offset, limit)`, `rescan(id, t, address: Option<u64>) -> Result<u64, RpcError>`, `end(id)`.
  - RPC: `pointer_scan`, `pointer_results`, `pointer_rescan` (slow), `pointer_end`. Capability `"pointer_scan"`.
- Produces (test target): `--heap-chain` mallocs A and B, sets `*(void**)(A+0x18) = B`, `*(int32_t*)(B+0x10) = 777`, `g_root = A`, and prints `addr g_root=`, `addr heap_value=`. `--decoy` also sets `g_decoy = B` (another static path, `g_decoy → [0x10]`).

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn finds_static_path_through_heap() {
    // --heap-chain; pointer_scan {address: heap_value} → paths include {module:"target", base: addr(g_root) - target_base, offsets:["0x18","0x10"]};
    // resolve_pointer on that path == heap_value
}
#[test] fn rescan_after_restart_drops_stale_paths() {
    // run 1 with --heap-chain --decoy: both paths found; kill; run 2 with --heap-chain only (new pid, new heap);
    // attach new handle; pointer_rescan {id, handle: new, address: new heap_value} → count ≥ 1; the decoy path is gone; the g_root path remains
}
#[test] fn depth_limit_is_respected() { /* max_depth 1 → the 2-level g_root path is absent */ }
#[test] fn results_paging_and_unknown_id() {}
```
Unit: a synthetic memory map (closure-based reader) with a 3-level chain, a cycle (A → B → A) that must not loop, and a `max_offset` cut.

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test pointer_scan`
Expected: FAIL.

- [ ] **Step 3: Implement** per D20. A location already visited at a shallower level is not expanded again (this bounds the work and cuts cycles).

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target
git commit -m "feat(starlightd): pointer scan and rescan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Game speed: state page, hook templates, native targets

**Files:**
- Create: `packages/starlightd/src/speed/mod.rs`, `src/speed/templates.rs`, `src/speed/targets.rs`, `tests/speed.rs`
- Modify: `src/rpc.rs`, `packages/engine/test-target/target.c` (`--clocks`)

**Interfaces:**
- Consumes: `hook::install`, `patch::{Patches, write_code}`, `remote::alloc`, `asm::assemble`, `symbols::{exports, resolve, got_slots}`, `modules::list`, `Owner`.
- Produces (Rust):
  - `speed::STATE_PAGE_SIZE = 0x2000`, `speed::MAGIC = *b"STLSPD01"`. State layout (offsets are constants in `templates.rs`): `0x00` magic, `0x08` lock `u32`, `0x10` speed `f64`, `0x18` gen `u32`, `0x40` 32 slots × 32 bytes `{real0 i64, fake0 i64, speed f64, gen u32, pad}`, `0x440` nesting table of 64 × `{key u64, depth u64}`, `0x840` recovery record `{count u32, entries[32] { addr u64, len u8, original [16]u8 }}`, `0x1000` shared code (`scale`, `guard_enter`, `guard_leave`).
  - `speed::Kind = Qpc | Tick32 | Tick64 | ClockGettime | Gettimeofday | GettimeofdayGot`, `speed::Abi = Win64 | Sysv`.
  - `templates::hook_source(kind, abi, state: u64, slot: u32, trampoline_or_original: u64) -> String` (Intel text for `asm::assemble`). Each hook: save → `guard_enter` (thread key `gs:[0x30]` on Win64, `fs:[0]` on Sysv; D13) → call the original (trampoline, or `[original]` for `GettimeofdayGot`) → if not nested and the call succeeded, convert to ticks (ns for timespec, µs for timeval), `scale(slot)`, convert back → `guard_leave` → restore → `ret`. Win64 hooks keep 32 bytes of shadow space and 16-byte alignment. Sysv hooks keep 16-byte alignment.
  - `scale`: under the spinlock (`lock cmpxchg` + `pause`), if `slot.gen != state.gen` rebase (`fake0 = fake(real)`, `real0 = real`, `slot.speed = state.speed`, `slot.gen = state.gen`), with first use setting `real0 = fake0 = real`; returns `fake0 + (i64)((f64)(real − real0) × slot.speed)`. It reads `gen` before `speed` (the daemon writes speed first, then gen).
  - `targets::HookTarget { name: String, address: u64, abi: Abi, kind: Kind, slot: u32, original: Option<u64> /* GettimeofdayGot only */, got_slots: Vec<u64> }`; `targets::native(t, mods) -> Vec<HookTarget>` per D16 and D14 (`clock_gettime` → `ClockGettime` with per-id slots 0–7; `gettimeofday` → `Gettimeofday` or `GettimeofdayGot`, the latter with original `__vdso_gettimeofday` from `[vdso]`'s dynsym).
  - `speed::Speeds` (per connection, keyed by handle): `set(handle, t, speed, targets_override) -> Result<Status, RpcError>`. It does orphan recovery first (D12). The first non-1.0 call allocates the state page, writes speed and gen = 1, and installs hooks, recording each in the recovery record. Later calls write speed, then gen+1. **1.0 is a normal speed change: the hooks stay, so time stays continuous.** It registers a `Teardown::Patch` that reverts every hook patch (newest first), clears the recovery record and leaves the pages (D9). Also `get(handle, t) -> Status`.
  - Debug builds: `speed_set.targets: [{ name, address, abi, kind }]` replaces target discovery (used by these tests and Task 12).
  - RPC: `speed_set` (slow), `speed_get`. Capability `"speed"`.
- Produces (test target): `--clocks` starts a thread that every 20 ms stores `g_mono_ns` (from `clock_gettime(CLOCK_MONOTONIC)`), `g_tod_us` (from `gettimeofday`) and `g_wrapped_ns` (from `noinline int clock_wrapper(clockid_t, struct timespec*)`, which calls `clock_gettime`). It prints their addresses and `addr clock_wrapper=`.

- [ ] **Step 1: Write the failing tests**

Helper in `tests/speed.rs`: `rate(c, h, addr, unit_per_s) -> f64` reads the value, sleeps 1 s of the test's own `Instant`, reads again, and returns the delta per real second ÷ `unit_per_s`.
```rust
#[test] fn native_speed_2_doubles_monotonic_and_gettimeofday() {
    // --clocks; speed_set 2.0 → hooks include "clock_gettime" hooked and "gettimeofday" hooked;
    // rate(g_mono_ns, 1e9) ∈ [1.8, 2.2]; rate(g_tod_us, 1e6) ∈ [1.8, 2.2]
}
#[test] fn speed_change_keeps_time_continuous() {
    // 2.0 then 0.5: g_mono_ns never decreases across the change (sample every 20 ms for 1 s); rate ≈ 0.5
}
#[test] fn speed_1_restores_original_bytes() {
    // read 16 bytes at libc clock_gettime before; 2.0; 1.0 → bytes equal; rate ≈ 1.0; speed_get → hooks empty
}
#[test] fn nested_sysv_calls_scale_once() {
    // debug targets: clock_gettime (ClockGettime) AND clock_wrapper (ClockGettime) → rate(g_wrapped_ns) ∈ [1.8, 2.2], not ≈ 4
}
#[test] fn out_of_range_speed_is_32602() { /* 0.0, 0.05, 11 */ }
#[test] fn detach_restores_speed_hooks() {}
#[test] fn stdin_eof_restores_speed_hooks() {}
#[test] fn orphaned_hooks_are_recovered() {
    // daemon A: speed 2.0; SIGKILL daemon A; daemon B attach + speed_get → libc clock_gettime bytes restored, rate ≈ 1.0, speed == 1.0
}
```
Unit (`templates.rs`): every `(kind, abi)` template assembles with `asm::assemble` at a sample address, and the sizes fit in the code page.

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test speed`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block and D11–D17. A target that `hook::install` skips is reported `skipped` with the reason, and speed still applies to the rest. If **no** target can be hooked → `-32602` with "this game's timing functions can't be hooked: …".

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass. `tests/speed.rs` is timing-sensitive: its header comment says to run it with `-- --test-threads=2`, and CI's existing `cargo test` step is fine because each test owns its target and daemon. Don't widen the tolerances to make a flaky run pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target
git commit -m "feat(starlightd): game speed for native games via reversible timing hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Game speed on Proton (Windows timing functions)

**Files:**
- Modify: `packages/starlightd/src/speed/targets.rs`, `src/speed/templates.rs`, `tests/speed.rs`, `packages/engine/test-target/target.c` (`--win64-clocks`)

**Interfaces:**
- Consumes: Task 11's `Speeds`, templates, debug `targets` override; `symbols::resolve` (forwarders).
- Produces (Rust):
  - `targets::wine(read: &dyn Fn(u64, usize) -> Option<Vec<u8>>, mods: &[Module]) -> Vec<HookTarget>` per D15: names resolved with forwarders, deduplicated by final address (first name wins and is reported; later names are reported `skipped: "same function as <name>"`), slots per D14. `speed::Speeds::set` picks `wine` when `modules::find(mods, "ntdll.dll")` is a `Pe` module, otherwise `native`.
  - Win64 templates for `Qpc` (BOOL f(LARGE_INTEGER* rcx, …): scale `[rcx]` when `eax != 0`), `Tick32` (eax, zero-extended), `Tick64` (rax).
- Produces (test target): `--win64-clocks` starts a thread that sets its GS base to a fake TEB (`arch_prctl(ARCH_SET_GS, teb)`, with `teb+0x30 = teb`) and every 20 ms calls `__attribute__((ms_abi, noinline))` functions:
  - `fake_qpc(int64_t*)`, which returns monotonic ns / 100 (10 MHz)
  - `fake_tick32()` and `fake_tick64()`, which return ms
  - `fake_time_get_time()`, which calls `fake_qpc` **through a volatile function pointer** and returns ms

  Each function has its own `g_w_*` result global, and the thread prints their addresses and functions.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn win64_templates_scale_qpc_and_ticks() {
    // debug targets: fake_qpc Qpc/Win64, fake_tick32 Tick32, fake_tick64 Tick64 → at 2.0 each g_w_* rate ∈ [1.8, 2.2]
}
#[test] fn nested_win64_calls_scale_once() {
    // targets fake_qpc (Qpc) + fake_time_get_time (Tick32) → rate(g_w_tgt) ∈ [1.8, 2.2]
}
#[test] fn wine_target_selection_follows_forwarders_and_dedupes() {
    // unit-level: build a module list with minimal PEs (ntdll exports RtlQueryPerformanceCounter + NtQueryPerformanceCounter; kernel32 exports
    // QueryPerformanceCounter as forwarder "NTDLL.RtlQueryPerformanceCounter", GetTickCount, GetTickCount64) via a closure reader →
    // targets = Rtl QPC (Qpc, slot QPC), NtQPC (Qpc, same slot), GetTickCount (Tick32), GetTickCount64 (Tick64); kernel32 QPC reported "same function as RtlQueryPerformanceCounter"; no winmm → no timeGetTime
}
#[test] fn native_process_without_ntdll_uses_native_targets() {}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test speed`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** per the Interfaces block. `targets::wine` takes a reader closure so the selection test needs no Wine.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target
git commit -m "feat(starlightd): game speed for Proton games (QPC, tick counts, timeGetTime)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `@starlight/engine` API for discovery, code and speed

**Files:**
- Create: `packages/engine/src/scan.ts`, `src/pointer-scan.ts`, `src/watch.ts`, `src/code.ts`, `src/speed.ts`, `src/symbols.ts`, `test/scan.test.ts`, `test/discovery.test.ts`, `test/code.test.ts`
- Modify: `packages/engine/src/types.ts`, `src/index.ts`, `src/memory.ts` (`readMany`), `test/helpers/spawn-target.ts` (`args?: string[]` passthrough), `README.md`

**Interfaces:**
- Consumes: Protocol v2 (all methods above); `Session` (`client`, `handle`).
- Produces (TS):
  - `types.ts`: `ScanType = Exclude<ValueType, 'string'> | 'string' | 'bytes'`; `FirstScanMode = 'exact' | 'bigger' | 'smaller' | 'range' | 'unknown'`; `NextScanMode = 'exact' | 'bigger' | 'smaller' | 'range' | 'changed' | 'unchanged' | 'increased' | 'decreased' | 'increased_by' | 'decreased_by'`; `Hit`; `Instruction`; `SpeedStatus`.
  - `scanFirst(s: Session, o: { type: ScanType; mode: FirstScanMode; value?: string; min?: string; max?: string; encoding?: 'utf-8' | 'utf-16le'; alignment?: number }): Promise<{ scan: number; count: number }>`; `scanNext(s, scan: number, o: { mode: NextScanMode; value?: string; min?: string; max?: string }): Promise<{ count: number }>`; `scanResults(s, scan, o?: { offset?: number; limit?: number }): Promise<{ count: number; results: Array<{ address: string; value: string | null }> }>`; `scanEnd(s, scan): Promise<void>`.
  - `readMany(s, items: Array<{ address: string; length: number }>): Promise<Array<Buffer | null>>`.
  - `pointerScan(s, o: { address: string; maxDepth?: number; maxOffset?: string; maxResults?: number; modules?: string[] }): Promise<{ id: number; count: number }>`; `pointerResults(s, id, o?): Promise<{ count: number; paths: PointerChainSpec[] }>` (mapped `base` → `baseAddress`, so `resolvePointerChain` accepts them directly); `pointerRescan(s, id, address?: string): Promise<{ count: number }>`; `pointerEnd(s, id)`.
  - `watchStart(s, o: { address: string; size: 1 | 2 | 4 | 8; kind: 'write' | 'access'; durationMs?: number; maxHits?: number }): Promise<{ id: number; poll(): Promise<WatchReport>; stop(): Promise<WatchReport>; onEnded(cb: (reason: string) => void): void }>`.
  - `disassemble(s, address: string, count?: number): Promise<Instruction[]>`; `makeSignature(s, address: string, maxLength?: number): Promise<{ pattern: string; module: string; length: number; unique: boolean; matches: number }>`; `assemble(s: Session | EngineClient, o: { address: string; source: string; symbols?: Record<string, string> }): Promise<{ bytes: Buffer; labels: Record<string, string> }>`; `alloc(s, o: { size: number; near?: string; prot?: 'rwx' | 'rw' | 'rx' }): Promise<string>`; `free(s, address)`; `patch(s, address: string, bytes: Buffer): Promise<{ id: number; original: Buffer; revert(force?: boolean): Promise<void> }>`.
  - `setSpeed(s, speed: number): Promise<SpeedStatus>`; `getSpeed(s): Promise<SpeedStatus>`; `moduleExports(s, module)`; `resolveSymbol(s, module, name): Promise<string>`.
  - All exported from `index.ts`. README gets a "Discovery, code and speed" section and notes that ptrace-based features need the same permission as attach.

- [ ] **Step 1: Write the failing tests** (real debug daemon + C target, as the existing tests do)

```ts
// scan.test.ts
it('first exact int32 scan finds g_health, next scan narrows after a write', ...)
it('unknown + increased finds g_counter (--writer)', ...)
it('scanResults pages and scanEnd forgets the scan (-32009 afterwards → EngineError code RpcCode.UnknownId)', ...)
// discovery.test.ts
it('pointerScan paths resolve with resolvePointerChain (--heap-chain)', ...)
it('watchStart on g_counter reports a hit inside bump_counter (--writer)', ...)
it('disassemble + makeSignature round-trip through aobScan', ...)
// code.test.ts
it('assemble + alloc + patch + revert restores bytes', ...)
it('setSpeed(2) doubles g_mono_ns rate, setSpeed(1) restores bytes (--clocks)', ...)
it('client.capabilities lists every M2 capability', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo build --manifest-path packages/starlightd/Cargo.toml && pnpm --filter @starlight/engine build && pnpm --filter @starlight/engine test`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement** thin wrappers per the Interfaces block. Wire names are snake_case and TS names camelCase. Addresses stay `"0x…"` strings.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter @starlight/engine lint && pnpm --filter @starlight/engine test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): discovery, code injection and speed API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Memory scanner panel on starlightd

**Files:**
- Create: `apps/desktop/src/main/scanner-host.ts`, `apps/desktop/test/main/scanner-host.test.ts`
- Modify: `apps/desktop/src/main/ce-session.ts` (`SessionState.pid`, `callSession`, `endSession`), `apps/desktop/test/main/ce-session.test.ts`

**Interfaces:**
- Consumes: `attach`, `scanFirst`, `scanNext`, `scanResults`, `scanEnd`, `readMany`, `write`, `freeze`, `FreezeHandle` (`@starlight/engine`); `getEngineClient()` (`starlightd-host.ts`); `detectAntiCheat` (`anti-cheat.ts`).
- Produces (TS):
  - `scanner-host.ts`: `SCANNER_METHODS: ReadonlySet<string>` = `scan_first`, `scan_next`, `scan_status`, `scan_results`, `scan_reset`, `mem_read`, `mem_write`, `freeze_set`, `freeze_clear`.
  - `createScannerHost(deps: { getClient: () => Promise<EngineClient>; attach?: typeof attach; detectAntiCheatFn?: typeof detectAntiCheat }): ScannerHost`.
  - `interface ScannerHost { call(pid: number, method: string, params: unknown): Promise<Record<string, unknown>>; end(): Promise<void> }`.
  - Reply shapes are identical to the CE bridge (`ce-control-script.ts`): `scan_first`/`scan_next` → `{ ok: true }` right away, with the daemon call running in the background; `scan_status` → `{ busy, started, count, valueType }` (a background failure surfaces once as `{ ok: false, error }`); `scan_results { limit }` → `{ count, items: [{ address, value }], valueType }`, where `limit` is capped at 500 and `address` is uppercase hex without `0x` (`"7FF6A1B2C3D4"`); `scan_reset` → `{ ok: true }` (`{ ok: false, error: 'a scan is still running' }` while busy); `mem_read { items: [{ address, valueType }] }` → `{ values: string[] }` (`''` for unreadable); `mem_write`, `freeze_set`, `freeze_clear` → `{ ok: true }` or `{ ok: false, error }`.
  - Type mapping: `i8 → int8`, `i16 → int16`, `i32 → int32`, `i64 → int64`, `f32 → float`, `f64 → double`. First ops `exact|bigger|smaller|unknown` and next ops `exact|increased|decreased|changed|unchanged|bigger|smaller` map 1:1 onto engine modes. `freeze_set` uses a 100 ms interval and replaces an existing freeze on the same address. `mem_write` to a frozen address updates the frozen value.
  - It attaches lazily per pid, re-attaches when the pid changes, and runs the anti-cheat check before attaching (refusal → `{ ok: false, error: antiCheatMessage(hit) }`). `end()` cancels freezes, ends the scan and detaches.
  - `ce-session.ts`: `SessionState.pid: number | null` (set to `effectivePid` when the session attaches); `callSession` sends `SCANNER_METHODS` to the module-level scanner host when `active.pid` is set (else `{ ok: false, error: 'not attached to a game process' }`), **before** the CE bridge check; `endSession` awaits `scannerHost.end()` first. `CALLABLE` drops the scanner entries.
  - The renderer (`ScannerPanel.tsx`, `scanner-store.ts`) is **unchanged** (D23).

- [ ] **Step 1: Write the failing tests**

`scanner-host.test.ts` (fake `getClient` with a recording `call`, injected `attach`):
```ts
it('scan_first returns ok immediately and scan_status reports busy until the daemon answers', ...)
it('maps i32/exact to scan_first {type:"int32", mode:"exact", value:"100"}', ...)
it('scan_results formats addresses as uppercase hex without 0x and caps limit at 500', ...)
it('mem_read accepts CE-format addresses and returns "" for unreadable', ...)
it('freeze_set then mem_write updates the frozen value; freeze_clear cancels', ...)
it('refuses with the anti-cheat message and never attaches', ...)
it('end() cancels freezes, ends the scan and detaches', ...)
it('a new pid re-attaches', ...)
```
`ce-session.test.ts`:
```ts
it('routes scanner commands to the scanner host, not the CE bridge', ...)
it('endSession ends the scanner before shutting CE down', ...)
```
Existing `test/stores/scanner-store.test.ts` and `test/components/CeSessionView.test.tsx` must pass unchanged.

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- scanner-host ce-session`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests, lint, and a dev check**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test`
Expected: all pass. `git diff --stat main -- apps/desktop/src/renderer` shows no changes from this task.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): memory scanner runs on starlightd

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Live verification (native target and a self-launched Proton process)

No new product code is expected. Any bug found goes back to its owning task, with a test. The Windows test program and its Makefile are the only new files.

**Files:**
- Create: `packages/engine/test-target/win/clocks.c`, `packages/engine/test-target/win/Makefile`, `scripts/live-m2.mjs` (a throwaway-safe verification script using `packages/engine/dist`)

**Interfaces:**
- Consumes: everything above.
- `clocks.exe`: every 250 ms it calls `QueryPerformanceCounter` (with `QueryPerformanceFrequency`), `GetTickCount`, `GetTickCount64` and `timeGetTime`, stores the elapsed values in globals, increments `g_counter` in a `noinline` function, and prints one line `t qpc_ms=… tick=… tick64=… tgt=…` plus, once at start, `addr g_counter=0x…`. It links `-lwinmm`.

- [ ] **Step 1: Build**

Run: `cargo build --release --manifest-path packages/starlightd/Cargo.toml && cargo build --manifest-path packages/starlightd/Cargo.toml && pnpm -r build && make -C packages/engine/test-target && make -C packages/engine/test-target/win`
Expected: `packages/engine/test-target/win/build/clocks.exe` exists.

- [ ] **Step 2: Native target, through the engine**

Run `node scripts/live-m2.mjs native`. It spawns `target --writer --heap-chain --clocks` itself, then attaches and runs value scan, pointer scan, write watch, signature + AOB round-trip, alloc + patch + revert, and speed 2.0 → 0.5 → 1.0.
Expected: every check prints `ok`. The clock rates are within ±10%, and the libc `clock_gettime` bytes after 1.0 equal the bytes before. The script kills only the pid it spawned.

- [ ] **Step 3: Proton process the script launches**

Run `node scripts/live-m2.mjs proton`. It runs `clocks.exe` with `"$HOME/.steam/steam/steamapps/common/Proton 11.0/proton" run`, using `STEAM_COMPAT_DATA_PATH=$(mktemp -d)/pfx` and `STEAM_COMPAT_CLIENT_INSTALL_PATH=$HOME/.steam/steam`. That is a **throwaway prefix, never a game's** (see memory `starlight-proton-s-drive`). It finds the Linux pid whose `/proc/<pid>/comm` is `clocks.exe` **among the script's own descendants**, then:
- `speed_get` → `speed_set 2.0`
- read the printed lines for 2 s
- `speed_set 1.0` and check the bytes
- `watch_start` on `g_counter` (write)
- value scan for `g_counter`

Expected:
- the hooks list `RtlQueryPerformanceCounter` (or its forwarder) and `GetTickCount64` as `hooked`
- all four printed rates ≈ 2.0 (±10%) and none ≈ 4.0
- 1.0 restores the bytes and the rates return to ≈ 1.0
- the watch hit's `module` starts with `clocks.exe+0x`
- the scan finds `g_counter`

Record which functions were `skipped`, and why.

- [ ] **Step 4: Session-end safety, live**

With speed 2.0 on `clocks.exe`, close the daemon's stdin (the script's `stop()`).
Expected: the daemon exits within 3 s, the rates go back to ≈ 1.0 and `clocks.exe` keeps running. Then repeat with `kill -9` on the daemon: rates stay at 2.0 (D12). A fresh daemon's `speed_get` restores them to ≈ 1.0.

- [ ] **Step 5: Memory scanner in the app**

Run the dev app against a temporary config (`XDG_CONFIG_HOME=$(mktemp -d) ./node_modules/.bin/electron .` from `apps/desktop`). Add `packages/engine/test-target/build/target` as a manual game and launch it from Starlight. Open its page, then the Memory scanner. Run first scan `100` (whole number, 4 bytes) and keep `g_health`'s address. Type `999` in its value field, then freeze it.
Expected: results show CE-style addresses, the count narrows on next scan, the freeze holds, and the panel looks the same as before. Take a screenshot for the PR.

- [ ] **Step 6: Record results**

Write the outcomes (rates, skipped hooks, any Proton surprises) in the PR description and update memory `starlight-native-engine-plan.md`. Commit the test program and script:

```bash
git add packages/engine/test-target/win scripts/live-m2.mjs
git commit -m "test: live verification for native engine milestone 2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Follow-ups (later milestone plans)

- **Milestone 3** (separate plan): MCP server (`scan_first`/`scan_next`/`scan_results`, `pointer_scan`/`pointer_rescan`, `watch_writes`/`watch_accesses`, `disassemble`, `make_signature`, `test_cheat`, …, built on Task 13's API), attach approval, `ask_player` + hotkey + notifications, activity panel (shows patches, watches and speed), schema v2 with `verify`/`provenance`, saving to the library, the Settings connect card, and the one-engine-per-game rule (spec §6.6). That rule also decides whether a CE session may coexist with `starlightd` ptrace features.
- **Milestone 4** (separate plan): AA-subset compiler on `asm::assemble` (Task 6) + `remote::alloc` + `patch` (`alloc` near, `label`, `registersymbol`, `db/dd/dq`, `define`, `aobscanmodule`), the engine-agnostic session with CE and `starlightd` backends (this moves `CeSessionView`'s speed buttons to `starlightd` for native sessions, D24), `ct-runner` routing with reason codes, and the coverage script.
- Signature builder: extend backward through preceding instructions when forward-only isn't unique (D22).
- Speed for statically linked or vDSO-direct native games (Go runtimes, static binaries): not covered by libc hooks (D16).
- Freeing hook and trampoline pages once no thread can be inside them (D9).
- Unity IL2CPP/Mono introspection (spec non-goal for project 1).
- Game identity (Steam app id + build id) is still owed by M3 (M1 follow-up).
