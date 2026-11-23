# @starlight/engine

Memory engine for Starlight. A typed client for `starlightd` (packages/starlightd),
the native daemon that does the memory work over JSON-RPC on a Unix socket.
Attach/detach, read/write, modules, pointer chains, AOB scans and freeze loops.
Nothing is injected into the game.

## Requirements

- Node 20+
- Linux x86-64
- A built `starlightd` (`cargo build` in packages/starlightd for tests)

## Discovery, code and speed

Everything takes a `Session` (`assemble` also accepts a bare `EngineClient`). Addresses are
`"0x..."` strings and scan values are strings as typed (`"100"`, `"1.5"`).

- **Value scans:** `scanFirst` / `scanNext` / `scanResults` / `scanEnd`. `ScanType` is `ValueType | 'bytes'`.
  Unknown-value scans stream snapshots to a cache file, so they work on large games. Calls on an ended
  scan fail with `RpcCode.UnknownId`. `readMany` reads many ranges in one round trip (`null` = unreadable).
- **Pointer scans:** `pointerScan` (reports `truncated` when it hit a limit), `pointerResults` (paths are
  `PointerChainSpec`s, so `resolvePointerChain` accepts them directly), `pointerRescan`, `pointerEnd`.
  `pointerRescan` without `address` reuses the session's last good target address; a successful rescan with
  a new `address` becomes the new target; a rescan that keeps no path returns 0 and leaves the paths and
  target unchanged. Scan ids belong to the connection, so a rescan works against a new
  session after a game restart.
- **Watchpoints:** `watchStart` uses debug registers on every thread and is time-boxed (default 10 s, max 60 s).
  `poll()` / `stop()` return a report; `onEnded(cb)` fires once when the watch ends by itself (not after
  `stop()`). A hit's `address` is `null` when the instruction start can't be decoded; `next` is always set.
- **Code:** `disassemble`, `makeSignature` (find it again with `aobScan`), `assemble` (CE-style Intel syntax),
  `alloc` / `free`, and `patch(...)` which returns `revert()`. Patches are written with every thread stopped and
  are reverted on `revert()` and on session end. Allocations are never freed automatically, not even on detach.
- **Speed:** `setSpeed(s, 0.1..10)` / `getSpeed`. At 1.0 the timing hooks stay installed as a pass-through, so
  game time stays continuous; the original bytes are restored only when the session ends (detach, connection
  drop or daemon exit).
- **Symbols:** `moduleExports`, `resolveSymbol` (export forwarders are followed).

Scans and memory reads use `process_vm_readv` (writes go through `/proc/<pid>/mem`), so they keep working while
another debugger such as Cheat Engine is attached. Watches, patches, `alloc`/`free` and speed stop the
game with ptrace: they need the ptrace permission (see below), and fail with `RpcCode.PtraceFailed` while
another debugger is attached.

## Test target

The C test target in `test-target/` provides a deterministic process for
integration tests. Build it before running tests:

```bash
cargo build --manifest-path ../starlightd/Cargo.toml
make -C test-target
pnpm test
```

## Linux: ptrace

The daemon (not Node) attaches to the game, so it is the daemon binary that
needs permission. If `attach()` throws `PermissionError`, either:

- set `kernel.yama.ptrace_scope=0` (`sudo sysctl kernel.yama.ptrace_scope=0`), or
- grant the daemon `cap_sys_ptrace` (`sudo setcap cap_sys_ptrace+ep /path/to/starlightd`).

At `ptrace_scope=0` no grant is needed. Tests spawn the target themselves.

## Running cheats

`verifyCheat(session, cheat)` checks a v2 cheat (`@starlight/ct-importer` types) against the live game and
returns `{ status: 'ok' | 'needs-update' | 'unverified', reasons }`. A cheat without a `verify` block is
`unverified`; with one, its AOB must match exactly once and every `verify` check must pass.

`enableCheat(session, cheat, { value?, intervalMs? })` verifies first (throws `NeedsUpdateError` on
`needs-update`), then runs the cheat and returns a `RunningCheat` (`setValue`, idempotent `disable`).
Value cheats freeze the value; patch cheats run their `enable` steps in order (`alloc`, `assemble`,
`writeBytes`, `registerSymbol`; `site` is predefined) and a failing step reverts the earlier patches.
Cheats with `disable` steps need the native table runner and are refused. Memory from `alloc` steps is not freed.
