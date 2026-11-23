# Native Engine — Milestone 4 (Native `.CT` Runner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the common Auto Assembler subset of Cheat Engine tables on `starlightd`. An AA-subset compiler in `ct-importer` turns script records into v2 `patch` cheats. `ct-runner` routes a whole table to `starlightd` when every record compiles, and to CE otherwise, with reason codes that are logged and counted locally. The CE session becomes an engine-agnostic session with a CE backend and a native backend, behind the same pipeline and screen. Game speed in native sessions runs on `starlightd`. A coverage script measures how much of the catalog runs natively, before and after. The milestone also closes the items carried from M2 (abstime waits and the session-end clock jump under scaled time, assembler gaps) and M3 (the agent attach guard checks gids and refuses non-dumpable processes).

**Architecture:** `compileTable(xml)` (pure TypeScript, `@starlight/ct-importer`) produces a `CompiledTable`: one record per CT record (same ids and order as `listCtRecords`). Each record is a header, a value record with a v2 address, a script record with a v2 `patch` cheat, or `unsupported` with a reason code. `ct-runner` (Electron main) reads the table, compiles it, pre-assembles every script through the daemon's game-less `assemble`, and decides `native` or `ce`. `ce-session.ts` keeps its pipeline (table resolve, game match, anti-cheat, module wait, table picking, prerequisites, record tree, scanner, speed), but drives a `TableBackend`. The backend speaks the CE bridge's command protocol (`list_records`, `refresh`, `set_active`, `check_script`, `load_table`, `set_value`, `set_hotkeys`, `shutdown`), so `prepareTable`/`pickTable` stay as they are. The CE backend wraps the bridge and the CE process (Lua bridge, Wine/Proton launch). The native backend runs the compiled table on a `starlightd` session through `@starlight/engine`'s cheat runner, which M4 extends for compiled AA (forward labels, a table-wide symbol registry, `aobScan`/`unregisterSymbol` steps, `[DISABLE]` checks).

**Tech Stack:** TypeScript, Node 20, Electron 32, React + zustand, zod 3.25, vitest, fast-xml-parser (already a ct-importer dependency), Rust (`starlightd`, iced-x86), M3's `@starlight/engine` and `starlightd` (protocol 2, which becomes 3 here). Live checks use Proton 11.0 and `x86_64-w64-mingw32-gcc`, as in M2/M3.

**Spec:** `docs/superpowers/specs/2026-11-23-native-engine-agent-design.md`: milestone 4 of §11, covering §8 (AA subset, `ct-runner`, the engine-agnostic session, the coverage script), §6.4 (assembler), §6.5 (game speed), §6.6 (one engine per game), §7 (pure v2 extensions), §9 (safety) and §12 (coverage rises; speed restores bytes). The M1–M3 plans (`docs/superpowers/plans/2026-11-23-native-engine-m{1,2,3}-*.md`) define the daemon, the engine API, schema v2 and the game owner this plan builds on.

## Global Constraints

- **No anti-cheat evasion, no features aimed at hiding from detection, no multiplayer features.** Nothing in M4 adds network, packet or online-mode tooling.
- **Anti-cheat refusal stays enforced on every attach path**: the game page (CE and starlightd), `engine-host`, `scanner-host`, `user-cheats-host` and the agent's `attach`. The agent's `attach` checks before asking the player and again right before attaching. Modify-tier agent tools and enabling a user cheat check again first. A hit refuses with `antiCheatMessage(hit)`. There is no override.
- The **native table backend** is another attach path under the rule above: `startSession` checks before routing and again after the module wait (the existing `lateAntiCheat` check), for both backends.
- **The agent can only touch a game after the player approves the attach in the app.** Before approval, only `list_games` and `attach` run, and `attach` only asks.
- **No silent actions.** Every agent tool call is an activity entry. Stop (button and hotkey) cancels freezes, stops watches, reverts test cheats, restores speed hooks, ends scans and pointer scans, and detaches.
- **Agent-made cheats never use `absolute` addresses.** `save_cheat` validates the schema, requires `verify.range` for value cheats and an AOB `site` for `patch` cheats, and refuses a cheat that verify says needs updating on the running game.
- Schema v1 trainer files keep loading. v1 → v2 is a pure upgrade, and v1 cheats without verify data are never shown as "needs updating".
- **One engine per game** (spec §6.6). Starlight never closes a CE table without the player's confirmation (approval card or confirm bar). CE tables keep working for players who never use the agent or their own cheats.
- UI follows the established visual direction: the graphite-blue theme in `tailwind.config.ts`, Figtree, 13–14 px text, rounded panels and pills, `animate-rise` entrances. No near-black backgrounds, neon glows or tracked all-caps labels.
- Tests: vitest with at most 2 workers. Always pass `--maxWorkers=2`. Main-process tests start with `// @vitest-environment node`.
- Live checks only touch processes the task launches itself: the C test target, or a Windows test program under Proton with a **throwaway** `STEAM_COMPAT_DATA_PATH`. **Never a game the user is running** (the user plays games, including online ones, alongside dev work). The dev app runs with a temporary `XDG_CONFIG_HOME` and `--remote-debugging-port=9223`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No mixing within a table** (spec §8): a table runs on `starlightd` only when every record compiles. Otherwise the whole table runs on CE through the existing CE path. **No regressions:** CE-routed tables behave exactly as they do on `main` at fabc9a4.
- **No copying of Cheat Engine source.** CE is a behavioral reference only (AA semantics, record behavior).
- New runtime dependencies: none.
- **Per-task verification is targeted:** each task's test steps name the test files they run. A task may run `lint` (tsc) and `build` for the packages it changed, never `pnpm -r`. The full `pnpm -r build`, `pnpm -r lint`, `cargo test` and every suite run **once**, in Task 15, one after another, under `nice -n 19`. Cargo steps name their test target (`--test speed`, `--lib asm`).
- Live-check rules (binding): only processes the script launches; Proton only through `proton runinprefix` with a throwaway `STEAM_COMPAT_DATA_PATH` **and** `STEAM_COMPAT_CLIENT_INSTALL_PATH`; no visible GUI, so the app runs under `dbus-run-session` + `WLR_BACKENDS=headless cage -- …`; no `pkill`/`killall`, and never kill `wine`/`wineserver`/`proton` by name (only pids the script spawned, and only the throwaway prefix's own wineserver via `wineserver -k` with that prefix's `WINEPREFIX`).
- **Polite fetching** in the coverage script: at most one request every 2 s, the indexer's User-Agent, a local cache that is never refetched, and no retries beyond one.

## Review Focus

1. **A script uses a symbol that another record registers, and that record is off** (a prerequisite failed, or the player switched it off later). Expected: enabling refuses with `symbol pPlayer isn't registered; switch on "Activate" first`. Value records through that symbol show `??`. Nothing is written and nothing throws. The test is in Task 10 (`a script that needs another record's symbol says which record to switch on`).
2. **A native enable fails halfway.** For example, the second segment fails to assemble at its real address, or the second AOB isn't found. Expected: every patch made so far is reverted, the registry is unchanged, the record stays off, and the error text matches `isStaleTableError` for missing AOBs, so the picker's verdict logic works as with CE. The tests are in Task 9 (`a failing second segment rolls back the first and registers nothing`, `a missing aob is a ScanError whose message says not found`).
3. **The game exits, or the starlightd connection drops, during a native session.** Expected: the session ends like a CE session does (`session:game-exited`), records go off, table hotkeys are cleared, the `table` hold is released, and nothing throws. The test is in Task 12 (`game exit ends a native session and releases the table hold`).
4. **A table's `[DISABLE]` bytes differ from what the game had** (the table was made for another build). Expected: disabling restores the bytes recorded at enable time, never the table's bytes, and logs `disable bytes at INJECT differ from the game's original; kept the original`. The test is in Task 9 (`disable keeps the recorded original when the table's restore bytes differ`).
5. **The same record is toggled twice at once** (a hotkey press during a click, or key repeat). Expected: toggles of one record run one at a time, the final state matches the last request, and patches are never applied twice. The test is in Task 10 (`concurrent toggles of one record are serialized`).

---

## Decisions made while planning

| # | Decision | Reason |
|---|---|---|
| D1 | **Attach guard.** All four `Gid:` fields must equal `process.getgid()`, the same rule as the kernel's own `ptrace_may_access` same-gid check, which `cap_sys_ptrace` bypasses. The owner uid of `/proc/<pid>` must be the user's. The kernel makes a non-dumpable process's `/proc/<pid>` root-owned. Otherwise the guard refuses with the new `NOT_DUMPABLE`. | M3 review I5. Supplementary groups don't count, because the kernel doesn't count them either. |
| D2 | **Abstime waits (native games only).** New inline hooks translate an absolute **game-time** deadline into real time before calling the original: `clock_nanosleep` (only with `TIMER_ABSTIME`, for the clock ids `clock_gettime` scales: 0, 1, 4, 5, 6, 7), `pthread_cond_timedwait` (the cond's clock from `__wrefs` at offset `0x24`, mask `2` → MONOTONIC, else REALTIME), `pthread_cond_clockwait`, `sem_timedwait` (REALTIME) and `sem_clockwait`. They use a new shared routine, `unscale`, the inverse of `scale`. The guard is held only around the conversion, never across the blocking call, because 64 nesting entries can't cover every waiting thread. A slot that was never used (gen 0) passes the deadline through. Proton games are out of scope: Windows waits are relative, or absolute in system time, which isn't scaled. | M2 carry-over I5. Without it, a 2× game stalls (its deadline is in real time's future) and a 0.5× game busy-loops (its deadline is already past). |
| D3 | **Session-end landing.** Before the hooks are reverted, the daemon writes the speed sentinel `0.0` (with a gen bump). On their next read in landing mode, slots rebase toward real time: a slot that is ahead runs at `0.5` and is clamped with `max(real, ·)`, and one that is behind runs at `2.0` and is clamped with `min(real, ·)`. When the clamp first engages, the slot sets its bit in the new `OFF_LAND_MASK` (`0x20`, `u32`). The daemon polls every 10 ms until every used slot (gen ≠ 0) has landed, or for at most `LAND_MAX_MS = 2000`, then reverts. That closes up to 1 s ahead and 2 s behind. A larger gap steps once when the hooks come out. Landing is skipped when the target is gone. `unscale` inverts the clamped form: ahead `min(F⁻¹(g), g)`, behind `max(F⁻¹(g), g)`. | M2 I5. A bounded landing keeps detach/quit bounded. Most sessions end because the game exits, where nothing can jump. |
| D4 | **Assembler additions:** string instructions `movs/stos/lods/cmps/scas` + `b/w/d/q`, with `rep`/`repe`/`repne` where iced allows them; `rep ret`/`repz ret` (`F3 C3`); `cbw/cwde/cdqe/cwd/cdq/cqo`; `nop N` (N hex, N single-byte `90`s, as CE's templates write it). Operand-less `movsd`/`cmpsd` are the string forms; with operands they stay SSE. The existing displacement wrap and `lock` rules get pinning tests, and the out-of-range cases get errors. | M2 carry-over. CE's injection templates emit `nop N` and `rep ret`. |
| D5 | **Pure v2 extensions** (`schemaVersion` stays 2; V1 keeps its own address union): address kind `symbol { expr, offsets? }`; `PatchCheat.site` becomes optional; new steps `aobScan { name, module?, pattern }` (no `module` = executable memory, D10) and `unregisterSymbol { name }`; `disable` steps run (D8). `validateAgentCheat` rejects all four for agents, so agent cheats are unchanged. | The AA subset needs several scans per script, table-wide symbols and scripts without an AOB. Nothing that loads today changes meaning. |
| D6 | **AA → patch mapping:** see the reference section below. `define` is textual substitution. `label` only declares names. `dealloc` is dropped (allocations stay, M2 D9). `globalalloc(n,s[,near])` = `alloc` + `registerSymbol` (one extension beyond the spec's list; it is the same operation). | Spec §8 subset; `globalalloc` costs nothing extra. |
| D7 | **Forward labels across steps.** The runner lays out every `assemble` step first: labels any step defines (`definedLabels(source)`) start as placeholders at that step's `at`, and the steps are re-assembled with the current symbols until no label moves (at most 4 passes, else `EngineError('labels did not settle')`). Then it writes in **step order**. The compiler orders segments in allocated memory first and the jumps into them last, so the game never runs into an empty cave. M3 agent cheats, whose steps only reference earlier labels, get the same bytes. | AA's `newmem` code jumps to `return`, which is defined after `jmp newmem` at the site. |
| D8 | **Disable semantics.** Disable reverts every enable patch, newest first. Then each `disable` `writeBytes`/`assemble` is assembled and compared with the bytes now in the game: equal is fine; different → log `disable bytes at <at> differ from the game's original; kept the original`, and nothing is written. Then `unregisterSymbol` removes names from the registry. The compiler only accepts `[DISABLE]` writes whose origin equals an `[ENABLE]` origin (else `aa:disable-write`). | Recorded originals are exact (spec §6.2). Table restore bytes from another build would corrupt the game. |
| D9 | **2-argument `alloc` near:** the script's first `aobscanmodule`/`aobscan` name, else the first module-relative origin's expression, else no `near`. The 3rd argument, when given, wins. Size accepts `$hex`, `hex` and `#dec`. More than `0x10000` → `aa:alloc-size`. | The site's `jmp newmem` must reach the cave (rel32). |
| D10 | **`aobscan` without a module** scans executable regions in address order and takes the first match. The daemon's `aob_scan` gets `module` optional (absent = every `x` region outside the daemon's own hook/state pages). This is protocol 3, capability `aob_exec`. `aobscanmodule` takes the first match, like CE. Compiled CT cheats carry no `verify`, so M3's unverified rule applies. `$process` names the main module (the session's process name). | CE's AA `aobscan` covers code, including JIT code in anonymous memory. |
| D11 | **Table symbols and value addresses.** The native backend keeps one `SymbolRegistry` (`Map`, lowercase keys) per session. `registerSymbol` steps also export to it, and `uses` names are resolved from it (then module names). CT address strings compile as follows: `"m"+hex` / `m.exe+hex` → `module`; plain hex → `absolute`; `name[±hex]` → `symbol`; `[expr]±hex` nests → `symbol { expr, offsets }`, outer brackets last; a child's `+hex`/`-hex` is relative to the nearest ancestor with an address (folded into that address at compile time). CT `<Offsets>` are stored innermost-first in the XML, so they are **reversed** and appended after bracket offsets. | CE tables address values through registered symbols and parent-relative children. The offset order is CE's file format. |
| D12 | **Reason codes** (fixed set, `REASON_CODES` in `ct-importer`): `lua:table-script`, `lua:script`, `lua:block`, `aa:no-enable`, `aa:createthread`, `aa:loadlibrary`, `aa:readmem`, `aa:struct`, `aa:aobscanregion`, `aa:assert`, `aa:fullaccess`, `aa:include`, `aa:luacall`, `aa:reassemble`, `aa:loadbinary`, `aa:try`, `aa:c-code`, `aa:directive`, `aa:unknown-command`, `aa:alloc-size`, `aa:name`, `aa:disable-write`, `aa:pointer-origin`, `aa:parse`, `sym:unresolved`, `sym:mono`, `asm:error`, `value:type`, `addr:expression`, `table:empty`. Each has one line of player copy (`reasonCopy`). | Spec §8: "a specific reason code" per CE-only record, and countable. |
| D13 | **Table-level rules.** A table `<LuaScript>` that is non-empty after `--` comments are stripped → `lua:table-script` (the whole table goes to CE). A table with no non-header records → `table:empty` → CE (nothing to gain, and it keeps today's path for odd files). | Spec §3: tables that rely on Lua go to CE. |
| D14 | **Routing pre-assembles.** `ct-runner` checks every compiled script with `checkAssembles` through the daemon's game-less `assemble`, using placeholder addresses (defined in Task 9). A failure → `asm:error` with the daemon's message. When the daemon can't be reached, the route is `ce` (`detail: 'engine unavailable'`). | Instruction gaps must route to CE, not fail at enable time. |
| D15 | **Backend = the bridge protocol.** `TableBackend { kind; send(cmd); close() }`. The CE backend is the bridge plus the CE process (and the `toWinePath` of `load_table`). The native backend answers the same methods in process. Module, IPC and component names (`ce-session.ts`, `ceSession*`, `CeSessionView`, `useCeSessionStore`) stay. | It is the smallest change that keeps `prepareTable`/`pickTable` and 58 session tests as they are. Renaming touches dozens of files and changes no behavior. |
| D16 | **Session modes:** `mode: 'ce' \| 'native' \| 'paused'` (`paused` is M3's starlightd mode). `engine` stays in IPC as `mode === 'ce' ? 'ce' : 'starlightd'`. A native session holds the new holder `'table'`. Agent and user-cheat claims on a native game don't release anything (same engine). A CE-routed table on a game with holders opens paused, as in M3. A native-routed table opens native even with holders. | One engine per game (spec §6.6) without pausing native tables for starlightd users. |
| D17 | **Table picking across routes.** The queue order is unchanged. The first candidate's route picks the first backend. A later candidate that routes `ce` switches native → CE once (CE launches). After that the session stays on CE for the rest of the pick: CE runs any table, logged as `ce` with `detail: 'cheat engine already running'`. Routes are computed lazily per candidate, when the candidate is downloaded. | It keeps today's preference order and launches CE at most once per pick. |
| D18 | **Speed in native sessions** goes through `scanner-host` `speed_set` (its handle), as paused mode does since M3 D18. CE mode keeps CE's speedhack (M2 D24). Tasks 3–4 land before native sessions exist. | Spec §8 and the M2 carry-over ("before any speed UI moves to starlightd"). |
| D19 | **Hotkeys in native sessions.** The table's own hotkeys (CT `Hotkeys`: Toggle Activation, Activate, Deactivate, Set Value, Increase Value, Decrease Value) plus the renderer's `set_hotkeys` bindings (VK codes) register in a new hotkey-host slot, `setSessionHotkeys`. Records listed in `replace` drop their table toggle. A press posts the same `{ type: 'hotkey', id, ok, active, error }` event the CE bridge does. | The renderer contract is unchanged. CE handled table hotkeys itself, so starlightd must too. |
| D20 | **Routing log and counts.** Every route is logged: `[ct-runner] <cacheKey>#<tableId>: native (N records)` or `… : ce (aa:createthread ×3, lua:block ×1)`. It is counted once per table sha256 in `<userData>/ct-routing.json`: `{ version: 1, tables: { native, ce }, records: { native, ce }, reasons: Record<code, number /* tables */>, seen: string[] /* ≤ 2000 shas, FIFO */ }`. | Spec §8: "logged and counted locally". |
| D21 | **Coverage corpus.** The catalog is `packages/catalog/index.json` (7,746 games with a `trainerSource` thread URL). The `.CT` files are not local: `~/.config/@starlight/desktop/ct-cache` holds 14. The recorded numbers use a **deterministic sample of 400 games** (sorted by sha256 of the catalog id), one table each (the thread's newest `.CT`, the same pick as the indexer's `fetchTrainer`), cached in `~/.cache/starlight/ct-coverage/`. `--all` runs over the whole catalog. Baseline metric (before the compiler): a record is native when the M3 importer converts it to a value cheat. After: `compileTable` + `checkAssembles`. Same corpus files both times. | 7,746 thread pages plus attachments is about 6 h of polite fetching from a volunteer forum. 400 games give the trend within a few points, and `--all` stays available. |
| D22 | **Kill switch:** `preferences.nativeTables` (default `true`), a Settings toggle "Run tables on Starlight's engine when possible". Off → every table routes `ce` with `detail: 'turned off in Settings'`. | It guards the spec's no-regressions anti-goal while native coverage is new. |
| D23 | **Value records, native.** Active = frozen at the value read when switched on (CE's semantics); `set_value` writes, and updates the freeze when active. Display: decimal, uppercase hex without prefix when `ShowAsHex="1"`, signed bytes when `ShowAsSigned="1"`, `??` when unreadable, `Array of byte` as spaced hex. Dropdowns come from `<DropDownList>` (`value:label` lines) or `<DropDownListLink>` (another record's list, by description). | It mirrors what `describe`/`recValue` return from CE today. |

---

## AA → v2 `patch` mapping (shared reference for Tasks 6–10)

| AA statement | Compiles to | Notes |
|---|---|---|
| `[ENABLE]` / `[DISABLE]` | `enable` / `disable` | Case-insensitive. No `[ENABLE]` → `aa:no-enable`. |
| `define(name, text)` | — | Whole-word, case-insensitive substitution in later lines (CE semantics). |
| `aobscanmodule(n, mod, aob)` | `aobScan { name: n, module: mod, pattern }` | The first one also becomes `site`; the runner reuses the site's match for it. `mod` may be quoted, or `$process`. |
| `aobscan(n, aob)` | `aobScan { name: n, pattern }` | Executable memory (D10). |
| `alloc(n, size[, near])` | `alloc { name: n, size, near? }` | D9. |
| `globalalloc(n, size[, near])` | `alloc` + `registerSymbol { name: n, at: n }` | D6. |
| `label(a, b, …)` | — | Declares in-segment labels. |
| `registersymbol(a, …)` | `registerSymbol { name: a, at: a }` | Emitted last in `enable` (after layout); also exported to the session registry. |
| `unregistersymbol(a, …)` | `unregisterSymbol { name: a }` | In `[DISABLE]`. Ignored in `[ENABLE]`. |
| `dealloc(n[, size])` | — | Allocations stay (M2 D9). |
| `origin:` (alloc / aob / registered / define name, `name±hex`, `"m"+hex`, `m.exe+hex`, `0x…`/hex) | starts an `assemble { at: origin, source }` | Lines until the next origin. Declared labels (`return:`, `code:`) stay inside the source. `[…]:` → `aa:pointer-origin`. Code before any origin → `aa:parse`. |
| instructions, `db`/`dw`/`dd`/`dq`, `jmp`/`call` labels | source lines of the current segment | Trimmed, comments removed, joined with `\n`. |
| `[DISABLE]` `origin:` + `db` bytes | `writeBytes { at, bytes }` | `db` with `??` → `aa:parse`. The origin must equal an `[ENABLE]` origin (D8). |
| `[DISABLE]` `origin:` + instructions | `assemble { at, source }` | Checked, never written (D8). |
| `{$lua}` … `{$asm}` | — | `lua:block`. `{$asm}` alone is ignored, as is `{$strict}`. `{$try}`/`{$except}` → `aa:try`; `{$c}`/`{$ccode}` → `aa:c-code`; any other `{$…}` → `aa:directive`. |
| `createthread`, `createthreadandwait`, `loadlibrary`, `readmem`, `struct`/`endstruct`, `aobscanregion`, `assert`, `fullaccess`, `include`, `luacall`, `reassemble`, `loadbinary` | — | `aa:<command>` (`createthreadandwait` → `aa:createthread`, `endstruct` → `aa:struct`). Any other `word(…)` statement → `aa:unknown-command`. |

Step order in `enable`: `aobScan` steps, `alloc` steps, `assemble` steps whose origin's base name is an alloc name (in source order), the other `assemble` steps (in source order), then `registerSymbol` steps. Names must match `Ident` (`/^[A-Za-z_][A-Za-z0-9_]*$/`), else `aa:name`. A name the script uses that it doesn't define (not alloc/label/aob/define, not a module `*.exe|*.dll|*.so*`, not a register or mnemonic) goes in `uses`. `compileTable` turns a `uses` name that no record registers into `sym:unresolved`, or `sym:mono` when it contains `:`.

---

## File Structure

**`packages/starlightd/`**
- `src/speed/templates.rs` (`unscale`, `wait_hook_source`, landing in `scale`/`scale32`, `OFF_UNSCALE`, `OFF_LAND_MASK`), `src/speed/targets.rs` (wait targets), `src/speed/mod.rs` (`Kind` variants, landing in `teardown`), `src/symbols.rs` (`Export.default_version`)
- `src/asm/parse.rs`, `src/asm/encode.rs`, `src/asm/mod.rs` (D4 + doc comment)
- `src/aob.rs`, `src/rpc.rs` (`aob_scan` without module, `PROTOCOL = 3`, capability `aob_exec`)
- `tests/speed.rs`, `tests/scan.rs`; `../engine/test-target/target.c` (`--abs-sleep`, `--abs-cond`, `--abs-cond-rt`, `--abs-sem`)

**`packages/ct-importer/`**
- `src/starlight-format.ts` (D5), `src/agent-cheat.ts` (rejects the extensions)
- `src/reasons.ts` (new: `REASON_CODES`, `ReasonCode`, `reasonCopy`)
- `src/aa-compiler.ts` (new: `compileAaScript`)
- `src/table-compiler.ts` (new: `compileTable`, `CompiledTable`, `CompiledRecord`), `src/ct-address.ts` (new: `parseCtAddress`), `src/hotkey-parser.ts` (`vkKeysToAccelerator`, letters/numpad), `src/index.ts`
- `test/aa-compiler.test.ts`, `test/table-compiler.test.ts`, `test/ct-address.test.ts`, `test/fixtures/aa/*.cea` + `test/fixtures/tables/*.CT` (new), `test/starlight-format.test.ts`, `test/agent-cheat.test.ts`, `test/hotkey-parser.test.ts`

**`packages/engine/`**: `src/cheats.ts` (registry, forward labels, new steps, disable, `symbol` addresses, `checkAssembles`, `definedLabels`), `src/aob-scan.ts` + `src/types.ts` (`module?`), `src/client.ts` (`PROTOCOL_VERSION = 3`), `src/index.ts`, `README.md`; `test/aa-runner.test.ts` (new), `test/cheats.test.ts`

**`packages/indexer/`**: `src/coverage.ts` (new: `measureTable`, `summarize`, `baselineCompile`), `test/coverage.test.ts` (new)

**`scripts/`**: `ct-coverage.mjs` (new), `live-m4.mjs` (new). **`docs/superpowers/coverage/`**: `m4-baseline.json`, `m4-after.json` (new, committed results)

**`packages/engine/test-target/`**: `win/gold.c` unchanged (the live script writes the CTs at run time from the built binaries)

**`apps/desktop/src/main/`**
- `agent/target-guard.ts`
- `table-backend.ts` (new: `TableBackend`, `BackendCommand`), `ce-backend.ts` (new: `launchCeBackend`, moved from `ce-session.ts`), `native-backend.ts` (new), `ct-runner.ts` (new)
- `ce-session.ts`, `game-owner.ts` (`'table'` holder), `hotkey-host.ts` (`setSessionHotkeys`), `user-config.ts`, `index.ts`
- `../shared/ipc.ts`, `../preload/index.ts` (types only)

**`apps/desktop/src/renderer/`**: `stores/ce-session-store.ts`, `components/ce/CeSessionView.tsx`, `routes/SettingsRoute.tsx`

**`apps/desktop/test/`**: `main/agent/target-guard.test.ts`, `main/native-backend.test.ts`, `main/ct-runner.test.ts`, `main/hotkey-host.session.test.ts`, `main/ce-session.test.ts`, `main/game-owner.test.ts` (new where missing), `components/CeSessionView.test.tsx`, `stores/ce-session-store.test.ts`

---

### Task 1: Agent attach guard checks gids and refuses non-dumpable processes

**Files:**
- Modify: `apps/desktop/src/main/agent/target-guard.ts`, `apps/desktop/test/main/agent/target-guard.test.ts`

**Interfaces:**
- Produces:
  - `export const NOT_DUMPABLE = "That process doesn't allow debugging (it isn't dumpable), so Starlight won't attach to it."`
  - `TargetGuardDeps` gains `gid: number` and `procOwner(pid: number): Promise<{ uid: number }>` (the owner of `/proc/<pid>`, from `stat`).
  - `checkAttachTarget` order: self/daemon → read status/stat (failure → `GONE`) → uids (`NOT_YOURS`) → **gids: all four `Gid:` fields `=== deps.gid`, else `NOT_YOURS`; a missing `Gid:` line → `NOT_YOURS`** → **`procOwner(pid).uid !== deps.uid` → `NOT_DUMPABLE` (`procOwner` failing → `GONE`)** → session/ancestor checks as today.
  - `procTargetDeps` fills `gid: process.getgid?.() ?? -1` and `procOwner: (pid) => stat('/proc/' + pid).then((s) => ({ uid: s.uid }))`.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses a process whose effective gid differs (setgid program)', ...)   // Gid: 1000 1001 1001 1001, uid all 1000 → NOT_YOURS
it('refuses a process whose saved or filesystem gid differs', ...)          // Gid: 1000 1000 0 1000 → NOT_YOURS; 1000 1000 1000 5 → NOT_YOURS
it('refuses when the status has no Gid line', ...)
it('refuses a non-dumpable process (/proc/<pid> owned by root)', ...)       // procOwner → { uid: 0 } → NOT_DUMPABLE
it('refuses when /proc/<pid> is owned by another user', ...)                // { uid: 1001 } → NOT_DUMPABLE
it('a process that vanishes before the owner check is GONE', ...)
it('allows a same-user, same-gid, dumpable game', ...)                       // → null
```
The existing guard tests keep passing. Their fake deps gain `gid: 1000` and `procOwner: async () => ({ uid: 1000 })`.

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 target-guard`
Expected: FAIL (the new cases return `null`).

- [ ] **Step 3: Implement** per the Interfaces block. Parse `Gid:` the way `uids` parses `Uid:`.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 target-guard tools-session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/target-guard.ts apps/desktop/test/main/agent/target-guard.test.ts
git commit -m "fix(desktop): agent attach guard requires matching gids and refuses non-dumpable processes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Coverage script and the baseline measurement

**Files:**
- Create: `packages/indexer/src/coverage.ts`, `packages/indexer/test/coverage.test.ts`, `scripts/ct-coverage.mjs`, `docs/superpowers/coverage/m4-baseline.json`
- Modify: `packages/indexer/src/index.ts` only if the build needs the module exported (keep the bin's behavior)

**Interfaces:**
- Consumes: `importCt`, `listCtRecords`, `parseCt` (`@starlight/ct-importer`); `fetchTrainer` (indexer `fetch.ts`).
- Produces (`packages/indexer/src/coverage.ts`):
  - `type Compiler = 'baseline' | 'native'` (`'native'` arrives in Task 8; until then it throws `Error('native compiler not built yet')`).
  - `interface TableCoverage { id: string; records: number; nativeRecords: number; native: boolean; codes: Record<string, number> /* per record */; tableCodes: string[] }`
  - `baselineCompile(xml: string): { records: Array<{ id: number; native: boolean; code: string | null }>; tableCodes: string[] }`. Records are `listCtRecords` entries minus headers without a script. A record is native when `importCt` converts its entry to a value cheat (match on the `cheat-<ID>` id). Unsupported reasons map to codes: Lua text → `lua:script`, assembler text → `aa:script` (baseline-only code), missing type/address → `value:type`, address expression → `addr:expression`. No records → `table:empty`.
  - `measureTable(id: string, xml: string, compiler: Compiler): TableCoverage`. `native` = at least one record, every record native, and no table codes.
  - `interface CoverageReport { compiler: Compiler; generatedAt: string; tables: { total: number; native: number; pct: number }; records: { total: number; native: number; pct: number }; byCode: Array<{ code: string; tables: number; records: number }> /* tables desc */; failed: number }` and `summarize(rows: TableCoverage[], failed: number, compiler: Compiler): CoverageReport`. `pct` has one decimal. `byCode.tables` counts tables where the code appears at least once.
- `scripts/ct-coverage.mjs [--sample 400 | --all] [--fetch] [--compiler baseline|native] [--assemble] [--json <file>] [--corpus <dir>]`:
  - Corpus dir default `~/.cache/starlight/ct-coverage/`: `<catalogId>.ct` plus `manifest.json` (`{ id, source, sha256, fetchedAt } | { id, source, error }` per game).
  - Selection: `packages/catalog/index.json` games with a `trainerSource`, sorted by `sha256(id)` hex, first `--sample` (default 400).
  - `--fetch` downloads only what is missing, through the built indexer's `fetchTrainer`, ≥ 2000 ms between requests (both requests of a thread count), one retry. Failures go in the manifest and count as `failed`, never in the percentages.
  - Without `--fetch` it measures whatever is cached and prints how many are missing.
  - `--assemble` (Task 8+) starts the debug `starlightd` (`packages/starlightd/target/debug/starlightd`) and runs `checkAssembles` on each native-candidate table.
  - It prints the report (tables %, records %, top 15 codes) and writes `--json`.

- [ ] **Step 1: Write the failing tests** (`coverage.test.ts`, inline CT strings)

```ts
it('baseline: a table of plain value records is native', ...)                 // 2 records "target"+4030 4 Bytes → native true, nativeRecords 2
it('baseline: an AA script record makes the table CE with aa:script', ...)     // codes { 'aa:script': 1 }, native false
it('baseline: a Lua record counts as lua:script', ...)
it('baseline: header-only tables are table:empty', ...)
it('headers without scripts are not records', ...)                             // header + 1 value → records 1
it('summarize computes percentages and ranks codes by tables', ...)            // 3 tables, 1 native → pct 33.3; byCode[0].code === 'aa:script'
it('failed fetches are reported but not counted', ...)
it('native compiler is not available before Task 8', ...)                      // throws 'native compiler not built yet'
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter @starlight/indexer test -- --pool=forks --poolOptions.forks.maxForks=2 coverage`
Expected: FAIL (no `coverage.ts`). (The indexer uses `--pool=forks` with 2 forks because of a pre-existing `minThreads` conflict with `--maxWorkers`, per the M3 ruling. It is the same 2-worker cap.)

- [ ] **Step 3: Implement** `coverage.ts` per the Interfaces block, then the script.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter @starlight/indexer test -- --pool=forks --poolOptions.forks.maxForks=2 coverage && pnpm --filter @starlight/indexer build`
Expected: PASS.

- [ ] **Step 5: Fetch the corpus and record the baseline**

Run (in the background, about 30 min): `nice -n 19 node scripts/ct-coverage.mjs --sample 400 --fetch --compiler baseline --json docs/superpowers/coverage/m4-baseline.json`
Expected: a report with `tables.total + failed = 400`, at least 300 tables measured, and the JSON written. Record the two headline numbers (tables %, records %) and the top 5 codes in the commit message body.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/src/coverage.ts packages/indexer/test/coverage.test.ts scripts/ct-coverage.mjs docs/superpowers/coverage/m4-baseline.json
git commit -m "feat(indexer): .CT coverage script and the M4 baseline

Baseline (400-game sample): tables <T>% native, records <R>% native.
Top codes: <…>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: starlightd speed: absolute-time waits under scaled time (native)

**Files:**
- Modify: `packages/starlightd/src/speed/templates.rs`, `src/speed/targets.rs`, `src/speed/mod.rs`, `src/symbols.rs`, `packages/engine/test-target/target.c`, `packages/starlightd/tests/speed.rs`

**Interfaces:**
- Produces:
  - `templates::OFF_UNSCALE = OFF_CODE + 4 * ROUTINE_MAX` (`0x1800`). `shared_routines` returns 5 routines.
  - `unscale(rcx = key, rdx = slot, r8 = game, r9 = real now) -> rax = real`, with the same lock/seqlock/timeout rules as `scale`. When the slot's gen differs from the global gen, it first rebases exactly as `scale` would at `r9`. Result: `real0 + (game − fake0) / speed`, clamped to ≥ 0. A gen-0 slot returns `game` unchanged. Task 4 adds the landing inverse.
  - `Kind::{ClockNanosleep, CondTimedwait, CondClockwait, SemTimedwait, SemClockwait}`, wire names `clock_nanosleep`, `cond_timedwait`, `cond_clockwait`, `sem_timedwait`, `sem_clockwait`. `last_slot` → base + 7 (clock-indexed).
  - `templates::wait_hook_source(kind: Kind, state: u64, slot_base: u32, trampoline: u64) -> String`. SysV only. Shape: save → read the clock id (fixed REALTIME for `sem_timedwait`; `[rdi+0x24] & 2` for `cond_timedwait`; the argument for the others) → skip unless the id is in {0,1,4,5,6,7}, the deadline pointer is non-null, and (for `clock_nanosleep`) `flags & 1` → read the real time of that clock into `r9` by calling `__vdso_clock_gettime` (the daemon finds it in `[vdso]` as `GettimeofdayGot` does and stores its address after the code as `h_vdso_clock`; the hooked libc `clock_gettime` would return game time) → `guard_enter` → if outermost: copy `*abstime` to a 16-byte stack local, convert to ns, `unscale`, split back → `guard_leave` → swap the deadline argument for the local → call the trampoline → restore → `ret`. Not outermost, or not entered: pass through unchanged.
  - `pub const COND_FLAGS_OFFSET: u64 = 0x24; pub const COND_CLOCK_MONOTONIC_MASK: u32 = 2;` Verify both against the system glibc's `struct __pthread_cond_s` (2.44 here) before relying on them; the `--abs-cond` test fails if they are wrong.
  - `symbols::Export.default_version: bool`, from `.gnu.version` (hidden bit `0x8000` clear, or no versym table). `targets::find` only takes default-version exports.
  - `targets::native` appends the five wait targets from the same libc. A missing export is left out. Under musl, `cond_timedwait` is skipped with reason `"musl condvar clock unknown"`.
  - `target.c`: `--abs-sleep`, `--abs-cond` (condattr MONOTONIC), `--abs-cond-rt` (default clock), `--abs-sem`, and `--abs-cond-threads <n>` (n extra `--abs-cond` threads sharing `g_abs_conds`). Each is a thread that loops "deadline = now(clock via libc clock_gettime) + 20 ms; wait until deadline; counter++" and prints `addr g_abs_sleeps=0x…` (and `g_abs_conds`, `g_abs_conds_rt`, `g_abs_sems`).

- [ ] **Step 1: Write the failing tests** (`tests/speed.rs`, serial, against `target`)

```rust
#[test] fn abstime_sleep_follows_game_speed() { … }
// target --abs-sleep --clocks; rates of g_abs_sleeps at 1.0 / 2.0 / 0.5: 50 ±25%, 100 ±25%, 25 ±25% per s.
// Today 2.0 stalls (rate < 10) and 0.5 busy-loops (rate > 1000).
#[test] fn abstime_cond_wait_monotonic_follows_game_speed() { … }   // --abs-cond, same bounds
#[test] fn abstime_cond_wait_realtime_follows_game_speed() { … }    // --abs-cond-rt
#[test] fn abstime_sem_wait_follows_game_speed() { … }              // --abs-sem
#[test] fn relative_sleeps_are_untouched() { … }                    // --writer (usleep 50 ms): g_counter rate ≈ 20/s at 2.0
#[test] fn wait_hooks_are_listed_and_restored_on_detach() { … }     // speed_set reports hooks clock_nanosleep … status "hooked"; detach → entry bytes original
#[test] fn many_waiting_threads_do_not_exhaust_the_nesting_table() { … } // target --abs-cond ×80 threads (new flag --abs-cond-threads 80) + --clocks: clock rate still 2.0 ±15%
```
Unit tests in `templates.rs`: `unscale_inverts_scale_for_every_slot_kind` (an assembled routine run in a test thread, as M2's template tests do), `wait_hook_assembles_for_each_kind`.

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cargo test --manifest-path packages/starlightd/Cargo.toml --test speed abstime`
Expected: FAIL (no wait hooks; 2.0 stalls).

- [ ] **Step 3: Implement** per the Interfaces block and D2. The register save list and stack alignment follow `hook_source`'s comment. The wait hooks never hold a nesting entry across the call.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --test speed && cargo test --manifest-path packages/starlightd/Cargo.toml --lib speed`
Expected: PASS, including every M2 speed test.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target/target.c
git commit -m "fix(starlightd): absolute-time waits follow game speed on native games

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: starlightd speed: the clock lands on real time before hooks come out

**Files:**
- Modify: `packages/starlightd/src/speed/templates.rs`, `src/speed/mod.rs`, `packages/starlightd/tests/speed.rs`

**Interfaces:**
- Produces:
  - `templates::OFF_LAND_MASK = 0x20` (`u32`, bit per slot, set with `lock or`). `pub const LANDING: f64 = 0.0` (the global speed sentinel). `LAND_SLOW = 0.5`, `LAND_FAST = 2.0`.
  - `scale`/`scale32`: on a rebase to `LANDING`, the slot's speed becomes `LAND_SLOW` if `fake_now > real`, else `LAND_FAST`. While the global speed is `LANDING`, the result is clamped toward real (`max` for slow, `min` for fast), and the slot's land bit is set the first time the clamp engages. `unscale` inverts the clamp (D3).
  - `speed::LAND_MAX_MS: u64 = 2000`, `LAND_POLL_MS = 10`. `teardown` calls `land(&mut Entry)` before reverting, unless `!target.alive()`, or no state page, or no hooks were installed. `land` writes the sentinel through `write_speed`, polls the mask against the used slots (gen ≠ 0 read from the page), and returns `Landed::{All, TimedOut(n)}`. On a timeout, stderr gets `starlightd: speed landing timed out with {n} clock(s) not back on real time`.
  - The `speed_set` validation (`MIN_SPEED..=MAX_SPEED`) keeps `0.0` unreachable from RPC.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn detach_after_speed_up_never_turns_monotonic_time_back() { … }
// --clocks: speed 2.0 for 600 ms; detach; the stored CLOCK_MONOTONIC samples (20 ms apart) never decrease;
// detach returns in ≤ 1600 ms; bytes restored.
#[test] fn detach_after_slow_down_catches_up_without_a_jump() { … }
// speed 0.5 for 1000 ms; detach; no sample step > 60 ms; afterwards the samples track real time within 5 ms.
#[test] fn landing_is_bounded_when_the_gap_is_too_large() { … }
// speed 4.0 for 1000 ms (≈ 3 s ahead); detach returns in ≤ 2500 ms; bytes restored.
#[test] fn game_exit_skips_landing() { … }                       // kill the target at 2.0; detach returns in ≤ 300 ms
#[test] fn abstime_waits_stay_sane_while_landing() { … }         // --abs-sleep at 2.0, detach: no 1-s gap in g_abs_sleeps progress
#[test] fn a_slot_idle_across_a_speed_change_stays_continuous() { … } // REALTIME slot read once, speed 2→1, read again: step ≤ elapsed×2 + 5 ms
```
The existing `speed_1_keeps_hooks_and_detach_restores_bytes`, `detach_restores_speed_hooks` and `stdin_eof_restores_speed_hooks` keep passing. Allow their extra landing time (≤ 2.1 s).

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --test speed detach_after`
Expected: FAIL (the monotonic samples step back).

- [ ] **Step 3: Implement** per the Interfaces block and D3.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --test speed && cargo test --manifest-path packages/starlightd/Cargo.toml --lib speed`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "fix(starlightd): game clock lands on real time before speed hooks are removed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Assembler gaps (string instructions, `rep ret`, sign extension, displacements, `lock`, `nop N`)

**Files:**
- Modify: `packages/starlightd/src/asm/parse.rs`, `src/asm/encode.rs`, `src/asm/mod.rs` (tests + the "Accepted subset" doc: drop "Not supported yet: string instructions")

**Interfaces:**
- Produces: `asm::assemble` accepts D4. Operand-less string mnemonics map to iced's string `Code`s (e.g. `Code::Movsb_m8_m8`, `Code::Stosq_m64_RAX`), with `[rdi]`/`[rsi]` implicit. `rep` on `ret` is allowed only for `retn` without an immediate. `nop N`: N parsed as a number (hex default), 1–0x40, else an error `nop count must be 1–40`.
- Errors (exact, line-prefixed as today): `displacement out of range` for a displacement outside `−0x80000000..=0xFFFFFFFF`. `lock` on a register destination or on `mov` → the existing prefix refusal message.

- [ ] **Step 1: Write the failing tests** (unit tests in `asm/mod.rs`; bytes are exact)

```rust
#[test] fn string_instructions() {
  // movsb A4, movsw 66 A5, movsd A5, movsq 48 A5, stosb AA, stosw 66 AB, stosd AB, stosq 48 AB,
  // lodsb AC, lodsw 66 AD, lodsd AD, lodsq 48 AD, cmpsb A6, cmpsw 66 A7, cmpsd A7, cmpsq 48 A7,
  // scasb AE, scasw 66 AF, scasd AF, scasq 48 AF
}
#[test] fn rep_prefixed_string_instructions() { /* rep movsb F3 A4; rep stosq F3 48 AB; repe cmpsb F3 A6; repz cmpsq F3 48 A7; repne scasb F2 AE; repnz scasd F2 AF */ }
#[test] fn string_mnemonics_do_not_shadow_sse() { /* movsd xmm0,xmm1 = F2 0F 10 C1; cmpsd xmm0,xmm1,1 = F2 0F C2 C1 01 */ }
#[test] fn rep_ret() { /* rep ret = F3 C3; repz ret = F3 C3; rep ret 8 → error */ }
#[test] fn sign_extension_conversions() { /* cbw 66 98; cwde 98; cdqe 48 98; cwd 66 99; cdq 99; cqo 48 99 */ }
#[test] fn displacement_wrap_and_sign() {
  // mov eax,[rax+7FFFFFFF] = 8B 80 FF FF FF 7F; mov eax,[rax+80000000] = 8B 80 00 00 00 80;
  // mov eax,[rax-80000000] = 8B 80 00 00 00 80; mov eax,[rax+FFFFFFFF] = 8B 40 FF; mov eax,[rax-1] = 8B 40 FF;
  // mov rax,[rsp+FFFFFFF8] = 48 8B 44 24 F8; mov eax,[rax+1-2] = 8B 40 FF
}
#[test] fn displacement_out_of_range_is_an_error() { /* [rax+100000000] and [rax-80000001] → "line 1: displacement out of range" */ }
#[test] fn lock_forms_and_refusals() {
  // lock add [rax],1 = F0 83 00 01; lock xadd [rcx],eax = F0 0F C1 01; lock cmpxchg [rcx],edx = F0 0F B1 11;
  // lock inc dword ptr [rax] = F0 FF 00; lock or byte ptr [rdx],1 = F0 80 0A 01; xchg [rax],eax = 87 00 (no F0);
  // lock add eax,1 → error; lock mov [rax],eax → error
}
#[test] fn nop_with_count() { /* nop 3 = 90 90 90; nop = 90; nop 0 → error */ }
```
Add `rep movsb`, `rep stosq`, `cdqe` and `cqo` byte sequences to the existing `round_trips_disassembly_corpus`, so whatever `disasm` prints for them assembles back. Cases that already pass stay as regression tests.

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --lib asm`
Expected: FAIL (string instructions, `rep ret`, `nop 3`, the out-of-range displacement).

- [ ] **Step 3: Implement** per D4.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --lib asm && cargo test --manifest-path packages/starlightd/Cargo.toml --test code`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd/src/asm
git commit -m "feat(starlightd): assembler string instructions, rep ret, sign extension, nop N

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Schema v2 extensions for compiled tables, and reason codes

**Files:**
- Modify: `packages/ct-importer/src/starlight-format.ts`, `src/agent-cheat.ts`, `src/index.ts`, `test/starlight-format.test.ts`, `test/agent-cheat.test.ts`
- Create: `packages/ct-importer/src/reasons.ts`
- Modify (type fallout from the `symbol` kind): `apps/desktop/src/main/engine-host.ts` (`resolveAddress`: `symbol` → `Error('table symbols need the table session')`), `apps/desktop/src/main/agent/tools-library.ts` (`symbol` → `${expr}`), `apps/desktop/src/renderer/lib/cheat-kind.ts`, `packages/engine/src/cheats.ts` (`describeAddress` exhaustiveness only; behavior is Task 9)

**Interfaces:**
- Produces (`@starlight/ct-importer`):
  - `SymbolAddress = { kind: 'symbol'; expr: string; offsets?: string[] /* hex, application order */ }`, in the **v2** `Address` union only. V1's schema keeps the four-kind union (`AddressV1`).
  - `PatchCheat.site` optional.
  - `PatchStep` adds `{ op: 'aobScan', name: Ident, module?: string, pattern: string }` and `{ op: 'unregisterSymbol', name: Ident }`.
  - Types `StarlightSymbolAddress`. `StarlightPatchStep` covers the new ops.
  - `validateAgentCheat` new errors (exact):
    - `address: agent-made cheats can't use table symbols; use an aob, pointer or module address`
    - `site: agent-made code cheats need an aob site`
    - `enable[N].op: agent-made cheats can't use aobScan; use site`
    - `enable[N].op: unregisterSymbol only belongs in a table's disable steps`
  - `reasons.ts`: `export const REASON_CODES = [...] as const` (D12 list, exact strings), `export type ReasonCode = typeof REASON_CODES[number] | 'aa:script'` (`aa:script` is used only by the baseline), `export function reasonCopy(code: string): string`, e.g. `lua:table-script` → `This table runs Lua code when it loads.`, `lua:block` → `A script in this table runs Lua code.`, `aa:createthread` → `A script starts its own thread in the game.`, `asm:error` → `A script uses an instruction Starlight can't assemble yet.`, `sym:mono` → `A script uses Mono/IL2CPP names (needs Cheat Engine's Mono features).`, `table:empty` → `This table has no cheats to run.` Unknown codes → `This table needs Cheat Engine.`

- [ ] **Step 1: Write the failing tests**

```ts
// starlight-format.test.ts
it('accepts a v2 value cheat with a symbol address and offsets', ...)
it('rejects a symbol address in a v1 file', ...)                     // schemaVersion 1 + kind 'symbol' → throws
it('accepts a patch cheat without a site and with aobScan/unregisterSymbol steps', ...)
it('every catalog trainer in packages/catalog/trainers still parses', ...)   // unchanged guard
// agent-cheat.test.ts
it('rejects symbol addresses with the exact message', ...)
it('requires a site for agent patch cheats', ...)
it('rejects aobScan and unregisterSymbol steps for agents', ...)
// reasons (in starlight-format.test.ts or a new reasons.test.ts)
it('every reason code has player copy', ...)                          // REASON_CODES.every(c => reasonCopy(c) !== 'This table needs Cheat Engine.')
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 starlight-format agent-cheat reasons`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass, then typecheck the consumers**

Run: `pnpm --filter @starlight/ct-importer build && pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 starlight-format agent-cheat reasons && pnpm --filter @starlight/engine lint && pnpm --filter ./apps/desktop lint`
Expected: PASS; both lints clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer packages/engine/src/cheats.ts apps/desktop/src
git commit -m "feat(ct-importer): pure v2 extensions for compiled tables and reason codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The AA-subset compiler

**Files:**
- Create: `packages/ct-importer/src/aa-compiler.ts`, `test/aa-compiler.test.ts`, `test/fixtures/aa/` (`template-injection.cea`, `two-aobs.cea`, `module-offset.cea`, `globalalloc-symbol.cea`, `define-bytes.cea`, `lua-block.cea`, `createthread.cea`, `readmem.cea`, `mono-symbol.cea`, `no-sections.cea`, `disable-elsewhere.cea`)
- Modify: `packages/ct-importer/src/index.ts`

**Interfaces:**
- Consumes: `StarlightPatchCheat`, `StarlightPatchStep`, `ReasonCode` (Task 6).
- Produces:
  - `compileAaScript(script: string, o: { id: string; name: string }): AaResult`
  - `type AaResult = { ok: true; cheat: StarlightPatchCheat | null /* null: [ENABLE] has no statements (a no-op script) */; registers: string[]; uses: string[] } | { ok: false; code: ReasonCode; detail: string; line: number | null }`. `registers`/`uses` are lowercased and deduplicated. `detail` names the statement (`createthread(newmem)`). `line` is 1-based in the original script.
  - Mapping, step order, origins, names: the reference section above, exactly.
  - Comments: `//…` to end of line and `{ … }` blocks (which may span lines), except `{$…}` directives, which are handled first. Text inside quotes is kept.

- [ ] **Step 1: Write the failing tests** (each fixture is a realistic CE-template script; assertions are deep-equal on the steps)

```ts
it('compiles the CE AOB-injection template', ...)
  // template-injection.cea: aobscanmodule(INJECT,target,8B 05 ?? ?? ?? ?? 83 C0 01), alloc(newmem,$1000,INJECT),
  // label(code) label(return), registersymbol(INJECT), newmem:/code:/jmp return, INJECT: jmp newmem / nop 4 / return:,
  // [DISABLE] INJECT: db 8B 05 10 20 30 40 83 C0 01 / unregistersymbol(INJECT) / dealloc(newmem)
  // → site { kind:'aob', module:'target', pattern:'8B 05 ?? ?? ?? ?? 83 C0 01' }
  //   enable: [aobScan INJECT, alloc newmem 4096 near 'INJECT', assemble at 'newmem' (source starts 'code:'),
  //            assemble at 'INJECT' source 'jmp newmem\nnop 4\nreturn:', registerSymbol INJECT at 'INJECT']
  //   disable: [writeBytes at 'INJECT' bytes '8b051020304083c001', unregisterSymbol INJECT]
  //   registers ['inject'], uses []
it('orders alloc segments before site segments even when the site comes first in the source', ...)
it('two aobscans: the first is the site, both are aobScan steps', ...)
it('2-argument alloc is near the first aob, else the first module origin', ...)   // module-offset.cea: '"target"+1234:' origin → near '"target"+1234'
it('globalalloc allocates and registers', ...)
it('define substitutes whole words, case-insensitively, including in db', ...)     // define(bytes,8B 05 …) + db bytes
it('symbol+offset and module+offset origins become step addresses', ...)           // 'INJECT+2:' → at 'INJECT+2'
it('uses lists names defined elsewhere', ...)                                       // 'mov rax,[pPlayer]' → uses ['pplayer']
it('{$lua} blocks are lua:block with the line', ...)
it('createthread is aa:createthread; readmem is aa:readmem', ...)
it('a Class:Method name is in uses with its colon', ...)                            // mono-symbol.cea → uses ['playercontroller:update']
it('a script without [ENABLE] is aa:no-enable', ...)
it('a disable write to an address enable never wrote is aa:disable-write', ...)
it('a pointer origin is aa:pointer-origin', ...)                                     // '[pBase+10]:'
it('unknown commands are aa:unknown-command with the name', ...)                    // 'foo(1)' → detail 'foo(1)'
it('alloc over 0x10000 is aa:alloc-size', ...)
it('names that are not identifiers are aa:name', ...)                               // 'label(my-label)'
it('code before any origin is aa:parse', ...)
it('comments, including multi-line braces, are removed but {$…} directives are seen', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 aa-compiler`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** per the reference section. A line-based scanner is enough. Every statement is one line in practice.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 aa-compiler && pnpm --filter @starlight/ct-importer lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer
git commit -m "feat(ct-importer): compile the Auto Assembler subset to v2 patch steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `compileTable`: every CT record, value addresses, dropdowns, hotkeys

**Files:**
- Create: `packages/ct-importer/src/table-compiler.ts`, `src/ct-address.ts`, `test/table-compiler.test.ts`, `test/ct-address.test.ts`, `test/fixtures/tables/` (`native-ok.CT`, `with-lua-record.CT`, `table-lua.CT`, `symbol-children.CT`, `dropdown-hotkeys.CT`, `custom-type.CT`)
- Modify: `packages/ct-importer/src/hotkey-parser.ts`, `test/hotkey-parser.test.ts`, `src/index.ts`; `packages/indexer/src/coverage.ts` + `test/coverage.test.ts` (the `'native'` compiler)

**Interfaces:**
- Consumes: `compileAaScript` (Task 7), `parseCt`, `listCtRecords`, `mapCtType`, `REASON_CODES`.
- Produces:
  - `parseCtAddress(addr: string | number, xmlOffsets: number[] | undefined, parent: StarlightAddress | null): StarlightAddress | null` (D11). Relative `+hex`/`-hex` with no parent → `null`.
  - `vkKeysToAccelerator(keys: number[]): string | undefined`. It is today's `keysToAccel`, made public, plus letters `A`–`Z` (65–90), `Num0`–`Num9` (96–105) and `Space` (32), using names `parseAccelerator` in `apps/desktop/src/main/hotkey-matcher.ts` accepts. `parseHotkeys` keeps its output.
  - `interface CompiledHotkey { action: 'toggle' | 'activate' | 'deactivate' | 'set' | 'inc' | 'dec'; accelerator: string; value?: string }`
  - `type CompiledRecord = { id: number; name: string; depth: number; opts?: string; hotkeys: CompiledHotkey[] } & (`
    `| { kind: 'header'; script: CompiledScript | null }`
    `| { kind: 'script'; script: CompiledScript }`
    `| { kind: 'value'; valueType: StarlightValueType | 'bytes'; length?: number; address: StarlightAddress; showAsHex: boolean; showAsSigned: boolean; options?: { value: string; label: string }[] }`
    `| { kind: 'unsupported'; code: ReasonCode; detail: string })`
  - `type CompiledScript = { cheat: StarlightPatchCheat | null /* null = no-op */; registers: string[]; uses: string[] }`
  - `interface CompiledTable { records: CompiledRecord[]; native: boolean; reasons: Array<{ recordId: number | null; name: string; code: ReasonCode; detail: string }>; registeredBy: Record<string, number> /* symbol → record id */ }`
  - `compileTable(xml: string): CompiledTable`. Ids and order equal `listCtRecords(xml)`. Value types: `mapCtType` plus `Array of byte` (`ByteLength`) → `'bytes'`, and `String` with `Length`. Others → `value:type` (detail = the type). An address that doesn't parse → `addr:expression`. Table rules D13. A script's `uses` not in any record's `registers` → `sym:unresolved` / `sym:mono` on that record. `native` = no reasons.
  - `coverage.ts`: `measureTable(…, 'native')` uses `compileTable` (codes per record from `reasons`, `table:empty`/`lua:table-script` as table codes). `scripts/ct-coverage.mjs --compiler native --assemble` additionally runs the engine's `checkAssembles` (Task 9) per native script and turns failures into `asm:error`.

- [ ] **Step 1: Write the failing tests**

```ts
// ct-address.test.ts
it('module, quoted module and absolute forms', ...)                  // '"target"+4030' → { module 'target', offset '0x4030' }
it('symbols with offsets and brackets', ...)                         // 'pPlayer+8' → symbol { expr 'pPlayer+8' };
                                                                     // '[[pPlayer]+18]+4' → symbol { expr 'pPlayer', offsets ['0x18','0x4'] }
it('CT offsets are applied innermost-first, after bracket offsets', ...)  // addr 'pBase', <Offsets>10,18</Offsets> → offsets ['0x18','0x10']
it('a child +10 folds into the parent address', ...)                 // parent module +4030 → '0x4040'; parent pointer offsets […,'0x10'] → last '0x20'; parent symbol 'p' → 'p+10'
it('a relative address with no parent is null', ...)
// table-compiler.test.ts
it('a table of supported records is native with matching ids', ...)  // native-ok.CT: records.map(r=>r.id) equals listCtRecords ids
it('one Lua record sends the whole table to CE with lua:block', ...)
it('a table-level Lua script is lua:table-script; comment-only Lua is ignored', ...)
it('a header-only table is table:empty', ...)
it('children addressed through a registered symbol compile and resolve to the registering record', ...)
  // symbol-children.CT: registeredBy { pplayer: 10 }; child '[pPlayer]+10' → symbol { expr 'pPlayer', offsets ['0x10'] }
it('a used symbol nobody registers is sym:unresolved on that record', ...)
it('dropdown lists and links become options', ...)                   // '0:Off\n1:On' → [{value:'0',label:'Off'},{value:'1',label:'On'}]
it('table hotkeys compile with their actions and values', ...)       // Set Value 999 on F3 → { action:'set', accelerator:'F3', value:'999' }
it('ShowAsHex and ShowAsSigned are read', ...)
it('custom and binary types are value:type with the type name', ...)
it('an empty script record compiles to a no-op', ...)                // script.cheat === null
// hotkey-parser.test.ts
it('vkKeysToAccelerator maps letters and numpad', ...)               // [17,65] → 'Ctrl+A'; [96] → 'Num0'
// packages/indexer/test/coverage.test.ts
it('native compiler: a compiled-AA table is native', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 table-compiler ct-address hotkey-parser`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter @starlight/ct-importer build && pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 table-compiler ct-address hotkey-parser aa-compiler && pnpm --filter @starlight/indexer test -- --pool=forks --poolOptions.forks.maxForks=2 coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer packages/indexer
git commit -m "feat(ct-importer): compile whole tables (symbols, relative addresses, dropdowns, hotkeys)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Engine: run compiled AA (registry, forward labels, `aobScan`, disable), and `aob_scan` over executable memory

**Files:**
- Modify: `packages/starlightd/src/aob.rs`, `src/rpc.rs` (`PROTOCOL = 3`, capability `aob_exec`), `packages/starlightd/tests/scan.rs`
- Modify: `packages/engine/src/cheats.ts`, `src/aob-scan.ts`, `src/types.ts`, `src/client.ts` (`PROTOCOL_VERSION = 3`), `src/index.ts`, `README.md` ("Running compiled tables"), `test/cheats.test.ts`
- Create: `packages/engine/test/aa-runner.test.ts`

**Interfaces:**
- Consumes: `compileAaScript` (Task 7, in tests); M2/M3 engine functions.
- Produces:
  - Daemon `aob_scan { handle, pattern, module?, max? }`. Without `module`, it scans every executable region in address order, skipping this daemon's hook and state pages.
  - `AobScanSpec.module?: string`.
  - `type SymbolRegistry = Map<string, string>` (lowercase name → `0x…`).
  - `interface EnableOptions { value?: number; intervalMs?: number; symbols?: SymbolRegistry; mainModule?: string; log?(line: string): void }`. `enableCheat(s, cheat, o?: EnableOptions)`.
  - `verifyCheat(s, cheat, o?: { symbols?: SymbolRegistry; mainModule?: string })` and `resolveCheatAddress(s, a, o?)` handle `symbol` addresses: `expr` resolves through the local symbols, then the registry, then `resolveAddressExpr`. Offsets go through `resolvePointerChain` with no module. An unknown name → `EngineError('symbol <name> isn\'t registered')`.
  - Patch run phases (D7):
    - A: `aobScan` (reusing the site match when module+pattern are equal; `$process` → `o.mainModule`; zero matches → `ScanError('AOB <name> not found in <module ?? "executable memory">')`), `alloc`, and `registerSymbol` steps resolvable without labels.
    - B: layout of every `assemble`.
    - C: `assemble`/`writeBytes` in step order, as recorded patches.
    - D: the remaining `registerSymbol`.
    `registerSymbol` exports to `o.symbols` when given. `uses` names are not checked here (the backend does it).
  - Failure at any phase: revert the patches, newest first; delete the registry entries this run added; rethrow.
  - `RunningCheat.disable()` per D8, then `unregisterSymbol`. The M3 refusal of `disable` lists is removed.
  - `definedLabels(source: string): string[]` (`/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm`, lowercased).
  - `checkAssembles(c: EngineClient, cheat: StarlightPatchCheat, o?: { known?: string[] }): Promise<{ ok: true } | { ok: false; step: number; message: string }>`. Placeholders: alloc names at `0x10000000 + i·0x10000`; aob names, `site`, `known` names and module names at `0x11000000 + j·0x100000`; labels resolved by the same layout loop. It calls the game-less `assemble` RPC.

- [ ] **Step 1: Write the failing tests**

`tests/scan.rs`:
```rust
#[test] fn aob_scan_without_module_finds_code_in_executable_memory() { … }  // signature of bump_counter, no module → first match == bump_counter
#[test] fn aob_scan_without_module_skips_data() { … }                        // g_aob_marker pattern (data) → no matches
#[test] fn hello_reports_protocol_3_and_aob_exec() { … }
```
`aa-runner.test.ts` (real debug daemon + C target `--writer --heap-chain`; scripts built in the test from `makeSignature` + `disassemble` of `bump_counter`, then compiled with `compileAaScript`):
```ts
it('runs the CE injection template: the cave adds 99 per tick; disable restores the bytes', ...)
  // newmem: add dword ptr [g_counter],#99 + displaced instructions; INJECT: jmp newmem / nop N / return:
  // g_counter delta over 300 ms ≥ 100× the normal rate; after disable the site bytes equal the originals
it('forward labels: newmem jumps to return defined in the later site segment', ...)
it('registersymbol exports to the registry; disable with unregistersymbol removes it', ...)
it('a symbol value address reads through the registry', ...)        // registry.set('pplayer', g_root address) → symbol { expr 'pPlayer', offsets ['0x18','0x10'] } reads 777
it('a failing second segment rolls back the first and registers nothing', ...)  // second assemble 'mov eax,' → AssembleFailed; site bytes unchanged; registry empty
it('a missing aob is a ScanError whose message says not found', ...)  // message matches /not found/ and isStaleTableError regex /aob|not found/i
it('disable keeps the recorded original when the table\'s restore bytes differ', ...) // disable writeBytes 'c3' → bytes == recorded original; log called with the exact line
it('aobscan without a module runs on executable memory', ...)
it('$process names the main module', ...)                            // mainModule 'target'
it('checkAssembles passes the template and reports a bad instruction with its step', ...) // 'fld st(0)' (x87) → { ok:false, step: 2 }
```
`cheats.test.ts`: M3's `refuses a cheat with disable steps` becomes `runs a cheat with disable steps (revert, then checks)`.

- [ ] **Step 2: Run tests and see them fail**

Run: `cargo build --manifest-path packages/starlightd/Cargo.toml && cargo test --manifest-path packages/starlightd/Cargo.toml --test scan && pnpm --filter @starlight/engine test -- --maxWorkers=2 aa-runner cheats`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `cargo test --manifest-path packages/starlightd/Cargo.toml --test scan --test protocol && pnpm --filter @starlight/engine build && pnpm --filter @starlight/engine test -- --maxWorkers=2 aa-runner cheats && pnpm --filter @starlight/engine lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine
git commit -m "feat(engine): run compiled Auto Assembler cheats (registry, forward labels, disable)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The native table backend (and session hotkeys)

**Files:**
- Create: `apps/desktop/src/main/table-backend.ts`, `src/main/native-backend.ts`, `test/main/native-backend.test.ts`, `test/main/hotkey-host.session.test.ts`
- Modify: `apps/desktop/src/main/hotkey-host.ts`

**Interfaces:**
- Consumes: `CompiledTable`, `CompiledRecord`, `vkKeysToAccelerator` (Task 8); `enableCheat`, `RunningCheat`, `SymbolRegistry`, `resolveCheatAddress`, `readMany`, `read`, `write`, `freeze`, `aobScan` (Task 9); `CeRecord` (`ce-session.ts`, `import type` only, so there is no runtime cycle); `EngineApi` (`agent/tools.ts`, M3).
- Produces:
  - `table-backend.ts`: `type BackendMethod = 'ping' | 'status' | 'list_records' | 'refresh' | 'set_active' | 'check_script' | 'load_table' | 'set_value' | 'set_speed' | 'set_hotkeys' | 'shutdown'`; `interface BackendCommand { method: string; params?: unknown }`; `interface TableBackend { readonly kind: 'ce' | 'native'; send(cmd: BackendCommand): Promise<unknown>; close(): Promise<void> }`.
  - `hotkey-host.ts`: `setSessionHotkeys(bindings: Array<{ id: number; accelerator: string }>, onPress: (id: number) => void): void` and `clearSessionHotkeys(): void`. This is a third slot, apart from the trainer and agent bindings: `registerForTrainer`/`unregisterAll` never clear it.
  - `native-backend.ts`: `createNativeBackend(deps: { session: Session; compiled: CompiledTable; mainModule: string; engine?: Partial<EngineApi>; hotkeys?: { set: typeof setSessionHotkeys; clear: typeof clearSessionHotkeys }; onEvent?(e: Record<string, unknown>): void; log?(line: string): void; loadCompiled?(path: string): Promise<CompiledTable> }): TableBackend`. Replies match the CE bridge's shapes:
    - `ping` → `{ ok: true, ready: true, attached: true }`. `status` → `{ attached: true, pid, ready: true }`.
    - `list_records` → `{ records: CeRecord[] }`, with `kind` from the compiled record (`unsupported` never occurs in a native table), `hotkey` = the record's `toggle` accelerator, `options`, `opts`, and `value` for value records (D23).
    - `refresh` → `{ states: { id, a, v? }[] }` (values through one `readMany` after resolving addresses; unresolvable → `'??'`).
    - `set_active { id, active }` → `{ ok, active, error? }`. Scripts: `enableCheat(..., { symbols: registry, mainModule })`. Before enabling, every `uses` name must be in the registry, else `error: 'symbol <name> isn\'t registered; switch on "<registering record name>" first'`. Values: freeze at the current value. `moActivateChildrenAsWell` / `moDeactivateChildrenAsWell` cascade to the children (in table order). Toggles serialize per record id (a promise chain per id). Errors are plain text: engine `ScanError` messages pass through.
    - `check_script { id }` → `{ ok: true, found }` | `{ ok: false, found, missing, error: "signature '<name>' is not in the game" }` | `{ unknown: true, reason: 'no signatures to look up' }`. It checks the `site` and `aobScan` patterns without writing.
    - `set_value { id, value }` → `{ ok, value }`. Dropdown values are written as numbers. Hex records accept hex input.
    - `set_hotkeys { bindings, replace }` → `{ ok: true, count }`. It registers the table hotkeys (minus `replace` ids) plus `bindings` (VK → `vkKeysToAccelerator`). A press runs the action and calls `onEvent({ type: 'hotkey', id, ok, active, error })`.
    - `load_table { path }` → disable everything, clear hotkeys, `loadCompiled(path)`, reset the registry → `{ ok: true }`.
    - `set_speed` → `{ ok: false, error: 'game speed is handled by the session' }` (main routes it, D18).
    - `shutdown` → disable every active record, newest first; clear hotkeys → `{ ok: true }`.
    - Anything else → `{ ok: false, error: 'unknown method: <m>' }`.
    - `close()` = `shutdown`, then the session detach is the caller's job.

- [ ] **Step 1: Write the failing tests** (fake engine functions; compiled tables from Task 8 fixtures via `compileTable`)

```ts
it('list_records mirrors the CE bridge shape', ...)                  // ids/kinds/depth/opts/hotkey/options from dropdown-hotkeys.CT
it('switching a script on runs its patch cheat with the shared registry', ...)
it('a script that needs another record\'s symbol says which record to switch on', ...)  // exact error text; enableCheat not called
it('values through a registered symbol show ?? until it is registered', ...)
it('a value record switched on freezes at its current value; set_value updates the freeze', ...)
it('moActivateChildrenAsWell switches the children on in order', ...)
it('concurrent toggles of one record are serialized', ...)            // two set_active calls in flight → enableCheat called once, final state = last request
it('check_script reports a missing signature in CE\'s words', ...)
it('set_hotkeys registers table hotkeys except replaced records, plus user bindings', ...)
it('a hotkey press toggles the record and posts the hotkey event', ...)
it('set value hotkeys write their value', ...)
it('shutdown disables everything newest first and clears hotkeys', ...)
it('unknown methods are refused', ...)
// hotkey-host.session.test.ts
it('session hotkeys survive registerForTrainer and unregisterAll', ...)
it('setSessionHotkeys replaces the previous session bindings', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 native-backend hotkey-host.session`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 native-backend hotkey-host && pnpm --filter ./apps/desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/table-backend.ts apps/desktop/src/main/native-backend.ts apps/desktop/src/main/hotkey-host.ts apps/desktop/test/main
git commit -m "feat(desktop): native table backend on starlightd, with table hotkeys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Engine-agnostic session: the CE backend behind `TableBackend` (no behavior change)

**Files:**
- Create: `apps/desktop/src/main/ce-backend.ts`
- Modify: `apps/desktop/src/main/ce-session.ts`, `test/main/ce-session.test.ts` (only where tests reach into `bridge`/`ceProcess`)

**Interfaces:**
- Consumes: `TableBackend` (Task 10).
- Produces:
  - `ce-backend.ts`: `launchCeBackend(o: CeLaunchOpts): Promise<CeBackend>`. It moves the Proton/Wine launch, ceserver, ptrace-cap check, control script, `spawnCeProcess` and ping wait out of `startSession` verbatim. `CeLaunchOpts` holds the fields of `StartSessionOpts` it uses, plus `effectivePid`, `processName`, `proton`, `ctPath`, `sessionId`, `onLauncherExit()`. `interface CeBackend extends TableBackend { kind: 'ce'; ready: boolean; launcherExited(): boolean }`. Its `send` translates a `load_table` `path` with `toWinePath`. `close()` = bridge close + process kill (SIGTERM) + ceserver stop.
  - `SessionState`: `backend: TableBackend | null` replaces `bridge` and `ceProcess`. `mode: 'ce' | 'native' | 'paused'` replaces `engine`. `StartSessionResult.engine` stays, derived from `mode` (D16), and the result gains `mode`.
  - `prepareTable`, `pickTable`, `enableRecord`, `waitTableReady`, `sendWithTimeout` take a `TableBackend` instead of a `Bridge`, and `pickTable`'s `load` passes the Linux path (the backend translates).
  - `ceSessionFor(pid)` is true only for `mode === 'ce'` with a backend. `releaseToStarlightd` sets `mode = 'paused'`.

- [ ] **Step 1: Run the existing session tests as the guard**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 ce-session game-owner user-cheats-host`
Expected: PASS before the change (the baseline).

- [ ] **Step 2: Refactor** per the Interfaces block. Move code, don't rewrite it.

- [ ] **Step 3: Run the same tests and see them still pass**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 ce-session game-owner user-cheats-host && pnpm --filter ./apps/desktop lint`
Expected: PASS with the same test count. Only test lines that read `session.bridge`/`.engine` changed (to `.backend`/`.mode`).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/ce-backend.ts apps/desktop/src/main/ce-session.ts apps/desktop/test/main/ce-session.test.ts
git commit -m "refactor(desktop): CE session drives a TableBackend; CE launch moves to ce-backend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `ct-runner` routing and native sessions in the pipeline

**Files:**
- Create: `apps/desktop/src/main/ct-runner.ts`, `test/main/ct-runner.test.ts`
- Modify: `apps/desktop/src/main/ce-session.ts`, `src/main/game-owner.ts` (`Holder` adds `'table'`), `src/main/user-config.ts` (`preferences.nativeTables`, default `true`), `src/shared/ipc.ts`, `src/preload/index.ts` (types), `src/main/index.ts`, `test/main/ce-session.test.ts`, `test/main/game-owner.test.ts`, `test/main/user-config.test.ts`

**Interfaces:**
- Consumes: `compileTable`, `reasonCopy` (Tasks 6/8); `checkAssembles`, `attach` (engine); `createNativeBackend` (Task 10); `launchCeBackend` (Task 11); `GameOwner`.
- Produces:
  - `ct-runner.ts`:
    - `interface RouteDecision { engine: 'native' | 'ce'; compiled: CompiledTable | null; codes: Record<string, number>; first: { recordId: number | null; name: string; code: string; detail: string } | null; records: number; sha256: string }`
    - `routeTable(ctPath: string, deps: { getClient(): Promise<EngineClient>; enabled: boolean; check?: typeof checkAssembles; log?(line: string): void; label: string /* "<cacheKey>#<tableId>" */ }): Promise<RouteDecision>`. Order: read → sha256 → `enabled` false → `ce` (`detail: 'turned off in Settings'`) → `compileTable` → not native → `ce` → `checkAssembles` per script (daemon unreachable → `ce`, `detail: 'engine unavailable'`; a failure → `asm:error` with the message) → `native`. It logs the D20 line.
    - `recordRoute(file: string, d: RouteDecision): Promise<void>`. D20 format, atomic write, deduplicated by `sha256`.
  - `ipc.ts`: `type SessionMode = 'ce' | 'native' | 'paused'`; `interface RouteSummary { engine: 'native' | 'ce'; codes: Record<string, number>; first: { recordId: number | null; name: string; code: string; detail: string; copy: string } | null }`. The `CeSessionStartResult` ok branch gains `mode: SessionMode` and `route: RouteSummary | null`. `session:engine` gains `mode`. `AppPreferences.nativeTables: boolean`.
  - `StartSessionOpts` gains `routeTableFn?: (ctPath: string, label: string) => Promise<RouteDecision>`, `createNativeBackendFn?: typeof createNativeBackend`, `attachEngineFn?: (pid: number) => Promise<Session>`, `holdTable?: (pid: number) => () => void`, `nativeTables?: boolean`. The defaults wire to the real ones. `index.ts` passes `holdTable: (pid) => gameOwner.hold(pid, 'table')` and records routes into `<userData>/ct-routing.json`.
  - `startSession` flow: `resolveTable` → `route = ctPath ? routeTableFn(ctPath, label) : null` → preview (no pid): return the records and `route` without launching anything → anti-cheat → **native route**: `engineNeedsPtraceGrantFn` → `PTRACE_MESSAGE` if needed; `attachEngineFn(pid)`; `holdTable(pid)`; the backend; the module wait; the late anti-cheat check; `pickTable`. Otherwise, the existing CE path, or paused when holders exist. Native mode doesn't release or pause on holders (D16).
  - `pickTable` (D17): each next candidate is routed after download. While on native, a `ce` candidate closes the native backend (shutdown + detach + release the hold) and launches CE through `launchCeBackend`, after which the session stays CE. While on CE, native-routable candidates load in CE.
  - `callSession` in native mode: `set_speed` → `scannerHost.call(pid, 'speed_set', params)`; `speed_set` stays allowed; scanner methods → `scannerHost`; everything else → `backend.send`.
  - `endSession` / game exit in native mode: `backend.close()`, session detach, release the hold, `scannerHost.end()`, `clearSessionHotkeys()`.
  - `retryTables` works for native (reload through `load_table`).

- [ ] **Step 1: Write the failing tests**

`ct-runner.test.ts` (fixture CTs from Task 8, fake `checkAssembles`):
```ts
it('a fully compiling table routes native and logs it', ...)          // log line exact: '[ct-runner] k#0: native (3 records)'
it('a Lua record routes the whole table to CE with its code', ...)    // codes { 'lua:block': 1 }; log '… : ce (lua:block ×1)'
it('an instruction the assembler rejects routes CE as asm:error', ...)
it('an unreachable engine routes CE', ...)
it('turned off in Settings routes CE', ...)
it('recordRoute counts each table once by sha256', ...)               // record twice → tables.native === 1
```
`ce-session.test.ts`:
```ts
it('a native-routed table attaches starlightd, holds the game and never launches Cheat Engine', ...)  // spawnCeProcess not called; mode 'native'; hold('table') once
it('native sessions run prerequisites and the verdict through the native backend', ...)
it('preview sessions report the route without launching anything', ...)
it('game exit ends a native session and releases the table hold', ...)   // release called; clearSessionHotkeys called; session:game-exited
it('game speed in a native session goes to the scanner host', ...)       // set_speed → scannerHost.call(pid,'speed_set',{speed:2})
it('a CE candidate later in the pick switches to Cheat Engine once and stays', ...)
it('a CE-routed table on a game the agent holds opens paused, as before', ...)
it('a native-routed table on a game the agent holds runs native', ...)
it('anti-cheat refuses before any backend starts', ...)
it('ptrace restricted without the grant refuses native with the Allow message', ...)
```
`game-owner.test.ts`: `table is a starlightd holder; claims on a native game release nothing`. `user-config.test.ts`: `nativeTables defaults to true`.

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 ct-runner ce-session game-owner user-config`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 ct-runner ce-session game-owner user-config user-cheats-host native-backend && pnpm --filter ./apps/desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): ct-runner routes tables to starlightd or Cheat Engine, with reason codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The game page in native sessions

**Files:**
- Modify: `apps/desktop/src/renderer/stores/ce-session-store.ts`, `src/renderer/components/ce/CeSessionView.tsx`, `src/renderer/routes/SettingsRoute.tsx`, `test/components/CeSessionView.test.tsx`, `test/stores/ce-session-store.test.ts`, the Settings route test if one exists

**Interfaces:**
- Consumes: `mode`, `route` and the `session:engine` `mode` (Task 12).
- Produces:
  - `useCeSessionStore` gains `mode: SessionMode` and `route: RouteSummary | null`, set from the start result and `session:engine`. `paused` everywhere becomes `mode === 'paused'`. `engine` stays for M3 code.
  - `CeSessionView` header pill next to the title: native → **Starlight engine**; CE with a route → **Cheat Engine** with a `title`/focus tooltip `Runs in Cheat Engine: ${route.first.copy}` (plus `(“${route.first.name}”)` when it has a record). No pill in paused mode or without a table.
  - The speed buttons are unchanged in markup. Their `setSpeed` path is unchanged (main routes it). A failed `speed_set` shows `speedError` as today.
  - Settings, General section: a toggle **Run tables on Starlight's engine when possible**, with the hint `Off sends every table to Cheat Engine.`, bound to `preferences.nativeTables`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('a native session shows the records with a Starlight engine pill, not the paused notice', ...)
it('a CE-routed session explains why in the pill tooltip', ...)          // 'Runs in Cheat Engine: A script in this table runs Lua code. (“Infinite Ammo”)'
it('speed buttons in a native session call set_speed and show the active speed', ...)
it('paused mode is unchanged', ...)                                       // the M3 PausedNotice tests still pass
it('the Settings toggle writes preferences.nativeTables', ...)
// ce-session-store.test.ts
it('start stores mode and route; session:engine updates mode', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 CeSessionView ce-session-store SettingsRoute`
Expected: FAIL.

- [ ] **Step 3: Implement** with the existing pill styles and `animate-rise`.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 CeSessionView ce-session-store SettingsRoute MyCheatsSection && pnpm --filter ./apps/desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): native table sessions on the game page; engine pill and Settings switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Live verification (`scripts/live-m4.mjs`)

No new product code is expected. A bug found here goes back to its owning task, with a test.

**Files:**
- Create: `scripts/live-m4.mjs`

**Interfaces:**
- `node scripts/live-m4.mjs <native|proton>`. It reuses `live-m3.mjs`'s harness: the subreaper wrapper, killing only pids it spawned (pid + start time), cleanup on signals, the temporary `XDG_CONFIG_HOME`, `dbus-run-session` + `WLR_BACKENDS=headless cage --`, CDP on 9223, and a localhost HTTP server for the CT files.
- The script writes the CTs at run time, so they match the built binaries. It gets the site signature and displaced instructions from the debug daemon (`makeSignature`, `disassemble`) on its own spawned target, then writes:
  - `target-aa.CT`:
    - a header **Player** with a value record `"target"+<g_health off>` (4 Bytes), a `DropDownList` `64:Full\n1:Low` and an F2 toggle hotkey;
    - a script **Counter ×100** (`aobscanmodule(INJECT,target,<sig>)`, `alloc(newmem,$100,INJECT)`, `label(return)`, `registersymbol(INJECT)`, a cave that adds `#99` to `g_counter`, then the displaced instructions and `jmp return`; `[DISABLE]` restores with `db <original bytes>` and `unregistersymbol`);
    - a script **Expose counter** that `globalalloc(pCounter,8)` and stores `g_counter`'s address with `dq`, with a child value record `[pCounter]` (4 Bytes).
  - `target-lua.CT`: the same records plus one script with a `{$lua}` block.
  - `gold.CT`: `aobscanmodule(INJECT,gold.exe,<sig of earn>)` and a cave that adds `#99` to `[rax+10]`, built from `earn`'s disassembly.

- [ ] **Step 1: Build**

Run: `cargo build --release --manifest-path packages/starlightd/Cargo.toml && cargo build --manifest-path packages/starlightd/Cargo.toml && pnpm --filter @starlight/ct-importer build && pnpm --filter @starlight/engine build && pnpm --filter ./apps/desktop build && make -C packages/engine/test-target && make -C packages/engine/test-target/win`
Expected: all succeed. (Only the packages the app needs are built, not `pnpm -r`.)

- [ ] **Step 2: Native target**

`node scripts/live-m4.mjs native` spawns `target --writer --heap-chain --clocks --abs-sleep` and adds it as a manual game. It checks:
- Routing: `compileTable(target-lua.CT)` → `native: false` with `lua:block`. A preview `ceSessionStart` (no pid) for the Lua table returns `route.engine === 'ce'` and launches no CE process (no `cheatengine` among the app's descendants). The preview for `target-aa.CT` returns `route.engine === 'native'`.
- `ceSessionStart` with the pid for `target-aa.CT` returns `mode: 'native'`, the record tree (header, nesting, the dropdown options, the F2 hotkey) and `attached: true`. No CE process appears.
- **Counter ×100** on: `g_counter` grows ≥ 50× faster (read from `/proc/<pid>/mem`). Off: the site bytes equal the originals, and the rate is back to normal.
- **Expose counter** on: the child `[pCounter]` value equals `g_counter` (within the tick). Off: it shows `??`.
- `set_value` on Health with `1` writes 1. Switching Health on freezes it: a direct `/proc` write of 5 reads back 1 within 200 ms.
- Speed through the session: `ceSessionCall set_speed {speed: 2}` → the `--clocks` rate 2.0 ±15% and the `g_abs_sleeps` rate 100/s ±25%. `set_speed 1` → rate 1.0 ±10%.
- `ceSessionEnd`: within 2.5 s, every patched site holds its original bytes, `TracerPid` is 0, the `--clocks` samples never decreased across the end, and `ct-routing.json` counts one native table and one CE table (from the previews).

Expected: every check prints `ok`.

- [ ] **Step 3: Proton program**

`node scripts/live-m4.mjs proton` runs `gold.exe` through `proton runinprefix` with `STEAM_COMPAT_DATA_PATH=$(mktemp -d)/pfx` and `STEAM_COMPAT_CLIENT_INSTALL_PATH=$(mktemp -d)` (Proton 11.0, as in live-m3). If Proton won't start with an empty client dir, fall back to `~/.steam/steam`, which Proton only reads (that is what live-m2/m3 used), and record the fallback. It finds the Linux pid whose comm is `gold.exe` **among its own descendants**. It checks:
- the session for `gold.CT` routes native and opens `mode: 'native'` (module `gold.exe` resolved case-insensitively);
- enabling makes gold grow by 100 per tick; disabling restores `earn`'s bytes, and gold grows by 1;
- `set_speed 2` reports the QPC/tick hooks as `hooked`, and `ceSessionEnd` restores their bytes.

Cleanup runs `wineserver -k` with that prefix's `WINEPREFIX` only. Expected: all `ok`. Record anything Proton-specific.

- [ ] **Step 4: Record results and commit**

Put the outcomes (and anything skipped, with the reason) in the commit body.

```bash
git add scripts/live-m4.mjs
git commit -m "test: live verification for native engine milestone 4

<results>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Full verification and the after-coverage measurement

**Files:**
- Create: `docs/superpowers/coverage/m4-after.json`
- Modify: memory `starlight-native-engine-plan.md` (outside the repo)

- [ ] **Step 1: Full build, lint and suites, once, in sequence**

Run each one after the previous one finishes:
```bash
nice -n 19 pnpm -r build
nice -n 19 pnpm -r lint
nice -n 19 cargo test --manifest-path packages/starlightd/Cargo.toml
nice -n 19 pnpm --filter @starlight/ct-importer test -- --maxWorkers=2
nice -n 19 pnpm --filter @starlight/engine test -- --maxWorkers=2
nice -n 19 pnpm --filter @starlight/indexer test -- --pool=forks --poolOptions.forks.maxForks=2
nice -n 19 pnpm --filter ./apps/desktop test -- --maxWorkers=2
```
Expected: every command exits 0. M2's opt-in `#[ignore]` test stays ignored.

- [ ] **Step 2: After-coverage on the same corpus**

Run: `nice -n 19 node scripts/ct-coverage.mjs --sample 400 --compiler native --assemble --json docs/superpowers/coverage/m4-after.json`
Expected: the same `tables.total` as the baseline (same corpus, no fetching), and `tables.pct` higher than `m4-baseline.json`'s. The spec sets no target. A drop means a compiler bug, which goes back to Task 7/8.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/coverage/m4-after.json
git commit -m "docs: M4 native .CT coverage after the runner

Tables: <baseline>% → <after>% native; records: <baseline>% → <after>%.
Top remaining codes: <…>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Update memory** `starlight-native-engine-plan.md` with the M4 merge, both coverage numbers, the top remaining codes (the next features to build), and the live results.

---

## Follow-ups (later plans)

- The top remaining reason codes from `m4-after.json` are the next native features. `aa:assert`, `aa:readmem` and `sym:mono` (CE's Mono/IL2CPP features, which the spec defers) are the likely leaders.
- Abstime waits through `futex` directly, `timerfd_settime(TFD_TIMER_ABSTIME)` and `timer_settime(TIMER_ABSTIME)` aren't translated (D2). Proton absolute waits in system time aren't scaled by design.
- Session-end landing can leave a step back when a game was sped up by more than 1 s (D3).
- Freeing hook pages (M2 D9) and backward signature extension (M2 D22) are still open.
- Removing CE stays out of project 1 (spec §8).
