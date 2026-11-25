# CE-compatible Lua runtime for native tables — design

Date: 2026-11-25. Status: draft for approval (player answered the builder-check questions).

## Intent

Cheat Engine tables (.CT) often carry Lua: a table-wide script that runs when the
table opens, `{$lua}` blocks inside Auto Assembler (AA) scripts, per-record Lua
scripts, and `luacall(...)` lines. Today any of that sends the whole table to
Cheat Engine (reason codes `lua:table-script`, `lua:block`, `lua:script`,
`aa:luacall`). Cheat Engine under Proton is the main source of failures (Patreon
nag, Wine prefixes, stale tables), so every table that runs on starlightd instead is
a table that works more reliably for the player.

Goal: run the Lua that tables actually use on starlightd, so more tables route to
the native engine.

Measured on the cached corpus (284 catalog tables, `scripts/ct-coverage.mjs`):
- 71/284 tables run natively today (v0.5.7); 158 have Lua.
- In 75 of them Lua is the only real blocker. The 10 most-used CE Lua functions
  would unlock ~40 of those; the top 40 functions ~61.
- Most-used functions: `openProcess` (28 tables), `showMessage`, `getMainForm`,
  `LaunchMonoDataCollector`, `getCEVersion`, `writeInteger`, `createMenuItem`,
  `readInteger`, `memrec.Color`, `registerSymbol`, `getAddressSafe`,
  `getAddressList`, `unregisterSymbol`, `getAutoAttachList`, `readFloat`, `sleep`,
  `speedhack_setSpeed`, `messageDialog`, `autoAssemble`.

## Goals

- Run CE Lua 5.3 code with CE's semantics for the parts tables rely on.
- Memory and address functions work for real against the attached game.
- CE user-interface calls (main form, menus, colours, timers on forms) do nothing
  instead of failing.
- `showMessage`/`messageDialog` text reaches the player as a notice; dialogs
  answer with their default (no blocking).
- Routing stays static and predictable: a table routes native only if every Lua
  function it calls is one the runtime supports. Otherwise it goes to CE, with a
  reason naming the unsupported function.
- Coverage is measured with `ct-coverage.mjs` before and after each milestone.

## Non-goals

- Mono/IL2CPP (`mono_*`) — a later layer on top of this runtime.
- CE's form designer, custom trainer UIs, `createForm`, `createTimer` callbacks
  that drive UI.
- Encrypted/obfuscated tables (`decodeFunction`, `loadstring` of blobs).
- 32-bit games.

## Anti-goals

- No Lua capability to reach the player's machine: no `io`, `os.execute`,
  `os.remove`, `require`, `package`, `loadlib`, `dofile`, `debug`. A table must
  not be able to touch files or run programs. `shellExecute` (open a link) is a
  notice with the link, never an automatic launch.
- Never let a table script hang a session or the daemon: every run has an
  instruction/time budget.
- Never change how a table that works with CE today behaves, except by routing it
  to native when everything it needs is supported.

## Constraints

- starlightd is Rust; each RPC request already runs on its own thread
  (`rpc.rs` `handle_line`), memory access is synchronous (process_vm_readv/ptrace).
- The symbol registry (table-registered names) lives in the desktop/engine TS side
  (`SymbolRegistry` in `native-backend.ts`); AA compilation lives in TS
  (`@starlight/ct-importer` `compileAaScript`).
- Routing happens before attach (`ct-runner.ts routeTable` → `compileTable`).
- CE uses one global Lua state per table: functions defined by the table script
  are called from record scripts and `{$lua}` blocks.
- A `{$lua}` block runs while CE processes the AA script; if it returns a string,
  that text replaces the block in the AA source. The global `syntaxcheck` is true
  during CE's syntax-check pass and false when it really runs.

## Approaches

1. **Lua inside starlightd (Rust, `mlua` with vendored Lua 5.3)** — chosen.
   Memory calls are local and synchronous, as CE Lua expects; the VM is sandboxed
   in-process; CE's exact Lua version. Cost: things only the app knows (registry,
   records) go in as a snapshot per run and come back as a list of effects.
2. **Lua in the desktop main process (Lua→WASM, e.g. wasmoon)** — rejected: every
   memory read becomes an async round trip to starlightd, which synchronous Lua
   can't await without coroutine plumbing; loops over `readInteger` become slow
   and fragile.
3. **Pure-JS Lua (fengari)** — rejected for the same sync/async reason.

The player picked approach 1.

## Design

### starlightd: Lua states

- New module `starlightd/src/lua/` using `mlua` (features `lua53`, `vendored`,
  `send`). One `LuaState` per Lua id, owned by the connection like scan/pointer
  sessions and freed on `lua_close`, detach or connection end.
- Sandbox: open only `base` (minus `dofile`, `loadfile`, `load` of binary
  chunks), `string`, `table`, `math`, `utf8`; `os` reduced to `clock`, `time`,
  `date`. No `io`, `package`, `debug`.
- Budget: an instruction-count hook aborts a run after a time limit (default
  2 s) and a memory limit on the state (e.g. 64 MiB). `sleep(ms)` counts against
  the time limit and is capped.
- RPC:
  - `lua_open { handle }` → `{ id }` — a state bound to an attached session.
  - `lua_run { id, chunk, name, syntaxcheck, symbols, memrec? }` →
    `{ ok, returned?: string, effects: Effect[], notices: Notice[] }` or
    `{ ok: false, error, line }`.
    `symbols` is the current registry snapshot (name → address). `memrec`
    describes the record the chunk belongs to (id, description, value text) for
    `memrec.*`.
  - `lua_close { id }`.
- Effects returned to the app, applied by it in order after the run:
  `registerSymbol {name, address}`, `unregisterSymbol {name}`,
  `setRecordActive {description|id, active}` (M2), `setSpeed {speed}` (M2).
  Within the run, `registerSymbol` also updates the run's own symbol view so a
  following `getAddress` sees it.
- Notices returned to the app: `{ kind: 'message'|'link', text }` from
  `showMessage`, `messageDialog`, `shellExecute`, `print`.

### CE API surface (milestone 1)

Real:
- Process: `openProcess(name)` (no-op that succeeds when the attached process's
  name matches, case-insensitive, else returns false), `getOpenedProcessID`,
  `process` global (exe name), `getCEVersion` (returns 7.5), `targetIs64Bit`.
- Memory (CE names, both `readX(addr)` forms, address = number or string
  expression): `readBytes`, `readSmallInteger`, `readInteger`, `readQword`,
  `readPointer`, `readFloat`, `readDouble`, `readString`, the matching `write*`,
  `writeBytes`.
- Addresses: `getAddress(expr)`, `getAddressSafe(expr)` (nil instead of error),
  `registerSymbol(name, addr)`, `unregisterSymbol(name)`, `getNameFromAddress`
  (module+offset form). Expressions use the same grammar as engine address
  expressions (module+offset, registry names, `[ ]` dereference).
- `aobScan(pattern)` / `AOBScan` (returns a stringlist-like object with
  `Count`, `[i]`/`getString(i)`, `destroy`), `aobScanModule(module, pattern)`.
- `sleep(ms)`, `getTickCount`, `print`, `showMessage`, `messageDialog` (returns
  the default answer — `mrYes` for yes/no), `shellExecute` (link notice).
- `syntaxcheck` global per run; `memrec` global for record chunks (`.ID`,
  `.Description`, `.Value` read-only in M1; `.Color` etc. ignored).

Inert (accept any call/index/assignment, return an inert object, never error):
`getMainForm`, `getAddressList` (M1; real in M2), `createMenuItem`,
`createForm`, `getAutoAttachList`, `createStringlist`/`stringlist_add` (a small
real list is fine), `LaunchMonoDataCollector`/`mono_initialize` (return 0 —
they only prepare CE's Mono helper), `waitForPDB`, `synchronize(f)` (calls `f`).

Unsupported in M1 (static check routes the table to CE): `autoAssemble`,
`createThread`, `createTimer` with a callback, `mono_*` beyond init, `loadstring`
/`load`, `decodeFunction`, `executeCode*`, `injectDLL`, `speedhack_*`
(M2 maps them to the session's game speed), anything not listed.

### Static support check (routing)

- `@starlight/ct-importer` gets a Lua call scanner (comments and strings removed,
  local function definitions excluded — the survey script in the analysis shows
  the shape) and the list of supported/inert names, exported from one place so
  the runtime and the router can't drift (a test asserts the Rust list and the TS
  list match, e.g. generated JSON checked into the repo).
- `compileTable`: Lua no longer blocks a table by itself. Each Lua chunk is
  checked; an unsupported function gives reason `lua:unsupported` with the
  function name as detail. Cosmetic Lua (existing `isCosmeticLua`) stays skipped.
- A table's Lua compiles into the compiled table:
  - table script → `compiled.tableLua` (run once after attach, before any record);
  - per-record `LuaScript` → record kind `lua` (run on enable; `[ENABLE]`/
    `[DISABLE]` sections when present, CE-style);
  - AA scripts containing `{$lua}` → record kind `script` with
    `script.deferred = { aa: source }` instead of a precompiled cheat (see below);
  - `luacall(x)` lines → kept as a `{$lua}` block equivalent.

### What counts as unsupported beyond function names (player's decision)

No table may silently lose a feature it has in CE. So besides unknown functions,
the static check also reports `lua:unsupported` for, until M2 supports them:
- a function or closure assigned to a UI object's event (`.OnClick`, `.OnChange`,
  `.OnTimer`, `OnShow`, … — any `.On<Name> =`): the logic behind a menu item or
  button would never run;
- address-list use beyond reading: `getAddressList()` / `AddressList` /
  `getMemoryRecordByDescription` / `getMemoryRecord*` together with writes to
  `.Active`, `.Value` or calls to `.setActive`/`doClick`; and `memrec.Active` /
  `memrec.Value` writes.
Purely cosmetic UI (menu items without handlers, captions, colours, `Visible`,
`memrec.Color`) stays inert and routes native.

### Symbols registered from Lua (builder call)

- A literal `registerSymbol("name", …)` in a table script or block counts as
  registered by that record (or by the table, for the table script) in
  `registeredBy`, so records using it don't become `sym:unresolved`.
- A name built at runtime isn't known statically: records that use it stay
  `sym:unresolved` and the table stays on CE.
- AA text returned by a `{$lua}` block is not inspected statically; the names it
  defines are only known at enable time. Records that depend on such names stay
  `sym:unresolved` (CE).

### Runtime failures (player's decision)

- The table script fails (error, budget exceeded, unsupported call reached at
  runtime) when the session attaches: the session moves to CE automatically using
  the existing native→CE switch (`ce-session.ts` `pick.switchToCe`, D17), with the
  Lua error in the log and the reason recorded like other routing reasons. Any
  writes the table script already made are not reverted (CE would have made them
  too).
- One record's Lua (record `LuaScript`, a `{$lua}` block in a deferred AA script,
  or the AA it returns failing to compile/assemble) fails when the player switches
  it on: that record shows the error, like AA errors today; the session stays
  native. Patches already applied by that record's enable are rolled back by the
  existing `enableCheat` rollback.

### Deferred AA scripts (`{$lua}` inside AA)

- At enable time the native backend (desktop) takes the AA source, runs each
  `{$lua}` block in order with `syntaxcheck=false` via `lua_run`, replaces the
  block with its returned string (or nothing), then runs `compileAaScript` on the
  result and enables the cheat as today. Disabling runs the `[DISABLE]` part the
  same way (blocks in `[DISABLE]` run on disable).
- The router's static check uses the AA text with `{$lua}` blocks removed for the
  AA part (so AA errors still route to CE), plus the Lua call check per block.
  The engine's preflight `checkAssembles` is skipped for deferred scripts (they
  can't be assembled without running Lua).

### Desktop wiring

- `native-backend.ts`: after attach, `lua_open`, run `tableLua`, apply effects,
  surface notices; record kinds `lua` and deferred scripts as above; close on
  shutdown / table reload. A Lua error turns into the record's error message
  ("line N: …") the same way AA errors do today.
- Notices show as the existing toast/notice in the game screen; links are shown
  with an Open button, never opened automatically.

### Milestones

- **M1 — runtime + routing:** starlightd Lua states and the M1 API, the static
  check, `tableLua` and record `LuaScript`, deferred AA with `{$lua}` blocks.
  Measure coverage; expected +25–40 tables.
- **M2 — address list + speed:** real `getAddressList()` /
  `getMemoryRecordByDescription` / `memrec.Active`/`.Value` via effects and a
  records snapshot, `speedhack_setSpeed/getSpeed` → session speed,
  `autoAssemble(text)` via an effect the app compiles and runs.
- **M3 (later, separate design):** Mono API on top of the runtime.

## Testing

- Rust unit tests per API function against the existing spawned test targets
  (`spawnTarget`), sandbox tests (no `io`, `os.execute`, budget abort).
- ct-importer tests for the call scanner and routing reasons.
- Engine/desktop tests for deferred AA (`{$lua}` returning code is assembled),
  table script running once, effects applied, notices surfaced.
- Coverage before/after with `ct-coverage.mjs --compiler native --assemble`; the
  coverage script runs the static check only (no game).
- The Lua survey used for the numbers above is checked in as
  `scripts/ct-lua-survey.mjs` (function usage per table, tables unlocked by the
  top-N functions) so the baseline can be re-measured.
- Live check against own test targets only (`scripts/live-*.mjs` pattern); never
  the player's running games.

## Left to the builder

- Exact `mlua` version/features, state ownership and locking in starlightd.
- The address-expression evaluator in Rust vs reusing the engine's TS one: Lua's
  `getAddress` needs it inside starlightd, so a Rust port of the engine's
  expression grammar (module+offset, registry names, brackets) is expected.
- Stringlist/inert-object implementation details.
- How notices are rendered (reuse existing toast components).
