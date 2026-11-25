# Lua runtime M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the CE Lua that tables use (table script, `{$lua}` blocks, record Lua, `luacall`) on starlightd, so tables whose Lua is supported route to the native engine.

**Architecture:** starlightd hosts sandboxed Lua 5.3 states (mlua, vendored), one per session, with CE's memory/address/process functions implemented in Rust and CE UI calls inert. The desktop sends each chunk with a symbol snapshot and applies the returned effects/notices. Routing stays static: ct-importer scans Lua for calls and rules out what the runtime doesn't support, from one shared API list.

**Tech Stack:** Rust (mlua `lua53`+`vendored`+`send`, iced-x86 already present), TypeScript (ct-importer, engine, desktop main), vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-25-lua-runtime-design.md`

## Global Constraints

- Lua version: 5.3 (CE's). mlua features `lua53`, `vendored`, `send`.
- Sandbox: only `base` (no `dofile`, `loadfile`, no binary chunks in `load`), `string`, `table`, `math`, `utf8`; `os` only `clock`, `time`, `date`. No `io`, `package`, `require`, `debug`.
- Budget per `lua_run`: 2 s wall time (instruction hook), 64 MiB state memory; `sleep(ms)` counts against it.
- `shellExecute` never launches anything: it becomes a `link` notice.
- `messageDialog` returns the default answer (`mrYes` = 6 for yes/no dialogs, `mrOk` = 1 otherwise), never blocks.
- `getCEVersion()` returns `7.5`.
- New reason codes: `lua:unsupported` (detail = first unsupported function or rule) and `lua:runtime` (session fell back to CE at runtime). Existing `lua:*` codes stay in `REASON_CODES` for old routing counts.
- The supported/inert API list lives once, in `packages/ct-importer/src/lua-api.json`; Rust reads it with `include_str!`.
- vitest always with `--maxWorkers=2` (indexer also needs `--minWorkers=1`). Never attach to the player's games; live checks use own test targets only.
- Commit per task; do not push.

## Review Focus

- A table script that loops forever (`while true do end`) or calls `sleep(100000)`: the run aborts at the budget with an error; the daemon and other requests stay responsive. (Task 2 test `budget_aborts_infinite_loop`.)
- Lua given an address that doesn't resolve (`readInteger("nosuch+10")`, `readInteger(0)`): CE returns `nil` for reads and `false` for writes rather than raising; `getAddress` raises, `getAddressSafe` returns `nil`. (Task 3 tests.)
- A `{$lua}` block that returns a non-string (number, nil, table): nil/no return inserts nothing; any other non-string is an error naming the block line. (Task 6 test `expandLuaBlocks_return_types`.)
- A table script that redefines a global the API provides (`function showMessage() … end`, `readInteger = nil`): the table's definition wins for later chunks, as in CE (one state). (Task 2 test `globals_are_overridable`.)
- Effects from a failed run: when a chunk errors after `registerSymbol`, the effects so far are still returned with the error so the app keeps the registry consistent with what CE would have done. (Task 2/7 tests.)

---

### Task 1: Shared API list, Lua scanner and reason codes (ct-importer)

**Files:**
- Create: `packages/ct-importer/src/lua-api.json`, `packages/ct-importer/src/lua-scan.ts`, `packages/ct-importer/test/lua-scan.test.ts`, `scripts/ct-lua-survey.mjs`
- Modify: `packages/ct-importer/src/reasons.ts`, `packages/ct-importer/src/index.ts`, `packages/ct-importer/tsconfig.json` (`resolveJsonModule` if missing)

**Interfaces:**
- Produces: `lua-api.json` = `{ "real": string[], "inert": string[] }` (lowercase CE names; `real` = Task 3's functions, `inert` = Task 2's inert globals, see spec "CE API surface").
- Produces: `scanLua(code: string): { unsupported: string[]; registers: string[] }` — `unsupported` lists, in source order and deduplicated, each called global not in `real ∪ inert ∪ Lua std ∪ functions defined in the same code`, plus the rule names `ui-callback` (any `.On<Name> =` assignment) and `addresslist-write` (address-list access together with `.Active =`/`.Value =`/`setActive(`/`doClick(`, or `memrec.Active =`/`memrec.Value =`); `registers` = literal names from `registerSymbol("x", …)`.
- Produces: `REASON_CODES` gains `'lua:unsupported'`, `'lua:runtime'` with copy text.

- [ ] **Step 1: Write failing tests** in `lua-scan.test.ts`:
  - `scanLua('openProcess("game.exe")\nwriteInteger("pBase+10", 5)')` → `{ unsupported: [], registers: [] }`.
  - `scanLua('createThread(f)')`.unsupported equals `['createthread']`; locally defined `function helper() end helper()` is not reported; `string.format`, `math.floor`, `pairs` not reported; names inside strings/comments not reported.
  - `scanLua('local m = createMenuItem(x); m.OnClick = function() writeInteger("a",1) end')`.unsupported equals `['ui-callback']`; `m.Caption = "x"` alone → `[]`.
  - `scanLua('getAddressList().getMemoryRecordByDescription("God").Active = true')`.unsupported equals `['addresslist-write']`; `memrec.Color = 0xff` → `[]`.
  - `scanLua('registerSymbol("pPlayer", 0x1000)\nregisterSymbol(n, 1)')`.registers equals `['pplayer']`.
  - every name in `lua-api.json` is lowercase and appears once.
- [ ] **Step 2:** `cd packages/ct-importer && npx vitest run --maxWorkers=2 test/lua-scan.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `lua-api.json`, `scanLua` (reuse the comment/string stripping of `lua-cosmetic.ts`; extract it to a shared `stripLua` export), reason codes + copy (`lua:unsupported`: "A Lua script in this table uses something Starlight can't run yet."; `lua:runtime`: "This table's Lua failed on Starlight's engine, so it runs in Cheat Engine.").
- [ ] **Step 4:** tests PASS; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5:** Add `scripts/ct-lua-survey.mjs` (from `/tmp/sl-an/luafns.mjs` in the design session: per-table Lua calls, "Lua is the only blocker" count, tables unlocked by top-N). Commit `feat(ct-importer): Lua API list and call scanner`.

### Task 2: starlightd Lua states, sandbox, budget, RPC, inert API

**Files:**
- Create: `packages/starlightd/src/lua/mod.rs` (states, RPC handlers), `src/lua/sandbox.rs`, `src/lua/inert.rs`, `src/lua/notices.rs`, `tests/lua.rs`
- Modify: `packages/starlightd/Cargo.toml` (mlua), `src/rpc.rs` (`ConnState.luas`, dispatch, `is_slow` includes `lua_run`), `src/main.rs` (`mod lua`), capabilities list (`"lua"`)

**Interfaces:**
- Consumes: `Handles::get(handle) -> Arc<Target>` (`process.rs`).
- Produces RPC:
  - `lua_open { handle }` → `{ id: u32 }`; `lua_close { id }` → `{}`; states also drop on `detach` of their handle and on connection end.
  - `lua_run { id, chunk: string, name: string, syntaxcheck: bool, symbols: {name: "0xADDR"}, memrec?: { id, description, value } }` → `{ ok: true, returned: string|null, effects: Effect[], notices: Notice[] }` or `{ ok: false, error: string, line: number|null, effects, notices }` (a Lua error is a normal result, not an RPC error).
  - `Effect` = `{ op: "registerSymbol", name, address: "0x…" } | { op: "unregisterSymbol", name }`; `Notice` = `{ kind: "message"|"link", text }`.
- Produces Rust: `pub struct LuaCtx { target: Arc<Target>, symbols: HashMap<String,u64>, effects: Vec<Effect>, notices: Vec<Notice> }` reachable from API closures (set per run via `app_data`), used by Task 3.

- [ ] **Step 1: Write failing tests** in `tests/lua.rs` (pattern of `tests/memory.rs`: `Target::spawn`, `Daemon::start`, `attach`):
  - `run_returns_string`: `return "nop"` → `returned == "nop"`; `return 5` → `returned == null`… (non-string returns are passed as `null`; Task 6 decides errors).
  - `state_persists`: run `function f() return "x" end`, then `return f()` → `"x"`.
  - `globals_are_overridable`: run `function showMessage(t) shown = t end`, then `showMessage("a") return shown` → `"a"` and no notice.
  - `sandbox`: `io`, `os.execute`, `require`, `dofile`, `debug`, `package` are nil; `load("\27Lua…")` fails; `os.clock()` works.
  - `budget_aborts_infinite_loop`: `while true do end` → `ok:false`, error mentions the time limit, within 3 s; a following `read` RPC on the same connection answers.
  - `notices`: `showMessage("hi")`, `print("p")`, `shellExecute("https://x.y")` → notices `[message hi, message p, link https://x.y]`; `messageDialog("q", mtConfirmation, mbYes, mbNo) == mrYes` is true.
  - `inert`: `getMainForm().Menu.Items.add(createMenuItem(nil)); local x = getMainForm().Panel4; x.Visible = false; return tostring(getCEVersion())` → `"7.5"`; `LaunchMonoDataCollector()` returns 0.
  - `syntaxcheck_and_memrec`: `return tostring(syntaxcheck)` with `syntaxcheck:true` → `"true"`; with `memrec:{id:3,description:"God",value:"1"}`, `return memrec.Description` → `"God"`.
  - `errors_report_line`: chunk `"\n\nerror('boom')"` → `ok:false`, `line == 3`.
- [ ] **Step 2:** `cargo test --test lua` → FAIL.
- [ ] **Step 3: Implement.** mlua state with `set_memory_limit(64 MiB)`; instruction hook every 1000 instructions checks a deadline (2 s); `sleep(ms)` sleeps `min(ms, remaining)` then errors if the deadline passed. Inert objects: one userdata/table type whose `__index` returns another inert object, `__newindex` ignores, `__call` returns an inert object, `__tostring` = `""`; inert names come from `lua-api.json` `inert` (`include_str!("../../../ct-importer/src/lua-api.json")`), except those with special results (`getCEVersion` 7.5, `LaunchMonoDataCollector`/`mono_initialize` 0, `synchronize(f, …)` calls `f`, `createStringlist` a real list with `add`, `Count`, `[i]`, `getString`, `destroy`). Constants `mrYes=6, mrNo=7, mrOk=1, mrCancel=2, mbYes, mbNo, mbOK, mbCancel, mtConfirmation, mtInformation, mtWarning, mtError`. Per-run globals `syntaxcheck`, `memrec`, `process` (exe name from `/proc/<pid>/comm`, or the Proton exe if the Target knows it).
- [ ] **Step 4:** `cargo test --test lua` PASS; full `cargo test` (debug) PASS.
- [ ] **Step 5:** Commit `feat(starlightd): sandboxed Lua 5.3 states with CE's inert API`.

### Task 3: starlightd Lua memory, address and process API

**Files:**
- Create: `packages/starlightd/src/lua/addr.rs` (expression evaluator), `src/lua/api.rs` (real functions)
- Modify: `src/lua/mod.rs` (register), `tests/lua.rs`

**Interfaces:**
- Consumes: `LuaCtx` (Task 2), `mem::read_bytes/write_bytes`, `modules::list/find`, `aob::{Pattern::parse, scan, scan_exec, module_range}`.
- Produces: `pub fn eval_address(ctx: &LuaCtx, expr: &str) -> Result<u64, String>` — grammar: terms joined by `+`/`-`; a term is hex (`10`, `0x10`), `#dec`, a module name (quoted or not, `$process` = main module), a symbol from `ctx.symbols` (case-insensitive), or `[expr]` (8-byte read). Same rules as `packages/engine/src/cheats.ts` `evalExpr`/`resolveExpr`.
- Produces Lua functions (the `real` list of `lua-api.json`): `openProcess`, `getOpenedProcessID`, `targetIs64Bit`, `readBytes(addr, n, asTable?)`, `readSmallInteger`, `readInteger(addr, signed?)`, `readQword`, `readPointer`, `readFloat`, `readDouble`, `readString(addr, maxlen, wide?)`, `writeBytes(addr, …|table)`, `writeSmallInteger`, `writeInteger`, `writeQword`, `writePointer`, `writeFloat`, `writeDouble`, `writeString(addr, s, wide?)`, `getAddress`, `getAddressSafe`, `registerSymbol(name, addr|expr)`, `unregisterSymbol`, `getNameFromAddress`, `aobScan(pattern)`, `AOBScan`, `aobScanModule(module, pattern)`, `sleep`, `getTickCount`. Address args accept a Lua number or a string expression.

- [ ] **Step 1: Write failing tests** (spawned target, symbols from `t.addr(...)`):
  - `read_write_numbers`: `writeInteger(addr, 1234)` then `readInteger(addr)` → 1234; `readFloat`/`writeFloat` round-trip 1.5; `readInteger` of `-1` bytes is `4294967295`, with `signed=true` is `-1`; `readQword`, `readSmallInteger`, `readBytes(addr,4,true)` returns a table of 4 bytes.
  - `bad_addresses`: `readInteger(0)` → nil; `writeInteger(0,1)` → false; `getAddress("nosuch+10")` raises; `getAddressSafe("nosuch+10")` → nil.
  - `expressions`: with `symbols:{"pbase": addr}`, `getAddress("pBase+4") == addr+4`; `getAddress("[pBase]")` reads the pointer; `getAddress("target+10")` equals module base + 0x10; string address args work in `readInteger("pBase")`.
  - `register_effects`: `registerSymbol("foo", 0x1234)` then `return string.format("%x", getAddress("foo"))` → `"1234"` and effects `[registerSymbol foo 0x1234]`; `unregisterSymbol("foo")` emits its effect; effects survive a later `error()` in the same chunk.
  - `open_process`: `openProcess("<target exe name>")` → true; `openProcess("other.exe")` → false; `getOpenedProcessID()` equals the pid.
  - `aob`: `aobScan(<target's unique pattern>)` returns a list with `Count == 1` and `[0]` the hex address string (CE format, no `0x`); `aobScanModule("target", pattern)` same; no match → nil.
- [ ] **Step 2:** `cargo test --test lua` → new tests FAIL.
- [ ] **Step 3: Implement** `addr.rs` + `api.rs`; unit tests for `eval_address` parsing in `addr.rs`.
- [ ] **Step 4:** `cargo test` PASS; add test `api_list_matches`: every name in `lua-api.json` `real`/`inert` is a non-nil global in a fresh state.
- [ ] **Step 5:** Commit `feat(starlightd): CE Lua memory, address and process functions`.

### Task 4: Engine wrapper

**Files:**
- Create: `packages/engine/src/lua.ts`, `packages/engine/test/lua.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LuaEffect = { op: 'registerSymbol'; name: string; address: string } | { op: 'unregisterSymbol'; name: string };
  export interface LuaNotice { kind: 'message' | 'link'; text: string }
  export type LuaRunResult =
    | { ok: true; returned: string | null; effects: LuaEffect[]; notices: LuaNotice[] }
    | { ok: false; error: string; line: number | null; effects: LuaEffect[]; notices: LuaNotice[] };
  export interface LuaState { readonly id: number; run(chunk: string, o: { name: string; syntaxcheck?: boolean; symbols: SymbolRegistry; memrec?: { id: number; description: string; value: string } }): Promise<LuaRunResult>; close(): Promise<void> }
  export function luaOpen(s: Session): Promise<LuaState>;
  ```
  `symbols` is sent as an object of lowercase names → address strings.
- [ ] **Step 1:** Test (spawnTarget + startTestEngine like `aa-runner.test.ts`): open, run `registerSymbol("x", <g_counter addr>) return "ok"`, expect `returned "ok"` and the effect; run `return readInteger("x")` with `symbols` containing `x` → value equals `read(s, g_counter, 'int32')` as text; `close()` then `run` rejects with `EngineError`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (`s.client.call('lua_open'|'lua_run'|'lua_close', …)`). **Step 4:** PASS (`npx vitest run --maxWorkers=2 test/lua.test.ts`), `npm run build`. **Step 5:** Commit `feat(engine): Lua state wrapper`.

### Task 5: Lua blocks in AA sources (ct-importer)

**Files:**
- Create: `packages/ct-importer/src/lua-blocks.ts`, `packages/ct-importer/test/lua-blocks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LuaBlock { code: string; section: 'pre' | 'enable' | 'disable'; line: number }
  /** {$lua}…{$asm}/end blocks and luacall(x) lines, cosmetic blocks excluded. */
  export function luaBlocks(script: string): LuaBlock[];
  /** The script with every non-cosmetic Lua block (and luacall line) replaced by blank lines. */
  export function stripLuaBlocks(script: string): string;
  /** Runs the blocks of `sections` in order and splices each return into the source; other blocks are blanked. */
  export function expandLuaBlocks(script: string, sections: Array<LuaBlock['section']>, run: (b: LuaBlock) => Promise<string | null>): Promise<string>;
  ```
  Section = the `[ENABLE]`/`[DISABLE]` marker last seen before the block (markers inside a block's Lua count, as CE splits sections first).
- [ ] **Step 1: Tests:** `luaBlocks` of `'[ENABLE]\n{$lua}\nreturn "nop"\n{$asm}\n[DISABLE]\n{$lua}\nwriteInteger("a",0)\n{$asm}'` → two blocks with sections `enable`, `disable` and lines 2 and 6; `luacall(writeInteger("a",1))` on line 3 → block `{ code: 'writeInteger("a",1)', line: 3 }`; cosmetic blocks (`isCosmeticLua`) are not returned; `expandLuaBlocks(src, ['pre','enable'], run)` with `run` returning `"mov eax,1"` puts that text where the block was and leaves the disable block blank; `expandLuaBlocks_return_types`: `run` returning `null` inserts nothing.
- [ ] **Steps 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(ct-importer): split and expand {$lua} blocks`.

### Task 6: compileTable routes supported Lua native

**Files:**
- Modify: `packages/ct-importer/src/table-compiler.ts`, `packages/ct-importer/src/aa-compiler.ts` (accept stripped sources; `luacall` handled by Task 5), `packages/ct-importer/test/table-compiler.test.ts`, `packages/indexer/test/coverage.test.ts`, `scripts/ct-coverage.mjs`

**Interfaces:**
- Consumes: `scanLua` (Task 1), `luaBlocks`/`stripLuaBlocks` (Task 5), `isCosmeticLua`.
- Produces: `CompiledTable.tableLua: string | null`; `CompiledScript.deferred?: string` (the full AA source; `cheat` is `null` when set; `registers`/`uses` from compiling the stripped source plus `scanLua(...).registers`); new record kind `{ kind: 'lua'; lua: string }` for per-record `LuaScript`.
- Rules:
  - Table script: cosmetic → ignored; else `scanLua`: any `unsupported` → table reason `lua:unsupported` (detail = first entry); else `tableLua = code`, and its `registers` count as registered by `recordId` `-1` in `registeredBy` (`-1` = the table script).
  - Record `LuaScript`: same check → `kind: 'lua'` or `unsupported('lua:unsupported', …)`.
  - AA with Lua blocks: every block scanned; unsupported → `lua:unsupported`; else compile `stripLuaBlocks(aa)` (its failures keep their AA codes) and set `deferred`.
  - `lua:table-script`, `lua:block`, `lua:script`, `aa:luacall` are no longer produced.
- [ ] **Step 1: Tests:** table with table script `openProcess("x.exe")` + value record → `native: true`, `tableLua` set; table script `createThread(f)` → reasons `[lua:unsupported createthread]`; AA script with `{$lua}\nreturn "nop"\n{$asm}` inside `[ENABLE]` → record `kind:'script'`, `script.deferred` = source, `cheat: null`; same with `m.OnClick = function() end` → `lua:unsupported ui-callback`; table script `registerSymbol("pPlayer", 0)` makes a value record at `[pPlayer]+10` resolvable (no `sym:unresolved`); record `LuaScript` `writeInteger("a",1)` → `kind:'lua'`. Update the indexer coverage test expectations (`lua:block`/`lua:script` fixtures now `kind` lua/deferred; unsupported fixtures use `createThread`).
- [ ] **Steps 2–4:** FAIL → implement → PASS (ct-importer, indexer with `--minWorkers=1`).
- [ ] **Step 5:** `ct-coverage.mjs --assemble`: skip `checkAssembles` for `script.deferred` records (count them native). Commit `feat(ct-importer): route tables with supported Lua to the native engine`.

### Task 7: Native backend runs Lua

**Files:**
- Modify: `apps/desktop/src/main/native-backend.ts`, `apps/desktop/test/main/native-backend.test.ts` (or the existing native-backend test file)

**Interfaces:**
- Consumes: `luaOpen` / `LuaState` (Task 4), `expandLuaBlocks`, `compileAaScript`, `CompiledTable.tableLua`, record kind `lua`, `script.deferred`.
- Produces: `TableBackend` gains optional `start(): Promise<{ ok: true } | { ok: false; error: string }>` — opens the Lua state (lazily, only if the table has Lua) and runs `tableLua` with `syntaxcheck: false`, applying effects; `onEvent({ type: 'lua-notice', kind, text })` for every notice.
- Behaviour:
  - Effects apply to `registry` in order (`registerSymbol` sets lowercase name → address; `unregisterSymbol` deletes) — also when the run failed.
  - Record kind `lua`: enable runs its `[ENABLE]` part (whole code when there are no markers), disable runs its `[DISABLE]` part; `memrec` = `{ id, description: name, value: '' }`; a failed run is the record's error `"Lua line N: …"`.
  - Deferred script: enable = `expandLuaBlocks(src, ['pre','enable'], run)` → `compileAaScript` → `enableCheat` (compile failure → error with its code/detail); disable = `cheat.disable()` then run the `disable`-section blocks (errors logged, record still off).
  - Lua state closed on `shutdown` and on `load_table` (reopened lazily for the new table).
- [ ] **Step 1: Tests** with a fake engine (`deps.engine` injection, like existing native-backend tests): `start()` runs `tableLua` once and applies a `registerSymbol` effect so a value record using the name enables; a deferred script whose block returns `"jmp return"`-style AA compiles and calls `enableCheat` with the expanded source's cheat; a failing table script makes `start()` return `{ ok:false, error }`; notices are forwarded through `onEvent`; `lua` record error text contains the line.
- [ ] **Steps 2–4:** FAIL → implement → PASS (`cd apps/desktop && npx vitest run --maxWorkers=2 test/main/native-backend*`).
- [ ] **Step 5:** Commit `feat(desktop): run table Lua on the native backend`.

### Task 8: Session fallback and notices in the UI

**Files:**
- Modify: `apps/desktop/src/main/ce-session.ts`, `apps/desktop/src/main/index.ts` (onEvent → broadcast), `apps/desktop/src/shared/ipc.ts` (`StarlightEvent` `{ type: 'session:notice'; kind: 'message'|'link'; text: string }`), the game-screen toast component in `apps/desktop/src/renderer` (show message; link with an Open button that calls the existing open-external IPC), tests in `apps/desktop/test/main/ce-session*.test.ts`

**Interfaces:**
- Consumes: `TableBackend.start` (Task 7), `ROUTE_*`, `recordRoute`.
- Behaviour: `startNativeSession` calls `backend.start?.()` after creating the backend; on `{ ok:false }` it ends the native session (`endNative`) and the caller continues on the CE path for the same table (as when routing said CE), with route summary reason `lua:runtime` and a log line `[ct-runner] <label>: Lua failed on the native engine, using Cheat Engine: <error>`.
- [ ] **Step 1: Tests:** a session whose `createNativeBackendFn` returns a backend with `start` → `{ok:false}` ends native and starts CE (the CE start fn is called with the same ctPath); `start` → `{ok:true}` stays native; a `lua-notice` event is broadcast as `session:notice`.
- [ ] **Steps 2–4:** FAIL → implement → PASS; renderer: notice toast renders text, link shows "Open" button (component test if the renderer has them for toasts, else manual check in Task 9).
- [ ] **Step 5:** Commit `feat(desktop): fall back to Cheat Engine when table Lua fails; show Lua notices`.

### Task 9: Measure, live check, wrap-up

**Files:**
- Create: `scripts/live-lua.mjs` (own test target only, pattern of `scripts/live-m4.mjs`)
- Modify: memory note (outside repo), `docs/superpowers/coverage/` (add `lua-m1-before.json`/`lua-m1-after.json`)

- [ ] **Step 1:** Before/after coverage: `node scripts/ct-coverage.mjs --all --compiler native --assemble --json docs/superpowers/coverage/lua-m1-after.json` (before = run on the commit before Task 6). Record tables/records and the top `lua:unsupported` details.
- [ ] **Step 2:** `scripts/live-lua.mjs`: start the engine, spawn the test target, open a table built in-script with a table Lua script (`registerSymbol` + `writeInteger`), a deferred AA script whose `{$lua}` returns code, and a record Lua script; assert values change and disable restores them; assert a failing table script reports `ok:false`.
- [ ] **Step 3:** Full suites: `cargo test` (debug), ct-importer/engine/indexer vitest, desktop vitest `--maxWorkers=2` (the known better-sqlite3 ABI failure in `library-host.lutris.test.ts` is pre-existing). Desktop `npx tsc --noEmit -p .`.
- [ ] **Step 4:** Commit `chore: Lua runtime M1 coverage and live check`. Report numbers to the player; do not push.
