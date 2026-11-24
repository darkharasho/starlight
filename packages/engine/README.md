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

`enableCheat(session, cheat, { value?, intervalMs?, symbols?, mainModule?, log? })` verifies first (throws
`NeedsUpdateError` on `needs-update`), then runs the cheat and returns a `RunningCheat` (`setValue`, idempotent
`disable`). Value cheats freeze the value; `freeze` also takes raw `bytes` (a Buffer or hex) for String and Array of
byte records. Memory from `alloc` steps is not freed.

## Running compiled tables

Cheat Engine tables compiled by `@starlight/ct-importer` (`compileAaScript`, `compileTable`) are v2 patch cheats, and
`enableCheat` runs them natively:

- **Symbols.** Pass one `SymbolRegistry` (`Map`, lowercase name → `0x…`) per session as `symbols`.
  `registerSymbol` steps export to it and `unregisterSymbol` removes names; `symbol` addresses
  (`{ expr: 'pPlayer+8', offsets: ['0x18', '-0x10'] }`) read `expr` through it (then module names) and walk
  `offsets` like a pointer chain. An unknown name is `symbol <name> isn't registered`. Every lookup is
  case-insensitive. `mainModule` is what AA's `$process` names.
- **Phases.** A: the `site`, `aobScan` steps (the site's match is reused for the same module and pattern; without
  a module the scan covers every executable region; no match is `ScanError('AOB <name> not found in …')`), `alloc`,
  and `registerSymbol` steps that need no label. B: every `assemble` step is laid out, with labels defined in later
  segments (`return:`) as placeholders until no label moves (at most 4 passes). C: the writes, in step order, as
  recorded patches. D: `registerSymbol` steps that name labels. A failure in any phase reverts the patches (newest
  first) and the registry entries the run added.
- **Disable** reverts every patch, newest first. The table's own `disable` bytes are only compared with what is now
  in the game; when they differ, `log` gets `disable bytes at <at> differ from the game's original; kept the
  original` and nothing is written. Then `unregisterSymbol` runs.
- **`checkAssembles(client, cheat, { known? })`** assembles a compiled cheat without a game (placeholder addresses
  for allocations, aob names, `known` table symbols and modules) and returns `{ ok: true }` or
  `{ ok: false, step, message }`. `scripts/ct-coverage.mjs --compiler native --assemble` counts its failures as
  `asm:error`.
- `aob_scan` without a module (protocol 3, capability `aob_exec`) skips the daemon's own hook and state pages.
