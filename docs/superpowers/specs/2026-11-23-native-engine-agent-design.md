# Native Engine + Agent Interface — Design Spec

**Status:** Draft, awaiting approval
**Date:** 2026-11-23
**Scope:** Project 1 of 3 (see §2)

Starlight gets its own Linux-native cheat engine, `starlightd`, which can both
**run** cheats and **find** them. Discovery is exposed to Claude Code / Codex
through a local MCP server, so a player can sit at a game and have an agent find
and build a cheat with them.

---

## 1. Why

Two reasons, both the user's:

1. **Get off Cheat Engine.** CE brings the Patreon nag/trial gate on Linux CE,
   per-game Windows CE inside Proton prefixes, a Wine prefix + ceserver for
   native games, version clamping of `.CT` files, and an opaque Lua bridge. Each
   is a source of failures. Stale tables are the most common reason cheats fail
   today, and Starlight has no way to repair them.
2. **Agent-built cheats.** Let people with Claude/Codex find and create cheats
   with Starlight's tools — eventually shared with everyone, and eventually
   runnable from a button inside Starlight.

## 2. The three projects (order agreed)

1. **This spec — core engine + local agent access.** `starlightd`, discovery
   tools, the MCP server, the player-in-the-loop flow, saving cheats to the
   user's library, and running a growing share of `.CT` tables without CE.
2. **Sharing.** Publishing agent-made cheats to the catalog, with a submission
   path and a trust/verification story. Separate brainstorm later.
3. **In-app agent.** A "find me a cheat" button that runs the same tools with
   the user's own API key. Separate brainstorm later.

Project 1 must not paint 2 and 3 into a corner. Concretely: the cheat format
(§7) is designed for sharing and update-survival now, and every capability the
MCP server exposes is a function of the engine API that the app can also call.

## 3. Goals, non-goals, anti-goals

### Goals
- A native Rust sidecar that attaches to **native Linux and Proton** games
  without injecting anything, and resolves Windows module names
  (`GameAssembly.dll+0x1234`) for Proton games from the Linux side.
- Replace the Frida engine under `engine-host.ts` entirely.
- Discovery: value scans, pointer scans, "what writes / accesses this address",
  disassembly, memory/region inspection.
- An MCP server usable from Claude Code and Codex, where the agent can ask the
  player to do things in-game and the player answers without leaving the game
  (desktop mode first).
- Agent-made cheats saved to the user's library in a format that self-checks and
  is shareable later.
- Run the common Auto Assembler subset of `.CT` tables natively; CE becomes a
  shrinking fallback, and Starlight records *why* each table needed CE.

### Non-goals (project 1)
- Publishing/sharing cheats (project 2) and the in-app agent (project 3).
- New manual discovery UI beyond what exists. The existing `ScannerPanel`
  (first/next scan, today backed by CE) moves onto `starlightd` unchanged in
  look; pointer scans, watchpoints etc. are agent-only in project 1.
- CE Lua API compatibility. Tables whose cheats rely on Lua go to CE.
- Unity IL2CPP / Mono introspection (find fields by name). High value for
  agents; a later milestone, not project 1.
- Windows/macOS support. `starlightd` is Linux-only.
- A full Game Mode (gamescope) overlay. Game Mode gets notifications only.

### Anti-goals (would be failures even if it "works")
- **No multiplayer/online cheating and no anti-cheat evasion.** `starlightd`
  refuses to attach to processes with anti-cheat present (§9). No features
  aimed at hiding from detection.
- **No silent actions on the player's game.** Every agent action is visible in
  Starlight live, and the player can stop it.
- **No regressions for existing users.** CE-backed tables keep working through
  the whole transition.
- **No copying of Cheat Engine source.** Reimplement; CE is a behavioral
  reference only.

## 4. Approaches considered

1. **Rust sidecar, out-of-process (chosen).** `process_vm_readv`/`writev`,
   `/proc/<pid>/maps` + PE-header parsing, ptrace debug registers for
   watchpoints, iced-x86 for disassembly. No injection, fast scanning, reuses the
   existing setcap ptrace grant, one code path for native and Proton. Cost: new
   code; Frida engine retired.
2. **Grow the Frida engine.** Exists and is TypeScript, but injection into Wine
   processes is fragile, in-process JS scanning is slow and can stall the game,
   and Frida is a heavy dependency.
3. **Build on PINCE (GDB-based).** Many features exist, but Python + GDB is slow
   and awkward to bundle, and GPL would bind Starlight.

User chose **1**.

## 5. Architecture

```
 Claude Code / Codex ──MCP (HTTP, localhost)──┐
                                              ▼
                         ┌──────────── Electron main ─────────────┐
 Starlight renderer ◄──► │ engine-host  mcp-host  agent-activity  │
 (activity panel,        │ ct-runner    player-prompt  ce-session │──► CE (fallback)
  prompts, library)      └───────────────┬────────────────────────┘
                                         │ JSON-RPC over Unix socket
                                         ▼
                                    starlightd (Rust, cap_sys_ptrace)
                                         │ process_vm_readv/writev, ptrace
                                         ▼
                                     game process (native or Proton)
```

- **`starlightd`** — Rust binary. Owns all access to game memory. Stateless
  across restarts apart from in-memory scan sessions. Speaks JSON-RPC over a
  Unix domain socket in `$XDG_RUNTIME_DIR` (mode 0600). Started and supervised
  by Electron main.
- **Electron main** owns policy: which process is attached, what the agent may
  do, the activity log, player prompts, the library. The MCP server lives here
  (not in `starlightd`) because it needs the UI, the library and the player.
- **CE stays** behind `ce-session.ts` as a fallback for tables the native runner
  can't handle.

### Source & distribution
`starlightd`'s Rust source lives in this repo (`packages/starlightd`, a Cargo
crate alongside the pnpm workspace). 
CI builds it (with the Rust toolchain pinned in `rust-toolchain.toml`, so the
bytes only change when the code does) and electron-builder bundles it into the
AppImage through `extraResources`. It isn't run from there, because `setcap`
doesn't work on the read-only squashfs: at startup Starlight copies it into its
writable runtime directory (`<runtime>/starlightd/starlightd`), and only when the
bundled binary's sha256 differs from the installed one. (An earlier draft had it
released as an asset and downloaded through the runtime manifest like ceserver;
bundling avoids a manifest update on every release, since the source lives here.) Ptrace permission reuses `grantPtraceCap` (pkexec +
`setcap cap_sys_ptrace=ep`), now pointed at `starlightd`. Reinstalling drops the
capability, so an update re-prompts: only reinstall when the binary's sha256
actually changes, skip the grant entirely when `kernel.yama.ptrace_scope=0`,
and say why in the prompt. A passwordless polkit rule for re-granting was
considered and **rejected**: it would let any user-level malware swap the
binary and get `cap_sys_ptrace`, i.e. root.

The RPC protocol is versioned from milestone 1 (handshake reports protocol
version + capabilities) so the app can tell an old daemon from a new one.

## 6. `starlightd` capabilities

### 6.1 Process & modules
- List processes (reuse the existing noise filtering in `process-host.ts` on the
  TS side; `starlightd` just reports pid/comm/exe/cmdline).
- Attach = open a handle and validate access; **no ptrace stop** for
  read/write/scan.
- Regions from `/proc/<pid>/maps` with permissions.
- Modules: ELF modules from maps; **PE modules for Proton** by finding mapped
  `.dll`/`.exe` files and parsing their PE headers in memory (image base, size,
  sections, exports). Module names resolve case-insensitively, as CE does.
- Game identity: exe name, Proton yes/no (reuse `proton-detect.ts` env
  approach), Steam app id and **build id** (from `appmanifest_<appid>.acf` via
  the existing `vdf.ts`).

### 6.2 Memory
- Read/write typed values and raw bytes; batch reads.
- Freeze loops run inside `starlightd` (not in JS timers), at a configurable
  interval, and are cancelled on detach.
- AOB scan with wildcards, limited to a module or a region set.
- Pointer-chain resolution.
- Code patches always record the original bytes so they can be reverted on
  disable **and on session end**. This fixes today's CE behavior, where ending a
  session leaves code patches in the game.

### 6.3 Discovery
- **Value scan sessions**: first scan (exact, range, unknown initial value) and
  next scan (exact, changed, unchanged, increased/decreased, increased/decreased
  by N). Types: int8–64 (signed/unsigned), float, double, string/bytes. Scan
  results are stored in `starlightd` memory per session id; only counts plus a
  page of results cross the socket.
- **Pointer scan**: find static pointer paths to an address (max depth / max
  offset parameters), and rescan to filter the paths after a game restart.
- **Watchpoints**: "what writes / accesses this address" via x86 debug registers
  (DR0–DR3) set with ptrace on **every thread** of the process. Wine runs each
  game thread as a Linux thread, and threads created after the watch starts
  must also get it. Reports unique instruction addresses + hit counts +
  register snapshots. Time-boxed; always cleaned up on stop or detach.
- **Disassemble** a range (iced-x86), with module+offset annotation.
- **Signature builder**: given an instruction address, produce the shortest
  AOB that is unique in its module, wildcarding relocatable bytes
  (displacements, immediates that look like addresses). Agents can do this by
  hand, but the engine doing it well is the main defense against stale tables.

### 6.4 Code injection (needed for the AA subset and agent-made code cheats)
- Allocate memory near a target (within ±2 GB for rel32 jumps) in the target
  process. Without injection, this uses a ptrace-driven remote syscall (`mmap`)
  on a stopped thread. The process is briefly stopped and must be resumed
  cleanly.
- Assemble x86-64 from Intel-syntax text. **Builder decision**: the library.
  iced-x86 encodes but doesn't parse text, and Keystone parses text but is GPLv2.
  Constraint: CE-style Intel syntax must be accepted, and the license must be
  permissive or otherwise acceptable for distributing `starlightd` (Starlight
  has no LICENSE file yet; treat the dependency choice as needing a permissive
  license unless the user decides otherwise).

### 6.5 Game speed
Speed control (today CE's speedhack) moves to `starlightd` early — milestone 2,
so no native session ever lacks it. Implementation: the remote-alloc +
assembler machinery from §6.4 installs hooks on the game's timing functions
and scales elapsed time by a factor kept in a shared page that Starlight
writes. Proton games: hook the Windows-side functions in the PE modules
(`QueryPerformanceCounter`, `GetTickCount`/`GetTickCount64`, `timeGetTime`,
and `NtQueryPerformanceCounter` if games bypass kernel32). Native games: hook
`clock_gettime`/`gettimeofday` in libc. **Don't** patch the vDSO. Speed 1.0
removes the hooks and restores the original bytes. This is the one feature
that writes code into the game outside of a cheat; it's still done from
outside via ptrace, nothing is loaded as a library.

### 6.6 One engine per game
Only one ptrace tracer per process, and two engines writing the same game is
confusing. Rule: **one engine owns a game at a time.**
- Table sessions: `ct-runner` picks `starlightd` or CE per table (§8).
- Starting an agent session (needs `starlightd`) while a CE session owns the
  game asks the player ("This will close the current Cheat Engine table —
  continue?"), then ends the CE session (which disables its cheats) first.
- Library cheats (agent-made, v2) always run on `starlightd`. If the game's
  page has a CE-owned table active, enabling a library cheat asks the same
  question.

## 7. Cheat format: trainer schema v2

Extends `StarlightTrainerSchema` (`packages/ct-importer/src/starlight-format.ts`)
to `schemaVersion: 2`. v1 files keep loading (v1 → v2 is a pure upgrade).

Additions:
- **`patch` cheat type** — a code cheat: `{ site: AobAddress, enable: Step[],
  disable?: Step[] }`. Steps are `alloc`, `assemble`, `writeBytes` (with
  recorded original bytes), and `registerSymbol`. This is the compiled form
  of the AA subset (§8) and what agents produce for code cheats.
- **`verify` block** — how Starlight checks the cheat still applies before
  enabling it. AOB-addressed cheats: the AOB must match exactly once (implicit,
  always checked). Optional for any cheat: expected bytes and/or a value range
  (e.g. "gold is an int32 between 0 and 10^7"). Failing verify yields a clear
  "this cheat needs updating" state instead of a silent no-op. v1 cheats with
  no verify data are shown as normal (unverified), never as "needs updating".
  `save_cheat` **requires** a value range for agent-made value cheats and an
  AOB site for agent-made `patch` cheats.
- **`provenance`** — `{ kind: 'ct-import' | 'agent' | 'manual', agent?: string,
  createdAt, game: { steamAppId?, buildId?, exeHash? } }`. Build id is what
  later lets sharing say "verified on build N".
- **`metadata.source.convertedFrom`** widens from `'.CT'` to
  `'.CT' | 'starlight'`.

Agent-made cheats must use `aob`, `pointer` or `module` addresses, never
`absolute`. The MCP `save_cheat` tool rejects absolute addresses.

User library: agent-made trainers are stored locally next to the cached
catalog trainers and appear on the game's page alongside catalog cheats,
labeled as the user's own.

## 8. `.CT` tables without CE

`ct-importer` already converts plain records (pointers, module offsets, AOB) and
marks script records `unsupported`. Extend it:

- Parse `AssemblerScript` `[ENABLE]`/`[DISABLE]` sections and compile the
  supported subset into v2 `patch` steps: `aobscanmodule`, `aobscan`, `alloc`
  (incl. near-alloc), `label`, `registersymbol`/`unregistersymbol`,
  `dealloc`, `db`/`dd`/`dq`, `jmp`/`call` to labels, plain instructions, and
  `define`. Anything else (Lua blocks, `{$lua}`, `createthread`, `loadlibrary`,
  `readmem`, `struct`, …) marks the record CE-only with a **specific reason
  code** (e.g. `aa:createthread`, `lua:script`).
- `ct-runner` (new, Electron main) decides per table: if **every** record in
  the table compiles natively → `starlightd`; otherwise the whole table → CE via
  the existing `ce-session.ts` path. No mixing within one table.
- Native tables go through the **same session pipeline and screen** as today:
  table picking (checking candidate tables against the running game),
  automatic prerequisites, the record tree in `CeSessionView` (headers,
  nesting, dropdown values, table hotkeys), the scanner panel and game speed.
  Only the engine behind the session changes, so `ce-session.ts`'s session
  state is generalized into an engine-agnostic session with a CE backend and a
  `starlightd` backend. The CE-specific bits (Lua bridge, Wine/Proton launch)
  stay in the CE backend. The
  decision and reason codes are logged and counted locally, so we can see which
  features keep tables on CE and build those next.
- A **coverage script** runs the importer over the whole catalog and reports
  the % of tables and records that run natively, broken down by reason code.
  Run it before and after each milestone; it's the progress metric for "off
  CE".

The existing CE pieces (`ce-session.ts`, `ce-native.ts`, the ceserver runtime
download) stay until coverage makes them unnecessary. Removing CE completely is
not in project 1.

## 9. Safety

- **Anti-cheat refusal, both engines.** Before attaching — with `starlightd`
  *or* CE — check whether anti-cheat is **actually loaded in the running
  game**: known modules mapped in the process (e.g. `EasyAntiCheat*.dll`,
  `BEClient*.dll`, `EOSSDK` anti-cheat client modules). Files on disk that
  aren't loaded (e.g. a game launched with EAC bypassed) don't count. Proton's
  `PROTON_EAC_RUNTIME` / `PROTON_BATTLEYE_RUNTIME` env vars alone don't count
  either; they're hints for logging only. If loaded: refuse with a plain
  message. No override. The list lives in one data file so it can be updated.
  The user accepted that this may block a few setups that work today.
- **Local only.** The MCP server binds 127.0.0.1 and requires a per-install
  bearer token. `starlightd`'s socket is 0600 and owned by the user.
- **Player approves every attach.** The agent's `attach` call doesn't attach
  by itself: Starlight shows "Claude wants to attach to 9Kings.exe — Allow?"
  (notification + in-app card) and `attach` returns only after the player
  answers (or times out as denied). Until then the agent can only call
  `list_games`. The activity panel opens on approval.
- **Agent permissions.** Other read-only tools are allowed once attached. Writing values,
  code patches, freezes and watchpoints (which pause game threads) are allowed
  only while the session's "Agent can modify the game" switch is on. It's on by
  default once the player approves the attach, and can be flipped off anytime.
- **Stop.** One button (and a hotkey) in Starlight detaches the agent: it
  cancels freezes, removes watchpoints, reverts patches and ends scan sessions.

## 10. Agent interface (MCP)

### Connection
Electron main hosts an MCP server (Streamable HTTP) on a fixed localhost port.
If that port is taken, it falls back to a free port and shows the actual one.
Settings has a **"Connect an agent"** card with copy-paste commands for Claude
Code (`claude mcp add --transport http …` with the token header) and Codex
(config.toml snippet). The server only answers while Starlight is running.

### Tools (first set)
| Tool | Purpose |
|---|---|
| `list_games` | Running processes that look like games, with Proton/app id/build id, anti-cheat status |
| `attach` / `detach` | Attach the agent session to a pid |
| `game_info` | Modules, regions summary, identity |
| `scan_first` / `scan_next` / `scan_results` | Value scan sessions |
| `read` / `write` / `freeze` / `unfreeze` | Typed memory access |
| `pointer_scan` / `pointer_rescan` | Static pointer paths |
| `watch_writes` / `watch_accesses` | Time-boxed watchpoints; returns instruction sites |
| `disassemble` | Annotated disassembly |
| `make_signature` | Unique AOB for an instruction |
| `ask_player` | Ask the player something; blocks until answered (see below) |
| `test_cheat` | Apply a draft v2 cheat, then revert it on request |
| `save_cheat` | Validate (schema + verify block + no absolute addresses) and save to the library |
| `list_cheats` | The game's existing cheats (catalog + library), with verify status, so the agent can repair a broken one instead of starting over |

Tool results are compact. Big result sets are paged, with counts first. Every
tool call shows up in the activity panel.

The server also ships MCP **instructions** and a `find-a-cheat` **prompt** that
teach the workflow: scan → ask player → rescan → pointer scan or watchpoint →
signature → test → save. A good default playbook matters as much as the tools.

### Player in the loop (desktop mode first)
`ask_player({ question, answer: 'number' | 'confirm' | 'choice', choices? })`:
- Shows a **desktop notification** with the question, and the question also
  appears in Starlight's activity panel with an input.
- `confirm` questions can be answered with a **global hotkey** (default
  configurable, through the existing `hotkey-host`/Wayland hotkey path), so
  "did your gold change? / done, rescan" never needs alt-tab.
- `number` answers need typing: the player alt-tabs to Starlight, which
  focuses the input. Alt-tabbing to the agent's terminal also works.
- Game Mode: notification only. A proper overlay is future work.
- Times out after a configurable period (default 5 min) and returns
  "no answer" so the agent can re-ask.

The agent may also ask in its own chat, as a normal conversation. `ask_player`
exists so the player doesn't have to watch the terminal.

### Activity panel
A Starlight view per agent session: a live list of tool calls (scan counts,
writes with old → new values, patches, watchpoints), pending questions, the
"Agent can modify the game" switch and **Stop**. Follows the established visual
direction (lighter, polished, centered, animated).

## 11. Milestones

Each one ships on its own and leaves Starlight working.

1. **Engine core.** `starlightd` (in-repo crate, versioned protocol) with
   attach, modules (incl. PE-in-Wine), read/write/freeze, AOB, pointer
   resolve; runtime download + setcap grant; `engine-host.ts` switched to it;
   Frida removed. Anti-cheat refusal on both engines.
2. **Discovery + speed.** Value scans (and `ScannerPanel` moved onto them),
   pointer scans, watchpoints, disassembly, signature builder; remote alloc +
   assembler (§6.4) and game speed (§6.5) built on it.
3. **Agent interface.** MCP server, attach approval, `ask_player` + hotkey +
   notifications, activity panel, schema v2 with `verify`/`provenance`, save
   to library, Settings connect card, one-engine-per-game rule.
4. **Native `.CT` runner.** AA-subset compiler, engine-agnostic session with
   CE and `starlightd` backends, `ct-runner` routing with reason codes,
   coverage script.

## 12. Success criteria

- **E2E on `packages/engine/test-target`** (native) and a **real Proton game**
  (9 Kings, per the existing live-testing recipe): in desktop mode, Claude Code
  finds a value cheat with the player answering via notification/hotkey, saves
  it, and it toggles correctly from Starlight's normal trainer UI after a game
  restart.
- A **code cheat** found via `watch_writes` + `make_signature` is saved as a v2
  `patch`, enables, and disables cleanly (original bytes restored); ending the
  session also reverts it.
- Frida is gone from dependencies; existing catalog `freeze`/`set`/`toggle`
  cheats work through `starlightd`.
- The coverage script shows native-runnable tables rising after milestone 4
  (baseline measured first; no fixed target).
- Game speed works on a native session for a Proton game and a native game,
  and returning to 1.0 restores the original bytes.
- A process with anti-cheat loaded is refused by both engines; the same game
  launched with anti-cheat not loaded is allowed.
- No leaked state after Stop/detach: no freezes, watchpoints, ptrace
  attachments or patches remain.

## 13. Decided vs. left to the builder

**Decided with the user:** order of the three projects; Rust out-of-process
sidecar; player-in-the-loop interaction; desktop mode first, Game Mode via
notifications; CE as a shrinking fallback; anti-cheat refusal applies to both
engines (only when actually loaded); game speed built early (milestone 2).

**Proposed by me (open to correction):** MCP hosted in Electron main over
localhost HTTP + token; `ask_player` with notification + hotkey; schema v2 shape;
the AA subset list; existing scanner panel moved to `starlightd` but no new
manual discovery UI; a table runs natively only if all its records do; native
tables keep today's session pipeline and screen; one engine per game; player
approves every agent attach; `starlightd` source in this repo; verify rules
in §7; no passwordless re-grant; IL2CPP/Mono introspection deferred.

**Left to the builder:** RPC framing details, the assembler library (within the
license constraint), pointer-scan algorithm and limits, watchpoint time-box
defaults, the default MCP port and hotkey, how the activity panel looks within
the visual direction, the exact anti-cheat signature list.
