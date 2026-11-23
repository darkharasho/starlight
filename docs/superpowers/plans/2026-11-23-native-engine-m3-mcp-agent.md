# Native Engine — Milestone 3 (Agent Interface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code and Codex find and build cheats with the player through a local MCP server in Electron main, with player approval for every attach, `ask_player` over notifications and hotkeys, a live activity panel with Stop, trainer schema v2 (`verify`, `provenance`, `patch` cheats), the user's own cheat library on the game's page, a Settings connect card, and the one-engine-per-game rule.

**Architecture:** Electron main hosts an MCP Streamable HTTP server on `127.0.0.1` with a per-install bearer token. Each tool is a thin wrapper over `@starlight/engine` (M2's API). A single **agent session** owns the agent's starlightd handle, gates tools by tier (open / attached / modify), records everything it changes so Stop can undo it, and feeds an activity log that the renderer shows. Running and verifying v2 cheats lives in `@starlight/engine` (`cheats.ts`), so the agent's `test_cheat`, the agent's `save_cheat` check and the game page's "My cheats" all use one runner. A small **game owner** registry in main enforces one engine per game: CE owns a game while a CE table session is live on it; starlightd owns it while the agent or the user's own cheats are on it, and the game page then shows the CE table as paused instead of launching CE.

**Tech Stack:** TypeScript, Node 20, Electron 32, React + zustand, zod 3.25, vitest, `@modelcontextprotocol/sdk` 1.x (MIT, new dependency), M2's `starlightd` (protocol 2) and `@starlight/engine`. Live checks use Proton 11.0 and `x86_64-w64-mingw32-gcc`, as in M2.

**Spec:** `docs/superpowers/specs/2026-11-23-native-engine-agent-design.md`: milestone 3 of §11, covering §5 (MCP host in main), §6.1 (game identity, owed since M1), §6.6, §7, §9 and §10. M1 (`docs/superpowers/plans/2026-11-23-native-engine-m1-core.md`) and M2 (`docs/superpowers/plans/2026-11-23-native-engine-m2-discovery-speed.md`) define the daemon and the engine API this plan builds on.

## Global Constraints

- **No anti-cheat evasion, no features aimed at hiding from detection, no multiplayer features.** Nothing in M3 adds network, packet or online-mode tooling.
- **Anti-cheat refusal stays enforced on every attach path**: the game page (CE and starlightd), `engine-host`, `scanner-host`, `user-cheats-host` and the agent's `attach`. The agent's `attach` checks before asking the player and again right before attaching. Modify-tier agent tools and enabling a user cheat check again first. A hit refuses with `antiCheatMessage(hit)`. There is no override.
- **The agent can only touch a game after the player approves the attach in the app.** Before approval, only `list_games` and `attach` run, and `attach` only asks.
- Writing values, freezes, watchpoints, code patches (`test_cheat`) and game speed need the session's **"Agent can modify the game"** switch. It is on by default after approval, and the player can turn it off at any time. Turning it off reverts everything the agent changed.
- **No silent actions.** Every agent tool call is an activity entry. Stop (button and hotkey) cancels freezes, stops watches, reverts test cheats, restores speed hooks, ends scans and pointer scans, and detaches.
- The MCP server binds **127.0.0.1 only** and requires `Authorization: Bearer <token>`. The token is per install, in `<userData>/agent-token` (mode 0600), never in `config.json`. Requests with an `Origin` header, or a `Host` other than `127.0.0.1:<port>` / `localhost:<port>`, get 403.
- **Agent-made cheats never use `absolute` addresses.** `save_cheat` validates the schema, requires `verify.range` for value cheats and an AOB `site` for `patch` cheats, and refuses a cheat that verify says needs updating on the running game.
- Schema v1 trainer files keep loading. v1 → v2 is a pure upgrade, and v1 cheats without verify data are never shown as "needs updating".
- **One engine per game** (spec §6.6, D6 below). Starlight never closes a CE table without the player's confirmation (approval card or confirm bar). CE tables keep working for players who never use the agent or their own cheats.
- UI follows the established visual direction: the graphite-blue theme in `tailwind.config.ts`, Figtree, 13–14 px text, rounded panels and pills, `animate-rise` entrances. No near-black backgrounds, neon glows or tracked all-caps labels.
- New runtime dependency: `@modelcontextprotocol/sdk` (MIT) in `apps/desktop` **dependencies** (main externalizes it; electron-builder must ship it). No other new runtime dependencies.
- Tests: vitest with at most 2 workers. Always pass `--maxWorkers=2`. Main-process tests start with `// @vitest-environment node`.
- Live checks only touch processes the task launches itself: the C test target, or a Windows test program under Proton with a **throwaway** `STEAM_COMPAT_DATA_PATH`. **Never a game the user is running** (the user plays games, including online ones, alongside dev work). The dev app runs with a temporary `XDG_CONFIG_HOME` and `--remote-debugging-port=9223`. Live Claude runs use `--mcp-config <tmp> --strict-mcp-config`, never `claude mcp add`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A web page or another local program talks to the MCP port** (DNS rebinding, CSRF from a browser tab). Expected: a request with an `Origin` header or a foreign `Host` gets 403 before any MCP handling, a missing or wrong token gets 401, and the token compare is constant-time. The tests are in Task 7 (`rejects requests that carry an Origin header (403)`, `rejects a foreign Host header (403)`, `rejects a missing or wrong token (401)`).
2. **The game exits, or the engine connection drops, mid-session**, while a question is pending or a watch runs. Expected: the session ends with an activity entry, a pending `ask_player` resolves `{ answered: false, reason: "stopped" }`, the next tool call says "Not attached…", and nothing throws. The tests are in Task 9 (`game exit ends the session and logs it`, `engine connection close ends the session`) and Task 10 (`Stop resolves the pending question as stopped`).
3. **The player presses Stop, or turns the switch off, while a modify tool is in flight.** For example, a freeze is created after Stop already cleaned up. Expected: the in-flight tool's result is reverted at once and it returns "Stopped by the player before this finished; nothing was left running." The tests are in Task 9 (`an item tracked after Stop is reverted at once`) and Task 13 (`freeze created after the switch went off is cancelled`).
4. **Anti-cheat loads after the player approved** (games often map EAC late). Expected: the next modify-tier call stops the session and returns the anti-cheat message. The test is in Task 9 (`anti-cheat appearing later stops the session on the next modify-tier call`).
5. **A saved cheat after a game update** (AOB gone or no longer unique, value out of range, code bytes changed). Expected: a "Needs updating" state with reasons, and enabling refuses. It is never a silent no-op. The tests are in Task 2 (`aob that matches twice needs updating`, `patch with a changed original byte needs updating and writes nothing`) and Task 5 (`a cheat that needs updating refuses to enable with the reasons`).

---

## Decisions made while planning

| # | Decision | Reason |
|---|---|---|
| D1 | **MCP SDK:** `@modelcontextprotocol/sdk` 1.x (`McpServer`, `StreamableHTTPServerTransport`) over a plain `node:http` server. Stateful sessions (`sessionIdGenerator: randomUUID`) with one `McpServer` per MCP session, as the SDK's examples do. Results are compact JSON text (`content: [{ type: 'text', text }]`), with no `outputSchema`. | MIT, the reference implementation, zod 3.25 compatible (peer `^3.25 \|\| ^4`). JSON text keeps results small (spec §10: "compact"). |
| D2 | **Default port 47771.** If it's taken, fall back to an OS-assigned port and show it (`portIsFallback`). | The spec leaves the port to the builder. |
| D3 | **Token in `<userData>/agent-token`** (32 random bytes, base64url, mode 0600). Settings can rotate it, which closes every MCP session. | `config.json` goes into backups and bug reports, and the renderer reads it wholesale. |
| D4 | **One agent session at a time, owned by one MCP session.** Tools from any other MCP session are refused ("Another agent (Claude) is attached to …"). When the owning MCP session closes (DELETE or transport close), the agent session stops. There is no idle timeout. | One activity panel, one Stop. If the agent goes away, its changes must not linger. The agent may sit idle while the player plays. |
| D5 | **Tiers:** `open` = `list_games`, `attach`. `attached` = every read-only tool plus `ask_player`, `save_cheat`, `list_cheats`, `detach`, `unfreeze` and `test_cheat` revert (undoing is always allowed). `modify` = `write`, `freeze`, `watch_writes`, `watch_accesses`, `set_speed`, `test_cheat` apply. Watchpoints are modify-tier because they pause game threads (spec §9). | Spec §9. |
| D6 | **One engine per game.** CE owns a pid while a CE session with a live bridge is attached to it. starlightd owns a pid while it has a **holder**: `agent` (attached session) or `user-cheats` (at least one user cheat on). starlightd's read/write/scan/freeze (no ptrace) may coexist with CE, as M2's scanner already does. ptrace features (watch, alloc, patch, speed) are never used on a CE-owned pid, because the agent and user cheats **claim** the pid first, which ends CE's table after the player confirms. When a CE session starts on a starlightd-owned pid, it opens in **starlightd mode**: CT records come from the file (no CE launch), the table shows as paused, and the scanner and game speed run on starlightd. | Answers M2's open question (CE vs starlightd ptrace) and keeps the game page usable while the player's own cheats run. |
| D7 | **Cross-connection patch overlap needs no daemon change.** Every desktop user of starlightd (`engine-host`, `scanner-host`, `user-cheats-host`, the agent) shares `getEngineClient()`'s single connection with its own handle, so M2's per-connection `Patches` overlap check (`-32014`) already covers all of them. Other connections are test scripts only. | The rule in D6 keeps CE out, and one connection keeps one overlap table. |
| D8 | **`patch` steps:** `alloc { name, size, near? }`, `assemble { at, source }`, `writeBytes { at, bytes, original? }`, `registerSymbol { name, at }`. `at` and `near` are symbol expressions (`name`, `name+hex`, `name-hex`; hex without or with `0x`). The symbols are `site` (the AOB match), `address` (value cheats), alloc names, labels from earlier `assemble` steps and registered names. Each `assemble` and `writeBytes` is written with the engine's recorded `patch()`. **Disable = revert the enable's patches, newest first. Allocations stay (M2 D9).** A `disable` list is accepted by the schema for M4's AA compiler, but `validateAgentCheat` rejects it and the M3 runner refuses cheats that have one ("needs the native table runner"). | Recorded originals make explicit disable steps redundant for agent cheats. M4 owns `[DISABLE]` semantics. |
| D9 | **Verify rules.** A cheat **with** a `verify` block (even `{}`) is checked: AOB addresses/sites must match exactly once, `verify.range` must hold for the current value, `verify.bytes` patterns must match, and `writeBytes.original` must equal the current bytes. A cheat **without** `verify` is `unverified` and never `needs-update` (v1 imports). `save_cheat` always writes a `verify` block. `verify.bytes[].at` defaults to `address` (value) or `site` (patch). | Spec §7, without ever flagging old v1 cheats. |
| D10 | **`provenance` is per cheat** (`{ kind, agent?, createdAt, game: { steamAppId?, buildId?, exeHash? } }`). Main fills it in on `save_cheat`; the agent never supplies it. The importer doesn't set it (`convertedFrom: '.CT'` already says where a cheat came from). | A library trainer collects cheats from different sessions and builds. |
| D11 | **User library:** one v2 trainer per game at `<userData>/user-cheats/<key>.json` (id `user-<key>`, `convertedFrom: 'starlight'`, author `You`, default category `My cheats`). `key` = `gameKey(name)`, the same key the game page uses (`cacheKey`, with `tools-` stripped). | It sits next to the catalog caches but outside them, since caches may be cleared. One key scheme for agent and page. |
| D12 | **Game identity:** name from the catalog match (`identifyProcess`), else the installed game for the Steam app id, else the exe name. Steam app id from the Proton compatdata path, or `SteamAppId`/`SteamGameId` in the environment for native games. Build id from `<steamapps>/appmanifest_<appid>.acf` `AppState.buildid`. `exeHash` = sha256 of the game's exe file (Proton: the mapped `.exe` whose basename equals the process's exe name; native: `/proc/<pid>/exe`), or `null` above 1 GiB. | Spec §6.1. Hashing a 4 GB exe on every save would stall main. |
| D13 | **Timeouts:** approval 120 s (`agent.approvalTimeoutSec`), `ask_player` 300 s (`agent.askTimeoutSec`, per-call `timeout_s` 10–3600). Watch `duration_ms` 1000–60000, default 10000 (M2 D21). At most 8 live test cheats. At most one pending question. | The spec fixes 5 min for questions and leaves the rest to the builder. |
| D14 | **Default hotkeys:** Yes `Ctrl+Shift+Y`, No `Ctrl+Shift+N`, Stop `Ctrl+Shift+End`, registered through `hotkey-host`'s uiohook path. Yes/No are live only while a `confirm` question is pending, and Stop only while an agent is attached. | Spec §10 leaves the default to the builder. Unlikely to collide with game binds or the numpad keys cheats get. |
| D15 | **Notifications** use Electron's `Notification` (libnotify on Linux). Clicking one focuses Starlight and opens the agent view. There are no action buttons (Electron supports them only on macOS), so confirm answers come from the hotkey or the in-app card. | Spec §10's desktop-mode design. |
| D16 | **Extra tools beyond the spec's first set:** `pointer_results` (paging, spec §10 "big result sets are paged"), `set_speed` (the activity panel shows speed, per M2's follow-up), and `test_cheat` `action: 'revert'` (the spec's "revert it on request"). `test_cheat` validates drafts like `save_cheat` (absolute addresses rejected) but doesn't require `verify.range`. | Everything the agent tests can then be saved. |
| D17 | **Client label:** MCP `clientInfo.name` matching `/claude/i` → "Claude", `/codex/i` → "Codex", anything else → the name, or "An agent" when it's empty. `provenance.agent` = `"<clientInfo.name> <clientInfo.version>"`. | The approval copy is "Claude wants to attach to 9Kings.exe — Allow?". |
| D18 | **Speed on the game page in starlightd mode** goes to `scanner-host` (`speed_set`, on its handle). In CE mode, M2's D24 still holds (CE's speedhack). | Once CE is closed, nothing else can change speed, and M2's reason for keeping it on CE no longer applies. |

---

## File Structure

**`packages/ct-importer/`**
- `src/starlight-format.ts`: v1 and v2 schemas, `upgradeTrainer`, `patch` cheats, `verify`, `provenance`, `isValueCheat` / `isPatchCheat`
- `src/agent-cheat.ts` (new): `AgentCheatDraftSchema`, `validateAgentCheat`
- `src/ct-importer.ts`: emits `schemaVersion: 2`
- `test/starlight-format.test.ts`, `test/agent-cheat.test.ts` (new), `test/ct-importer.test.ts`

**`packages/engine/`**
- `src/cheats.ts` (new): address expressions, `verifyCheat`, `enableCheat`
- `src/errors.ts` (`NeedsUpdateError`), `src/types.ts` (`VerifyResult`), `src/index.ts`, `package.json` (devDependency `@starlight/ct-importer`), `README.md`
- `test/cheats.test.ts` (new)

**`packages/engine/test-target/win/`**: `gold.c` (new), `Makefile` (adds `gold.exe`)

**`apps/desktop/src/shared/`**: `game-key.ts` (new), `ipc.ts`

**`apps/desktop/src/main/`**
- `game-identity.ts`, `game-owner.ts`, `game-owner-singleton.ts`, `user-cheats.ts`, `user-cheats-host.ts` (new)
- `agent/mcp-host.ts`, `agent/token.ts`, `agent/connect-info.ts`, `agent/server.ts`, `agent/tools.ts`, `agent/instructions.ts`, `agent/session.ts`, `agent/activity.ts`, `agent/player-prompt.ts`, `agent/notifier.ts`, `agent/tools-session.ts`, `agent/tools-ask.ts`, `agent/tools-discovery.ts`, `agent/tools-modify.ts`, `agent/tools-library.ts` (new)
- `ce-session.ts`, `scanner-host.ts`, `hotkey-host.ts`, `user-config.ts`, `engine-host.ts`, `index.ts`
- `../preload/index.ts`

**`apps/desktop/src/renderer/`**
- `stores/user-cheats-store.ts`, `stores/agent-store.ts`, `components/ce/MyCheatsSection.tsx`, `components/settings/ConnectAgentCard.tsx`, `components/agent/ApprovalCard.tsx`, `components/agent/QuestionCard.tsx`, `components/agent/ActivityList.tsx`, `routes/AgentRoute.tsx` (new)
- `components/ce/CeSessionView.tsx`, `stores/ce-session-store.ts`, `routes/SettingsRoute.tsx`, `routes/ActiveTrainerRoute.tsx`, `stores/trainer-store.ts`, `lib/dedupe-games.ts`, `components/Sidebar.tsx`, `App.tsx`

**`scripts/live-m3.mjs`** (new)

---

## MCP tools (shared reference for Tasks 7–14)

Addresses in tool inputs are **address expressions**: `"0x7ff6a1b2c3d4"`, `"<module>+<hex>"` (`"target+0x4010"`, `"GameAssembly.dll+1A2B"`), or a quoted module name (`"\"My Game.exe\"+10"`). Addresses in results are lowercase `"0x…"`, with `where: "<module>+0x<off>" | null` next to them. Value types are the engine's `ValueType`. Scan types are `ScanType`. Values are strings, as in M2 D19.

| Tool | Tier | Input | Result |
|---|---|---|---|
| `list_games` | open | `{ all?: boolean }` | `{ games: [{ pid, name, proton, steamAppId: number\|null, buildId: string\|null, antiCheat: string\|null, attached: boolean }] }` |
| `attach` | open | `{ pid: int }` | `{ attached: true, game: { pid, name, proton, steamAppId, buildId }, canModify: boolean }` |
| `detach` | attached | `{}` | `{ detached: true }` |
| `game_info` | attached | `{ modules_offset?: int≥0 = 0, modules_limit?: 1–200 = 40 }` | `{ pid, name, proton, steamAppId, buildId, exeHash, modules: { count, items: [{ name, base, size, kind }] }, regions: { count, writableMiB, executableMiB } }` |
| `scan_first` | attached | `{ type, mode: FirstScanMode, value?, min?, max?, encoding? }` | `{ scan, count, results? }`, with `results` (Result[]) only when `count ≤ 50` |
| `scan_next` | attached | `{ scan: int, mode: NextScanMode, value?, min?, max? }` | `{ count, results? }` (same rule) |
| `scan_results` | attached | `{ scan: int, offset?: int = 0, limit?: 1–500 = 50 }` | `{ count, results: [{ address, where, value: string\|null }] }` |
| `read` | attached | `{ address, type: ValueType \| 'bytes', length?: 1–4096 }` (`length` required for `bytes`/`string`) | `{ address, where, value }` (`bytes` → hex) |
| `write` | modify | `{ address, type: ValueType minus 'string', value: string }` | `{ address, where, old, new }` |
| `freeze` | modify | `{ address, type, value: string, interval_ms?: 20–1000 = 100 }` | `{ freeze: int, address }` |
| `unfreeze` | attached | `{ freeze: int }` | `{ unfrozen: true }` |
| `pointer_scan` | attached | `{ address, max_depth?: 1–7 = 5, max_offset?: hex ≤ "0x10000" = "0x1000", modules?: string[] }` | `{ id, count, truncated, paths: Path[] }` (first 20) |
| `pointer_results` | attached | `{ id: int, offset?: int = 0, limit?: 1–200 = 50 }` | `{ count, paths: Path[] }` |
| `pointer_rescan` | attached | `{ id: int, address? }` | `{ count, paths: Path[] }` (first 20) |
| `watch_writes` / `watch_accesses` | modify | `{ address, size?: 1\|2\|4\|8 = 4, duration_ms?: 1000–60000 = 10000, include_registers?: boolean = false }` | `{ reason, total_sites, sites: [{ address, where, text, count, registers? }] }` (≤ 20, by count desc). Blocks until the watch ends. |
| `disassemble` | attached | `{ address, count?: 1–100 = 20 }` | `{ instructions: [{ address, where, bytes, text, target?: { address, where } }] }` |
| `make_signature` | attached | `{ address, max_length?: 8–128 = 64 }` | `{ pattern, module, length, unique, matches, aob: { kind: 'aob', module, pattern } }` |
| `ask_player` | attached | `{ question: 1–300 chars, answer: 'number'\|'confirm'\|'choice', choices?: 2–6 strings ≤ 40 chars, timeout_s?: 10–3600 }` | `{ answered: true, answer: number\|boolean\|string }` or `{ answered: false, reason: 'timeout'\|'stopped' }` |
| `set_speed` | modify | `{ speed: 0.1–10 }` | `{ speed, hooks: [{ name, status, reason? }] }` |
| `test_cheat` | modify (apply), attached (revert) | `{ action: 'apply'\|'revert', cheat?: object, value?: number, test?: int }` | apply → `{ test, verify: VerifyResult, address }`; revert → `{ reverted: true }` |
| `save_cheat` | attached | `{ cheat: object, replaces?: string, category?: string ≤ 40 }` | `{ saved: { id, name, game }, verify: VerifyResult }` |
| `list_cheats` | attached | `{ source?: 'all'\|'library'\|'catalog' = 'all', offset?: int = 0, limit?: 1–200 = 50 }` | `{ game: { key, name, buildId }, library: { count, cheats: [{ id, name, type, verify, cheat }] }, catalog: { count, cheats: [{ id, name, type?, address?, unsupported?: string, verify }] } }` |

- `Path = { module, base, offsets: string[], text: "target+0x4010 → 0x18 → 0x10" }`. `VerifyResult = { status: 'ok'|'needs-update'|'unverified', reasons: string[] }`.
- Every tool sets MCP `annotations.readOnlyHint = tier !== 'modify'`.
- **Refusal copy** (exact, raised as `ToolError`, returned as `isError: true` text):
  - `NOT_ATTACHED` = `Not attached to a game. Call list_games, then attach (the player has to approve it).`
  - `MODIFY_OFF` = `The player has turned off "Agent can modify the game". Read-only tools still work; ask the player to turn it back on.`
  - `OTHER_AGENT(label, game)` = `Another agent (${label}) is attached to ${game}. The player can stop it in Starlight.`
  - `DECLINED` = `The player declined. Don't retry unless they ask you to.`
  - `NO_ANSWER` = `No answer from the player within 2 minutes, so the attach was not allowed. Ask them in chat before trying again.` (the minutes come from `approvalTimeoutSec`)
  - `STOPPED_MIDWAY` = `Stopped by the player before this finished; nothing was left running.`
  - `QUESTION_WAITING` = `A question is already waiting for the player.`
- Engine errors map to text through `describeEngineError(err)`: `ProcessNotFound` → `The game has exited.`, `Busy` → `The engine is busy with this game; try again in a moment.`, `PermissionDenied` or `PtraceFailed` → `Starlight doesn't have permission to debug this game yet: ${err.message}. The player can click Allow on the game's page.`, `PatchConflict` → `That code is already patched: ${err.message}`, `NeedsUpdateError` → `This cheat needs updating: ${reasons.join('; ')}`, anything else → `err.message`.

---

### Task 1: Trainer schema v2 (`verify`, `provenance`, `patch` cheats) and agent-cheat validation

**Files:**
- Modify: `packages/ct-importer/src/starlight-format.ts`, `src/index.ts`, `src/ct-importer.ts` (emit v2), `test/starlight-format.test.ts`, `test/ct-importer.test.ts`
- Create: `packages/ct-importer/src/agent-cheat.ts`, `test/agent-cheat.test.ts`
- Modify (type fallout, `isValueCheat` instead of the local `isSupported` helpers): `apps/desktop/src/main/engine-host.ts`, `src/main/hotkey-host.ts`, `src/renderer/routes/ActiveTrainerRoute.tsx`, `src/renderer/stores/trainer-store.ts`; `packages/indexer` tests only where they assert a parsed trainer's `schemaVersion`

**Interfaces:**
- Produces (`@starlight/ct-importer`):
  - `StarlightTrainerSchemaV1` (today's object schema, unchanged) and `StarlightTrainerSchemaV2`. `StarlightTrainerSchema = z.union([StarlightTrainerSchemaV2, StarlightTrainerSchemaV1]).transform(upgradeTrainer)`, so `StarlightTrainer` is the v2 output type.
  - `upgradeTrainer(t: V1 | V2): V2`: sets `schemaVersion: 2` and copies everything else unchanged.
  - V2 differences: `metadata.source.convertedFrom: z.enum(['.CT', 'starlight'])`. Cheat = `ValueCheat | PatchCheat | UnsupportedCheat`. `ValueCheat` = today's `SupportedCheat` plus `verify?: Verify` and `provenance?: Provenance`.
  - `PatchCheat = { id, name, description?, type: 'patch', site: AobAddress, enable: PatchStep[] (min 1), disable?: PatchStep[], verify?: Verify, provenance?: Provenance, hotkeys?: Hotkeys, unsupported?: false }`.
  - `PatchStep` (discriminated by `op`): `{ op: 'alloc', name: Ident, size: int 1–65536, near?: string }` | `{ op: 'assemble', at: string, source: string (≤ 16384 chars) }` | `{ op: 'writeBytes', at: string, bytes: Hex, original?: Hex }` | `{ op: 'registerSymbol', name: Ident, at: string }`. `Ident = /^[A-Za-z_][A-Za-z0-9_]*$/`; `Hex = /^([0-9a-fA-F]{2})+$/`.
  - `Verify = { bytes?: Array<{ at?: string; expect: string /* AOB pattern, ?? allowed */ }>; range?: { min: number; max: number } }`
  - `Provenance = { kind: 'ct-import' | 'agent' | 'manual'; agent?: string; createdAt: string /* ISO datetime */; game: { steamAppId?: number; buildId?: string; exeHash?: string } }`
  - Types: `StarlightValueCheat` (alias of `StarlightSupportedCheat`, which keeps its name), `StarlightPatchCheat`, `StarlightPatchStep`, `StarlightVerify`, `StarlightProvenance`, `StarlightAobAddress`. Guards: `isValueCheat(c: StarlightCheat): c is StarlightValueCheat`, `isPatchCheat(c): c is StarlightPatchCheat`.
  - `agent-cheat.ts`: `AgentCheatDraft` = a value cheat or patch cheat **without** `id` or `provenance`. `validateAgentCheat(draft: unknown, o?: { forTest?: boolean }): { ok: true; cheat: AgentCheatDraft } | { ok: false; errors: string[] }`. zod issues format as `"<path>: <message>"`. Rule errors (exact):
    - `address: agent-made cheats can't use absolute addresses; use an aob, pointer or module address`
    - `address: a pointer needs a module base (module + offsets)`
    - `verify.range: value cheats need a value range, e.g. { "min": 0, "max": 10000000 }` (skipped when `forTest`)
    - `verify.range: min must not be greater than max`
    - `disable: leave disable out; Starlight reverts the enable steps itself`
    - `valueType: string values can't be cheats yet`
    - `enable: at most 32 steps`
    - `enable[N].name: "site" and "address" are reserved`
- Desktop fallout: TrainerView renders a patch cheat through `UnsupportedCheatCard` with reason `Code cheat: open the game's page to use it`. `engine-host`'s `findCheat` and `hotkey-host` only consider `isValueCheat` cheats.

- [ ] **Step 1: Write the failing tests**

`starlight-format.test.ts`:
```ts
it('loads a v1 file and upgrades it to schemaVersion 2 unchanged otherwise', ...)  // parse(v1).schemaVersion === 2; categories deep-equal the input's
it('accepts a v2 patch cheat with alloc/assemble/writeBytes/registerSymbol steps', ...)
it('accepts convertedFrom "starlight"', ...)
it('rejects a patch site that is not an aob address', ...)                          // site { kind:'module', ... } → throws
it('rejects writeBytes with odd-length hex', ...)
it('isValueCheat/isPatchCheat tell the three cheat kinds apart', ...)
it('every catalog trainer in packages/catalog/trainers still parses', ...)          // readdirSync + parse each
```
`agent-cheat.test.ts`:
```ts
it('accepts a pointer value cheat with a range', ...)
it('rejects an absolute address with the exact message', ...)                         // errors contains the absolute-address line
it('rejects a pointer without a module', ...)
it('requires verify.range for value cheats unless forTest', ...)
it('rejects min > max', ...)
it('rejects a patch cheat with disable steps', ...)
it('rejects reserved step names and more than 32 steps', ...)
it('rejects string value cheats', ...)
it('reports zod issues as "path: message"', ...)                                      // { name: '' } → 'name: …'
```
`ct-importer.test.ts`: the importer's output has `schemaVersion: 2`.

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 starlight-format agent-cheat ct-importer`
Expected: FAIL (no v2 schema, no `agent-cheat` module).

- [ ] **Step 3: Implement** per the Interfaces block. `isValueCheat(c)` is true when `c` is not unsupported and `c.type !== 'patch'`.

- [ ] **Step 4: Run tests and see them pass, then check the consumers**

Run: `pnpm --filter @starlight/ct-importer build && pnpm --filter @starlight/ct-importer test -- --maxWorkers=2 && pnpm --filter @starlight/catalog build && pnpm --filter @starlight/indexer test -- --maxWorkers=2 && pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2`
Expected: all pass. Desktop lint is clean after the `isValueCheat` changes.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer packages/indexer apps/desktop/src
git commit -m "feat(ct-importer): trainer schema v2 with verify, provenance and patch cheats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Engine: verify and run v2 cheats

**Files:**
- Create: `packages/engine/src/cheats.ts`, `packages/engine/test/cheats.test.ts`
- Modify: `packages/engine/src/errors.ts`, `src/types.ts`, `src/index.ts`, `package.json` (devDependency `"@starlight/ct-importer": "workspace:*"`, used for types only), `README.md` ("Running cheats" section)

**Interfaces:**
- Consumes: `aobScan`, `resolvePointerChain`, `read`, `readMany`, `freeze`, `assemble`, `alloc`, `patch`, `listModules`, `Session` (M1/M2). Types `StarlightCheat`, `StarlightValueCheat`, `StarlightPatchCheat`, `StarlightAddress` (Task 1, `import type` only).
- Produces:
  - `types.ts`: `interface VerifyResult { status: 'ok' | 'needs-update' | 'unverified'; reasons: string[] }`.
  - `errors.ts`: `class NeedsUpdateError extends EngineError { readonly reasons: string[] }`. Its message is `this cheat needs updating: ${reasons.join('; ')}`.
  - `parseAddressExpr(expr: string): { module: string | null; offset: bigint } | null`. Hex without a prefix is accepted after `+`/`-`. A bare number needs `0x`.
  - `resolveAddressExpr(s: Session, expr: string): Promise<string>`. A module expression goes through `resolvePointerChain(s, { module, baseAddress: '0x<off>', offsets: [] })`. A missing module → `ScanError` (code `ModuleNotFound`).
  - `resolveCheatAddress(s: Session, a: StarlightAddress): Promise<string>` (aob: the first match plus `offset`).
  - `verifyCheat(s: Session, cheat: StarlightCheat): Promise<VerifyResult>` (D9). Reason strings (exact):
    - `the AOB pattern isn't in ${module} any more`
    - `the AOB pattern matches ${n} places in ${module}; it must match exactly one`
    - `${module} isn't loaded`
    - `can't read the value at ${address}`
    - `the value is ${v}, outside ${min}–${max}`
    - `the bytes at ${at} are ${actual}, expected ${expect}`
    - `the code at ${at} changed (now ${actual}, expected ${original})`

    Unsupported cheats → `unverified`, no reasons.
  - `enableCheat(s: Session, cheat: StarlightValueCheat | StarlightPatchCheat, o?: { value?: number; intervalMs?: number }): Promise<RunningCheat>`. It verifies first and throws `NeedsUpdateError` on `needs-update`.
    - Value cheats: a freeze at `o.value ?? cheat.value ?? cheat.default ?? 0`, `intervalMs` default 50 (as in `engine-host`).
    - Patch cheats: resolve `site`, then run the steps in order (D8). Symbols are passed to `assemble` as `symbols`, and the labels it returns are added. If a step fails, every patch made so far is reverted, newest first, and the error is rethrown. A cheat with a non-empty `disable` → `EngineError('this cheat needs the native table runner (coming with .CT support)')`.
  - `interface RunningCheat { readonly kind: 'value' | 'patch'; readonly address: string; setValue(v: number): Promise<void> /* value cheats: replaces the freeze value; patch: throws */; disable(): Promise<void> /* idempotent */ }`.
  - All exported from `index.ts`.

- [ ] **Step 1: Write the failing tests** (real debug daemon + C target, like `code.test.ts`)

```ts
it('parseAddressExpr reads hex, module+hex and quoted module names', ...)
  // '0x10' → { module: null, offset: 16n }; 'target+0x1A' → { 'target', 26n }; 'GameAssembly.dll+1A2B' → 0x1a2bn;
  // '"My Game.exe"+10' → { 'My Game.exe', 16n }; 'foo' → null; '10' → null
it('verifies a pointer cheat in range and flags one out of range (--heap-chain)', ...)
  // pointer { module:'target', baseOffset: g_root - base, offsets:['0x18','0x10'] }, int32, verify.range 0–1000 → ok;
  // range 0–100 → needs-update, reasons == ['the value is 777, outside 0–100']
it('aob that matches twice needs updating', ...)        // pattern of bytes found twice in target (pick from a disassembled repeated sequence, or '00 00 00 00') → reason matches /matches \d+ places in target/
it('an aob that matches nothing needs updating', ...)   // 'DE AD BE EF 13 37 C0 DE' → "the AOB pattern isn't in target any more"
it('a cheat without verify is unverified even when its AOB is gone', ...)
it('enables a freeze cheat; disable lets the game change it again', ...)  // g_health freeze 999 → read 999 after a direct write of 5; disable; write 5 → reads 5
it('patch writeBytes ret at bump_counter stops g_counter; disable restores the bytes (--writer)', ...)
  // site = makeSignature(bump_counter) aob; enable [{ op:'writeBytes', at:'site', bytes:'c3', original:<first byte hex> }]
  // g_counter frozen over 300 ms; after disable bytes == original and g_counter rises
it('patch with alloc + assemble + registerSymbol runs a code cave', ...)
  // displaced = first instructions of bump_counter totalling ≥ 5 bytes (from disassemble); steps:
  // alloc newmem near site; registerSymbol return at `site+<len>`; assemble at newmem "add dword ptr [<g_health>],1\n<displaced texts>\njmp return";
  // assemble at site "jmp newmem\n" + nops to len → g_health rises with g_counter; disable → site bytes equal the originals
it('a failing step rolls back the earlier ones', ...)    // step 1 writeBytes ok, step 2 assemble 'mov eax,' → rejects (code AssembleFailed); site bytes unchanged
it('patch with a changed original byte needs updating and writes nothing', ...)  // original:'00' → NeedsUpdateError, reasons[0] starts 'the code at site changed'
it('refuses a cheat with disable steps', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm install && pnpm --filter @starlight/ct-importer build && make -C packages/engine/test-target && cargo build --manifest-path packages/starlightd/Cargo.toml && pnpm --filter @starlight/engine test -- --maxWorkers=2 cheats`
Expected: FAIL (`cheats.ts` missing).

- [ ] **Step 3: Implement** per the Interfaces block. Symbol expressions resolve as `name ± hex` against the symbol table; an unknown name → `EngineError('unknown symbol <name>')`. For the "exactly once" count, `verifyCheat` uses the matches `aobScan` returns.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter @starlight/engine lint && pnpm --filter @starlight/engine test -- --maxWorkers=2`
Expected: all pass, including M2's tests.

- [ ] **Step 5: Commit**

```bash
git add packages/engine pnpm-lock.yaml
git commit -m "feat(engine): verify and run v2 cheats (value and patch)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Game identity (Steam app id, build id, exe hash)

**Files:**
- Create: `apps/desktop/src/shared/game-key.ts`, `apps/desktop/src/main/game-identity.ts`, `apps/desktop/test/main/game-identity.test.ts`
- Modify: `apps/desktop/src/renderer/lib/dedupe-games.ts` (re-export `gameKey` from `shared/game-key.ts`; move the junk-stripping helpers it needs)

**Interfaces:**
- Consumes: `detectProton` (`proton-detect.ts`), `parseVdf` (`vdf.ts`), `identifyProcess` + `CatalogEntry` (`game-matcher.ts`), `readExeName` (`proc-exe-name.ts`), `DetectedGame`.
- Produces:
  - `shared/game-key.ts`: `gameKey(name: string): string` (moved, same behavior) and `userCheatsKey(cacheKey: string): string` (strips a leading `tools-`).
  - `game-identity.ts`:
    - `interface GameIdentity { pid: number; name: string; key: string; exeName: string; proton: boolean; steamAppId: number | null; buildId: string | null; exeHash: string | null; catalogId: string | null }`
    - `identifyGame(pid: number, deps: IdentityDeps): Promise<GameIdentity>`, where `IdentityDeps = { catalogIndex(): Map<string, CatalogEntry>; detectedGames(): DetectedGame[]; readEnviron?(pid): Promise<string>; readText?(path): Promise<string>; readMaps?(pid): Promise<string>; exePath?(pid): Promise<string>; fileSize?(path): Promise<number>; hashFile?(path): Promise<string> }` (D12).
    - `parseAppManifest(text: string): { appId: number; buildId: string } | null`
    - `steamappsDirFor(o: { compatDataPath?: string; exePath?: string }): string | null`. Proton: `<lib>/steamapps/compatdata/<id>` → `<lib>/steamapps`. Native: the nearest ancestor named `steamapps`.
    - `EXE_HASH_LIMIT = 1024 ** 3`.

- [ ] **Step 1: Write the failing tests**

```ts
it('parseAppManifest reads appid and buildid', ...)              // '"AppState" { "appid" "2784470" "buildid" "17012345" }' → { 2784470, '17012345' }
it('Proton game: app id from compatdata, build id from the library manifest', ...)
  // environ STEAM_COMPAT_DATA_PATH=/lib/steamapps/compatdata/2784470; readText('/lib/steamapps/appmanifest_2784470.acf') → buildid 17012345
it('native Steam game: SteamAppId from the environment, manifest found above the exe', ...)
it('non-Steam game: no app id or build id; key from the exe name', ...)   // exe 'target' → key 'target', name 'target'
it('a catalog match names the game and sets catalogId', ...)              // identifyProcess → entry { id:'9-kings', name:'9 Kings' } → key == gameKey('9 Kings')
it('exeHash is the sha256 of the exe file, null above 1 GiB', ...)
it('Proton exe file is the mapped .exe with the process exe name', ...)   // maps lines for 9Kings.exe and UnityPlayer.dll → hashFile called with the 9Kings.exe path
it('userCheatsKey strips tools-', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 game-identity`
Expected: FAIL.

- [ ] **Step 3: Implement** per D12. Every filesystem read goes through the deps, with the real `fs` defaults. Read errors degrade to `null` fields and never throw.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2 game-identity dedupe-games`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/game-key.ts apps/desktop/src/main/game-identity.ts apps/desktop/src/renderer/lib/dedupe-games.ts apps/desktop/test/main/game-identity.test.ts
git commit -m "feat(desktop): game identity with Steam app id, build id and exe hash

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: One engine per game

**Files:**
- Create: `apps/desktop/src/main/game-owner.ts`, `apps/desktop/src/main/game-owner-singleton.ts`, `apps/desktop/test/main/game-owner.test.ts`
- Modify: `apps/desktop/src/main/ce-session.ts`, `src/main/scanner-host.ts`, `src/shared/ipc.ts`, `src/main/index.ts`, `test/main/ce-session.test.ts`, `test/main/scanner-host.test.ts`

**Interfaces:**
- Produces:
  - `type Holder = 'agent' | 'user-cheats'`
  - `createGameOwner(deps: { ceSessionFor(pid: number): { sessionId: string } | null; releaseCe(sessionId: string): Promise<void>; onChange?(pid: number): void }): GameOwner`
  - `interface GameOwner { ownerOf(pid): { engine: 'ce'; sessionId: string } | { engine: 'starlightd'; holders: Holder[] } | null; holders(pid): Holder[]; hold(pid, holder): () => void /* release; idempotent */; claim(pid, holder): Promise<() => void> /* if CE owns: releaseCe first */ }`. `ownerOf` reports CE only when no starlightd holder exists, because a claim always releases CE first.
  - `ce-session.ts`:
    - `SessionState.engine: 'ce' | 'starlightd'`.
    - `releaseToStarlightd(sessionId: string): Promise<boolean>`: the same shutdown as `endSession` for CE (send `shutdown`, close the bridge, kill CE). The session stays `active` with `engine: 'starlightd'`, `bridge: null`, the same `pid` and `records`, and the game-exit watch keeps running.
    - `ceSessionFor(pid): { sessionId } | null`: the active session's id when `bridge !== null` and `pid` matches.
    - `StartSessionOpts.starlightdHolders?: (pid: number) => Holder[]`. When it returns a non-empty list for the effective pid, `startSession` doesn't launch CE: records come from `recordsFromCt`, `engine: 'starlightd'`, `attached: true`, verdict `'unknown'`.
    - `StartSessionResult` gains `engine` and `holders`.
    - `callSession` in starlightd mode: `set_speed` → `scannerHost.call(pid, 'speed_set', params)`. Other CE-bridge methods → `{ ok: false, error: 'the Cheat Engine table is paused' }`. Scanner methods are unchanged.
  - `scanner-host.ts`: method `speed_set { speed }` → engine `setSpeed(session, speed)` → `{ ok: true, speed }`, or `{ ok: false, error }`. Added to `SCANNER_METHODS`.
  - `shared/ipc.ts`: `CeSessionStartResult` ok branch gains `engine: 'ce' | 'starlightd'` and `holders: ('agent' | 'user-cheats')[]`. New event `{ type: 'session:engine'; sessionId: string; engine: 'ce' | 'starlightd'; holders: ('agent' | 'user-cheats')[] }`.
  - `index.ts`: a module-level `gameOwner = createGameOwner({ ceSessionFor, releaseCe: async (id) => { await releaseToStarlightd(id); broadcast session:engine }, onChange: (pid) => broadcast session:engine for the active session when its pid matches })`. It passes `starlightdHolders: (pid) => gameOwner.holders(pid)` to `ceStartSession` and returns `engine`/`holders` from `ceSessionStart`. `game-owner-singleton.ts` holds the instance: `setGameOwner(o: GameOwner): void` (called by `index.ts`) and `getGameOwner(): GameOwner` (throws if unset).

- [ ] **Step 1: Write the failing tests**

`game-owner.test.ts`:
```ts
it('CE owns a pid with a live bridge', ...)
it('claim ends the CE session before holding', ...)            // order: releaseCe('s1') then ownerOf → { engine:'starlightd', holders:['agent'] }
it('ownership lasts until the last holder releases', ...)       // hold agent + user-cheats; release one → still starlightd; release both → null; onChange called each time
it('release is idempotent', ...)
```
`ce-session.test.ts`:
```ts
it('releaseToStarlightd shuts CE down and keeps the session in starlightd mode', ...)  // bridge got {method:'shutdown'}, process killed, getActiveSession().engine === 'starlightd', pid kept
it('starting on a game starlightd owns does not launch Cheat Engine', ...)            // spawnCeProcess mock not called; result.engine 'starlightd', holders ['user-cheats'], attached true, records from the CT
it('anti-cheat is still refused in starlightd mode', ...)
it('set_speed in starlightd mode goes to the scanner host', ...)
it('CE-only commands in starlightd mode say the table is paused', ...)
```
`scanner-host.test.ts`:
```ts
it('speed_set sets the game speed on the pid session', ...)     // fake setSpeed called with 2 → { ok:true, speed:2 }
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 game-owner ce-session scanner-host`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. `scanner-host` gets `setSpeed` injectable in its deps, like `attach`.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): one engine per game; CE table pauses while starlightd owns the game

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The user's own cheats: storage, runner and IPC

**Files:**
- Create: `apps/desktop/src/main/user-cheats.ts`, `src/main/user-cheats-host.ts`, `test/main/user-cheats.test.ts`, `test/main/user-cheats-host.test.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts` (handlers; `before-quit` → `userCheatsHost.end()`)

**Interfaces:**
- Consumes: `StarlightTrainerSchema`, `StarlightCheat` (Task 1); `enableCheat`, `verifyCheat`, `attach`, `RunningCheat`, `NeedsUpdateError` (Task 2); `GameOwner` (Task 4); `getEngineClient`; `detectAntiCheat`, `antiCheatMessage`.
- Produces:
  - `user-cheats.ts`:
    - `userCheatsDir(userData: string): string` → `join(userData, 'user-cheats')`
    - `loadUserTrainer(dir: string, key: string): Promise<StarlightTrainer | null>`
    - `saveUserCheat(dir, key, game: { name: string; exeName: string; proton: boolean; steamAppId: number | null }, cheat: StarlightCheat /* without id ok */, o?: { category?: string; replaces?: string }): Promise<{ id: string }>`. A new id = `slug(name)`, with `-2`, `-3`… on collision. `replaces` keeps that id and its category position. An unknown `replaces` → `Error('no cheat "<id>" in your library for this game')`.
    - `removeUserCheat(dir, key, id): Promise<boolean>`.
    - Keys must match `/^[a-z0-9-]{1,80}$/`, or the call throws `Error('bad game key')`. Writes are atomic (tmp + rename). Platform is `['linux-proton']` or `['linux']`.
  - `user-cheats-host.ts`:
    - `createUserCheatsHost(deps: { dir: string; getClient(): Promise<EngineClient>; owner: GameOwner; attach?; enableCheat?; verifyCheat?; detectAntiCheatFn?; onChange?(key: string): void }): UserCheatsHost`
    - `interface UserCheatsHost { list(key: string, pid: number | null): Promise<UserCheatView[]>; setActive(req: { key: string; pid: number; id: string; on: boolean; closeCe?: boolean; value?: number }): Promise<SetActiveResult>; setValue(req: { key; pid; id; value: number }): Promise<IpcResult>; remove(key, id): Promise<IpcResult>; disableAll(pid: number): Promise<void>; end(): Promise<void> }`
    - `SetActiveResult = { ok: true } | { ok: false; error: string; confirm?: 'close-ce' }`. A CE-owned pid without `closeCe` → `{ ok: false, confirm: 'close-ce', error: 'This will close the current Cheat Engine table — continue?' }`. With `closeCe` → `owner.claim(pid, 'user-cheats')`, otherwise `owner.hold`. The hold is released when the last active cheat on that pid turns off, on `disableAll`, on game exit and on `end`.
  - `shared/ipc.ts`:
    - `interface UserCheatView { cheat: StarlightCheat; active: boolean; value?: number; verify: { status: 'ok' | 'needs-update' | 'unverified'; reasons: string[] } | null /* null when not attached */ }`
    - channels `userCheatsList`, `userCheatsSetActive`, `userCheatsSetValue`, `userCheatsRemove`, `userCheatsDisableAll` (`starlight:userCheats:<name>`), and the `StarlightApi` methods `userCheatsList(req: { key; pid: number | null }): Promise<UserCheatView[]>`, `userCheatsSetActive(req: { key; pid; id; on; closeCe?; value? }): Promise<SetActiveResult>`, `userCheatsSetValue(req: { key; pid; id; value }): Promise<IpcResult>`, `userCheatsRemove(req: { key; id }): Promise<IpcResult>`, `userCheatsDisableAll(req: { pid }): Promise<void>`. Event `{ type: 'userCheats:changed'; key: string }`.

- [ ] **Step 1: Write the failing tests**

`user-cheats.test.ts` (temp dir):
```ts
it('save creates a v2 trainer for the game with the cheat in "My cheats"', ...)   // file <dir>/9kings.json; parse → schemaVersion 2, id 'user-9kings', metadata.source.convertedFrom 'starlight'
it('ids are slugs, unique per game', ...)                                         // two "Infinite gold" → 'infinite-gold', 'infinite-gold-2'
it('replaces keeps the id and position', ...)
it('unknown replaces is an error', ...)
it('load returns null for a game with no file', ...)
it('rejects keys that are not plain slugs', ...)                                   // '../x' → 'bad game key'
it('remove drops the cheat', ...)
```
`user-cheats-host.test.ts` (fake engine functions and a fake owner):
```ts
it('enabling on a CE-owned game asks to close the table', ...)            // exact confirm text; enableCheat not called
it('closeCe claims the game, then enables', ...)                           // order: owner.claim('user-cheats') → enableCheat
it('anti-cheat refuses and never attaches', ...)
it('a cheat that needs updating refuses to enable with the reasons', ...)  // enableCheat throws NeedsUpdateError(['the value is 5, outside 10–20']) → { ok:false, error:'This cheat needs updating: the value is 5, outside 10–20' }; hold released
it('list reports verify status when attached and null when not', ...)
it('turning the last cheat off releases the game', ...)
it('game exit clears active state and releases the game', ...)            // fake session onDetached('process-exit') → list shows active false; owner released
it('disableAll turns every cheat on the pid off', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 user-cheats`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. The host attaches lazily per pid (as `scanner-host` does) and keeps a `Map<id, RunningCheat>` per pid. `index.ts` builds it with `dir = userCheatsDir(app.getPath('userData'))` and broadcasts `userCheats:changed` from `onChange`.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2 user-cheats`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): the user's own cheat library, run on starlightd

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: "My cheats" on the game's page

**Files:**
- Create: `apps/desktop/src/renderer/stores/user-cheats-store.ts`, `src/renderer/components/ce/MyCheatsSection.tsx`, `test/components/MyCheatsSection.test.tsx`, `test/stores/user-cheats-store.test.ts`
- Modify: `apps/desktop/src/renderer/components/ce/CeSessionView.tsx`, `src/renderer/stores/ce-session-store.ts`, `test/components/CeSessionView.test.tsx`, `test/stores/ce-session-store.test.ts`

**Interfaces:**
- Consumes: the `userCheats*` API and the `userCheats:changed` / `session:engine` events (Tasks 4–5); `userCheatsKey` (Task 3).
- Produces:
  - `useUserCheatsStore`: state `{ key: string | null; pid: number | null; items: UserCheatView[]; pending: Set<string>; errors: Record<string, string>; confirm: { id: string; on: boolean; value?: number } | null }`. Actions: `load(key, pid)`, `setActive(id, on, value?)` (a `confirm: 'close-ce'` reply stores `confirm` and doesn't retry), `confirmCloseCe()` (retries with `closeCe: true`), `cancelConfirm()`, `setValue(id, value)`, `remove(id)`. It reloads on `userCheats:changed` for its key.
  - `useCeSessionStore` gains `engine: 'ce' | 'starlightd'` and `holders: ('agent' | 'user-cheats')[]`, set from the start result and from `session:engine`, and an action `useTableInstead(): Promise<void>`: `userCheatsDisableAll({ pid })`, then `agentStop()` if `holders` includes `agent` (the API arrives in Task 9; until then guard with `typeof api.agentStop === 'function'`), then `start(lastReq)`.
  - `MyCheatsSection` (`{ cacheKey: string; pid: number | null; attached: boolean }`): titled **My cheats**, one row per cheat with a "Yours" pill, a toggle (or a value field for `set` cheats), a **Needs updating** amber pill listing the reasons on hover/focus, and a remove button that asks first. A pending `confirm` shows an inline confirm bar: `This will close the current Cheat Engine table — continue?` with **Continue** / **Cancel**. Unverified cheats get no badge.
  - `CeSessionView`:
    - renders `MyCheatsSection` at the top of the Cheats tab when the game has user cheats;
    - opens on the Cheats tab when the session has no table but has user cheats;
    - doesn't poll `refresh` when `engine === 'starlightd'`;
    - in starlightd mode, replaces the CE record list with a notice. With holders: `The Cheat Engine table is paused while ${holders.includes('agent') ? 'the agent session' : 'your cheats'} run${holders.includes('agent') ? 's' : ''}.` plus a **Use the table instead** button, which asks `This turns off your cheats${holders.includes('agent') ? ' and ends the agent session' : ''} — continue?` (inline) and then calls `useTableInstead`. Without holders: `The Cheat Engine table is closed.` plus a **Load the table** button (`start(lastReq)`).

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows the player\'s cheats as their own with a Needs updating badge', ...)
it('toggling on a CE-owned game shows the close-table confirm; Continue retries with closeCe', ...)
it('Cancel leaves the CE table alone', ...)
it('a value cheat edits through setValue', ...)
it('remove asks first', ...)
// CeSessionView.test.tsx
it('in starlightd mode the CE records are replaced by the paused notice', ...)
it('Use the table instead turns user cheats off, stops the agent and restarts the session', ...)
it('a tools-only session with user cheats opens on the Cheats tab', ...)
it('does not poll refresh in starlightd mode', ...)
```
The existing `CeSessionView` and `ce-session-store` tests pass unchanged.

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 MyCheatsSection user-cheats-store CeSessionView ce-session-store`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with existing `Notice`/`RailCard` styles and `animate-rise` on new rows.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): My cheats on the game page; paused CE table in starlightd mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: MCP host: localhost server, token, tool registry, `list_games`

**Files:**
- Create: `apps/desktop/src/main/agent/mcp-host.ts`, `agent/token.ts`, `agent/connect-info.ts`, `agent/server.ts`, `agent/tools.ts`, `agent/instructions.ts`, `agent/tools-session.ts`, and `test/main/agent/mcp-host.test.ts`, `token.test.ts`, `connect-info.test.ts`, `instructions.test.ts`, `tools-session.test.ts`
- Modify: `apps/desktop/package.json` (dependency `@modelcontextprotocol/sdk` ^1.32), `src/main/user-config.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts` (start on ready; restart on `agent.enabled`/`agent.port` changes; close on quit)

**Interfaces:**
- Consumes: `identifyGame` (Task 3), `processHost.listOnce`, `detectAntiCheat`, `getConfig`.
- Produces:
  - `user-config.ts` / `shared/ipc.ts`: `UserConfig.agent: AgentPreferences = { enabled: boolean; port: number /* 1024–65535 */; confirmYes: string; confirmNo: string; stop: string; askTimeoutSec: number /* 10–3600 */; approvalTimeoutSec: number /* 30–600 */ }`. Defaults `{ enabled: true, port: 47771, confirmYes: 'Ctrl+Shift+Y', confirmNo: 'Ctrl+Shift+N', stop: 'Ctrl+Shift+End', askTimeoutSec: 300, approvalTimeoutSec: 120 }`, exported as `DEFAULT_AGENT_PREFS` from `shared/ipc.ts`.
  - `token.ts`: `loadOrCreateToken(dir: string): Promise<string>`, `rotateToken(dir: string): Promise<string>` (file `agent-token`, mode 0600, 32 bytes base64url).
  - `connect-info.ts`: `buildConnectInfo(o: { enabled: boolean; port: number; portIsFallback: boolean; token: string }): AgentConnectInfo`, where `AgentConnectInfo = { enabled; url: string; port; portIsFallback; token; claudeCommand: string; codexConfig: string }`:
    - `url` = `http://127.0.0.1:${port}/mcp`
    - `claudeCommand` = `claude mcp add --transport http starlight ${url} --header "Authorization: Bearer ${token}"`
    - `codexConfig` = `[mcp_servers.starlight]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }\n`
  - `tools.ts`:
    - `type Tier = 'open' | 'attached' | 'modify'`; `class ToolError extends Error {}`; the refusal constants (MCP reference); `describeEngineError(err: unknown): string`
    - `type EngineApi = typeof import('@starlight/engine')`. Tools and the agent session take `Partial<EngineApi>` overrides for tests and default to the real functions.
    - `interface ToolDef<S extends z.ZodRawShape> { name: string; title: string; description: string; tier: Tier; input: S; run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>; summarize(args: z.infer<z.ZodObject<S>>, result: unknown): string }`
    - `interface ToolContext { mcpSessionId: string; client: AgentClient; attached: unknown /* what access.require returned; Task 9 narrows it to AttachedContext | null */ }`
    - `interface AgentClient { mcpSessionId: string; name: string; version: string; label: string }`
    - `interface AgentAccess { require(mcpSessionId: string, tier: Tier): Promise<unknown /* Task 9 narrows to AttachedContext */> }`
    - `interface ActivitySink { start(tool: string, summary: string): number; finish(id: number, r: { status: 'ok' | 'error' | 'refused'; summary?: string; error?: string; change?: { address: string; old: string; new: string } }): void }`
    - `registerTools(server: McpServer, defs: ToolDef<any>[], o: { mcpSessionId: string; client(): AgentClient; access: AgentAccess; activity: ActivitySink }): void`. Each call: `activity.start(name, `${name} …`)` → `attached = await access.require(mcpSessionId, tier)` (a `ToolError` → finish `refused`, `isError` result) → `run(args, { mcpSessionId, client, attached })` → finish `ok` with `summarize`, or finish `error` with `describeEngineError`.
    - `agentLabel(clientName: string): string` (D17).
  - `instructions.ts`: `INSTRUCTIONS: string` and `findACheatPrompt(goal?: string): string`. They must state, in this order, the playbook `list_games → attach → scan_first → ask_player → scan_next → pointer_scan or watch_writes → make_signature → test_cheat → save_cheat`, and the rules:
    - the player approves attach;
    - ask the player instead of guessing (`ask_player` or chat);
    - prefer pointer or AOB addresses, never absolute;
    - give value cheats a `verify.range`;
    - test before saving;
    - `list_cheats` first, to repair instead of starting over;
    - single-player games only.
  - `server.ts`: `createAgentServer(mcpSessionId: string, deps: AgentServerDeps): McpServer`, with name `starlight`, the app version, `INSTRUCTIONS`, the prompt `find-a-cheat` (`{ goal?: string }`) and every `ToolDef` from `deps.tools`. `AgentServerDeps = { version: string; tools: ToolDef<any>[]; access: AgentAccess; activity: ActivitySink; onClientInfo(c: AgentClient): void }`.
  - `mcp-host.ts`: `startMcpHost(o: { port: number; token(): string; createServer(mcpSessionId: string): McpServer; onSessionClosed(mcpSessionId: string): void }): Promise<McpHost>`, where `interface McpHost { port: number; portIsFallback: boolean; closeSessions(): Promise<void>; close(): Promise<void> }`. Order of checks per request: `Origin` present → 403; `Host` not `127.0.0.1:<port>`/`localhost:<port>` → 403; bearer mismatch (`timingSafeEqual` on equal-length buffers) → 401; body > 1 MiB → 413. Then route `POST/GET/DELETE /mcp` to the session's transport (new session on `initialize`). Anything else → 404.
  - `tools-session.ts`: `listGamesTool(deps: { listProcesses(): Promise<DetectedProcess[]>; manualExePaths(): Promise<string[]>; installDirs(): string[]; exePath(pid): Promise<string | null>; identify(pid): Promise<GameIdentity>; detectAntiCheatFn; attachedPid(): number | null }): ToolDef`. A process is game-like when its name matches `EXE_SUFFIX`, or its exe path equals a manual game's `exePath` or lies inside an installed game's `installDir`. `all: true` lists every non-noise process (cap 200, identity fields null).
  - `shared/ipc.ts`: `AgentConnectInfo`, `AgentPreferences`, channels `agentConnectInfo`, `agentRotateToken` and their `StarlightApi` methods.

- [ ] **Step 1: Write the failing tests**

`mcp-host.test.ts` (real SDK `Client` + `StreamableHTTPClientTransport` against `startMcpHost({ port: 0, … })`):
```ts
it('rejects a missing or wrong token (401)', ...)
it('rejects requests that carry an Origin header (403)', ...)          // fetch with Origin: http://evil.example → 403, even with the right token
it('rejects a foreign Host header (403)', ...)                         // Host: attacker.example:<port>
it('lists the tools and the find-a-cheat prompt, with instructions', ...)  // tools include 'list_games'; prompts include 'find-a-cheat'; client.getInstructions() mentions 'ask_player'
it('falls back to a free port when the configured one is taken', ...)  // occupy a port with net.createServer → host.port !== it, portIsFallback true
it('closing a client session reports it', ...)                          // transport.terminateSession() → onSessionClosed(id)
it('a refused tool call is an isError result and an activity entry', ...)  // access.require throws ToolError(NOT_ATTACHED) → isError text === NOT_ATTACHED; activity finish status 'refused'
```
`token.test.ts`: `creates a 0600 token once and reuses it`, `rotate writes a new token`.
`connect-info.test.ts`: the exact `claudeCommand` and `codexConfig` for port 47771 and token `abc`.
`instructions.test.ts`: `the playbook names the tools in order` (indexOf increasing), `forbids absolute addresses and multiplayer`.
`tools-session.test.ts`:
```ts
it('list_games returns game-like processes with identity and anti-cheat status', ...)
it('a manual game\'s native exe counts as a game', ...)
it('all:true lists every process without identity', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm install && pnpm --filter ./apps/desktop test -- --maxWorkers=2 agent/`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. `index.ts`:
  - `startMcpHost` on `app.whenReady` when `agent.enabled`, using `loadOrCreateToken(app.getPath('userData'))`.
  - Until Task 9, `access.require` allows `open` and throws `NOT_ATTACHED` otherwise.
  - `agentConnectInfo` → `buildConnectInfo`; `agentRotateToken` → `rotateToken` + `closeSessions`.
  - Restart the host when `updateConfig` changes `agent.enabled` or `agent.port`.

- [ ] **Step 4: Run tests and see them pass, and build**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2 && pnpm --filter ./apps/desktop build`
Expected: all pass. `out/main/index.js` imports `@modelcontextprotocol/sdk` as an external, not bundled.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): local MCP server with token auth and list_games (@modelcontextprotocol/sdk: MIT)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Settings "Connect an agent" card and agent preferences

**Files:**
- Create: `apps/desktop/src/renderer/components/settings/ConnectAgentCard.tsx`, `test/components/ConnectAgentCard.test.tsx`
- Modify: `apps/desktop/src/renderer/routes/SettingsRoute.tsx`, `test/routes/SettingsRoute.test.tsx`

**Interfaces:**
- Consumes: `agentConnectInfo()`, `agentRotateToken()`, `updateConfig`, `DEFAULT_AGENT_PREFS` (Task 7); `HotkeyCapture` (existing component).
- Produces:
  - `ConnectAgentCard` (no props; reads `config.agent ?? DEFAULT_AGENT_PREFS`).
    - Title **Connect an agent**, with one line: `Let Claude Code or Codex find cheats with you. The agent can only touch a game after you allow it here in Starlight.`
    - A tab switch **Claude Code** / **Codex**, the command or snippet in a mono block, and a **Copy** button (`navigator.clipboard.writeText`; label flips to `Copied` for 1.5 s).
    - When `portIsFallback`: `Port ${configured} was busy, so Starlight is using ${port} for now. Copy the command again if you set it up before.`
    - **Regenerate token** asks `Agents you've already connected will need the new command. Continue?` (inline) and then shows the new info.
    - An **Allow agents to connect** checkbox (`agent.enabled`); when off, the card shows `Agents can't connect while this is off.` instead of the command.
  - `SettingsRoute`: the card plus three `HotkeyCapture` rows (**Answer yes**, **Answer no**, **Stop the agent** → `agent.confirmYes`, `agent.confirmNo`, `agent.stop`) and **Question timeout** (seconds, 10–3600, blur commits like the poll interval does).

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows the Claude Code command with the real port and token', ...)
it('switches to the Codex snippet', ...)
it('Copy puts the command on the clipboard and says Copied', ...)
it('says when the port is a fallback', ...)
it('Regenerate token asks first, then shows the new token', ...)
it('turning agents off updates agent.enabled and hides the command', ...)
// SettingsRoute.test.tsx
it('renders with a config that has no agent section (defaults)', ...)
it('commits the question timeout on blur within 10–3600', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 ConnectAgentCard SettingsRoute`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Use the panel and pill styles of the existing Settings sections.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2 ConnectAgentCard SettingsRoute`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): Connect an agent card and agent settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Agent session: attach approval, tiers, Stop, activity log

**Files:**
- Create: `apps/desktop/src/main/agent/session.ts`, `agent/activity.ts`, `agent/player-prompt.ts` (approval part), `agent/notifier.ts`, and `test/main/agent/session.test.ts`, `activity.test.ts`, `player-prompt.test.ts`
- Modify: `apps/desktop/src/main/agent/tools-session.ts` (`attach`, `detach`, `game_info`), `agent/tools.ts` (`ToolContext.attached: AttachedContext | null`; `AgentAccess.require` returns `Promise<AttachedContext | null>`; `AttachedContext` and `Tracker` are declared here so tool files don't import `session.ts`), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `GameOwner` (Task 4), `identifyGame` (Task 3), `ToolError`, the refusal constants, `AgentAccess`, `ActivitySink`, `AgentClient` (Task 7), `attach`, `listModules`, `pointerEnd`, `Session`, `EngineClient` (engine), `detectAntiCheat`, `antiCheatMessage`.
- Produces:
  - `notifier.ts`: `interface Notifier { show(o: { title: string; body: string; onClick?: () => void }): { close(): void } }`; `electronNotifier(): Notifier`. When `Notification.isSupported()` is false it does nothing.
  - `activity.ts`: `createActivityLog(o: { max?: number /* 200 */; onChange(): void; now?(): number }): ActivityLog`, where `ActivityLog extends ActivitySink { note(summary: string): void; entries(): ActivityEntry[] /* newest first */ }`. `ActivityEntry = { id: number; at: number; tool: string | null; summary: string; status: 'running' | 'ok' | 'error' | 'refused' | 'note'; error?: string; change?: { address; old; new } }`.
  - `player-prompt.ts` (approval):
    - `createPlayerPrompts(deps: { notifier: Notifier; focusAgentView(): void; onChange(): void; now?(): number }): PlayerPrompts` (Task 10 adds `hotkeys` and `prefs`)
    - `requestApproval(a: { label: string; game: string; pid: number; closesCeTable: boolean; timeoutMs: number }): Promise<'allow' | 'deny' | 'timeout' | 'stopped'>`
    - `respondApproval(id: string, allow: boolean): boolean`, `approval(): PendingApproval | null`, `cancelAll(): void`
    - `PendingApproval = { id; label; game; pid; closesCeTable; expiresAt }`
    - Notification: title `${label} wants to attach to ${game}`, body `Allow it in Starlight.` plus ` This closes the current Cheat Engine table.` when `closesCeTable`. Clicking it calls `focusAgentView`.
  - `session.ts`:
    - `createAgentSession(deps: AgentSessionDeps): AgentSession`, where `AgentSessionDeps = { getClient(): Promise<EngineClient>; engine?: Partial<EngineApi> /* attach, listModules, setSpeed, pointerEnd */; detectAntiCheatFn?; identify(pid): Promise<GameIdentity>; owner: GameOwner; prompts: PlayerPrompts; activity: ActivityLog; prefs(): Promise<AgentPreferences>; onChange(): void; focusAgentView(): void }`
    - `interface AgentSession extends AgentAccess { attach(pid: number, client: AgentClient): Promise<AttachInfo>; stop(reason: StopReason): Promise<void>; setCanModify(on: boolean): Promise<void>; require(mcpSessionId: string, tier: Tier): Promise<AttachedContext>; snapshot(): AgentSnapshot; onMcpSessionClosed(mcpSessionId: string): Promise<void> }`
    - `StopReason = 'player' | 'hotkey' | 'agent' | 'agent-disconnected' | 'game-exited' | 'anti-cheat' | 'engine-closed' | 'app-quit'`
    - `AttachedContext = { gen: number; session: Session; game: GameIdentity; client: AgentClient; describe(address: string): Promise<string | null> /* "<module>+0x<off>" from a cached listModules */; track: Tracker }`
    - `Tracker = { freeze(gen, h: FreezeHandle, info: { address; type; value }): number; test(gen, c: RunningCheat, info: { name: string }): number; watch(gen, w: Watch, info: { address; kind; endsAt }): number; pointerScan(gen, id: number): void; speed(gen, v: number): void; untrackFreeze(id): FreezeHandle | null; untrackTest(id): RunningCheat | null; untrackWatch(id): void }`. A `track.*` call with a stale `gen` (after Stop or the switch going off) reverts the item at once and throws `ToolError(STOPPED_MIDWAY)`.
    - `AttachInfo = { pid; name; proton; steamAppId; buildId; canModify: true }`
    - `AgentSnapshot = { status: 'idle' | 'awaiting-approval' | 'attached'; client: { label: string; name: string } | null; approval: PendingApproval | null; game: { pid; name; key; proton; steamAppId; buildId } | null; canModify: boolean; questions: PendingQuestion[] /* empty until Task 10 */; live: { freezes: Array<{ id; address; where; type; value }>; tests: Array<{ id; name }>; watches: Array<{ id; address; kind; endsAt }>; speed: number }; activity: ActivityEntry[] }` (types in `shared/ipc.ts`). `PendingQuestion = { id: string; question: string; answer: 'number' | 'confirm' | 'choice'; choices?: string[]; askedAt: number; expiresAt: number; label: string }` is declared here too.
  - attach flow:
    1. Another agent attached → `OTHER_AGENT`.
    2. Anti-cheat hit → `ToolError(antiCheatMessage(hit))` without asking.
    3. `requestApproval` with `closesCeTable = owner.ownerOf(pid)?.engine === 'ce'`: `deny` → `DECLINED`; `timeout` → `NO_ANSWER`.
    4. Anti-cheat check again.
    5. `owner.claim(pid, 'agent')`.
    6. Engine `attach`.
    7. Activity note `${label} attached to ${name}`, `focusAgentView()`.
  - `require`: `open` passes; `attached` needs this MCP session to own an attached session (`NOT_ATTACHED` or `OTHER_AGENT`); `modify` also needs `canModify` (`MODIFY_OFF`) and re-checks anti-cheat (a hit → `stop('anti-cheat')`, then `ToolError(antiCheatMessage)`).
  - `stop(reason)`: bump `gen`; cancel the approval; `prompts.cancelAll()`; cancel freezes; stop watches; disable tests (newest first); `pointerEnd` each id; detach (the daemon reverts speed hooks and ends scans); release the owner hold; activity note (`Stopped by the player` / `Stopped with the hotkey` / `${label} detached` / `${label} disconnected` / `The game exited` / `Anti-cheat loaded in the game; stopped` / `The engine stopped` / `Starlight is quitting`); status `idle`. Every step is best-effort and runs even if an earlier one throws.
  - `setCanModify(false)`: bump `gen`; cancel freezes, stop watches, disable tests, `setSpeed(1)` if speed ≠ 1; stay attached; note `Agent can't modify the game now`. `setCanModify(true)` notes `Agent can modify the game`.
  - Engine `session.onDetached('process-exit')` → `stop('game-exited')`; `client.onClose` → `stop('engine-closed')`.
  - `tools-session.ts`: `attachTool(agent)`, `detachTool(agent)` (→ `stop('agent')`), `gameInfoTool(deps: { listModules; readMaps(pid): Promise<string> })`.
  - IPC: `agentGetState` → `AgentSnapshot`; `agentRespondApproval { id, allow }`; `agentSetCanModify { on }`; `agentStop`; events `{ type: 'agent:state'; state: AgentSnapshot }` (on every change) and `{ type: 'agent:focus' }`. `index.ts` wires `session.onMcpSessionClosed` to the host's `onSessionClosed`, and `before-quit` → `stop('app-quit')` then `host.close()`.

- [ ] **Step 1: Write the failing tests**

`session.test.ts` (fake engine client/session that records calls, fake owner, fake prompts, fake timers):
```ts
it('attach refuses a game with anti-cheat loaded without asking the player', ...)
it('attach waits for the player and attaches on Allow', ...)                  // status 'awaiting-approval' → 'attached'; owner.claim('agent') before engine attach
it('Deny returns the declined message; timeout returns the no-answer message', ...)
it('approval on a CE-owned game says so and closes the table before attaching', ...)  // requestApproval got closesCeTable true
it('anti-cheat is checked again after approval, before attaching', ...)
it('tools before attach say Not attached', ...)                                 // require('s1','attached') → NOT_ATTACHED
it('a second agent cannot attach or use tools while one is attached', ...)      // OTHER_AGENT('Claude', '9Kings.exe')
it('Stop cancels freezes, stops watches, reverts tests, ends pointer scans, detaches and releases the game', ...)
it('switching modify off reverts changes but stays attached; modify tier is refused', ...)
it('an item tracked after Stop is reverted at once', ...)                       // ctx from before Stop; track.freeze(oldGen, h) → h.cancel called, throws STOPPED_MIDWAY
it('game exit ends the session and logs it', ...)
it('engine connection close ends the session', ...)
it('anti-cheat appearing later stops the session on the next modify-tier call', ...)
it('the MCP session closing stops the agent session it owns', ...)
```
`activity.test.ts`: `keeps the newest 200 entries`, `finish updates status, summary and change`.
`player-prompt.test.ts`: `approval shows the notification with the attach copy`, `clicking the notification focuses the agent view`, `respondApproval resolves allow/deny once`, `approval times out`.
`tools-session.test.ts`: `attach returns the game identity`, `game_info pages modules and summarizes regions`.

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 agent/`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Region summary: count the `/proc/<pid>/maps` lines; `writableMiB` sums the private `rw` regions and `executableMiB` sums the `x` regions, rounded to 0.1.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): agent session with player-approved attach, tiers, Stop and activity log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `ask_player`: questions, notifications and hotkeys

**Files:**
- Create: `apps/desktop/src/main/agent/tools-ask.ts`, `test/main/agent/tools-ask.test.ts`, `test/main/hotkey-host.agent.test.ts`
- Modify: `apps/desktop/src/main/agent/player-prompt.ts`, `agent/session.ts` (cancel questions on Stop; bind hotkeys), `src/main/hotkey-host.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `test/main/agent/player-prompt.test.ts`

**Interfaces:**
- Consumes: `PlayerPrompts`, `AgentSession` (Task 9), `parseAccelerator` (`hotkey-matcher.ts`), `AgentPreferences` (Task 7).
- Produces:
  - `hotkey-host.ts`: `setAgentHotkeys(b: { yes?: string; no?: string; stop?: string } | null, on: { yes(): void; no(): void; stop(): void }): { ok: true } | { ok: false; invalid: string[] }`. Agent bindings live apart from cheat bindings: `registerForTrainer` / `unregisterAll` never clear them. They are checked first in `onKeyDown`, and `ensureStarted()` runs when a binding is set. `type AgentHotkeysPort = { set: typeof setAgentHotkeys }`.
  - `player-prompt.ts` (questions):
    - `ask(q: { question: string; answer: 'number' | 'confirm' | 'choice'; choices?: string[]; timeoutMs: number; label: string }): Promise<AskResult>`. A question already pending → `ToolError(QUESTION_WAITING)`.
    - `answer(id: string, value: unknown): { ok: true } | { ok: false; error: string }`. Errors (exact): `Type a number`, `Answer yes or no`, `Pick one of the choices`, `That question was already answered`.
    - `pending(): PendingQuestion[]`; `cancelAll()` resolves pending questions `{ answered: false, reason: 'stopped' }` (and the approval `'stopped'`).
    - `AskResult = { answered: true; answer: number | boolean | string } | { answered: false; reason: 'timeout' | 'stopped' }`
    - `createPlayerPrompts` deps gain `hotkeys: AgentHotkeysPort` and `prefs(): Promise<AgentPreferences>` (for the hotkey labels). Questions use Task 9's `PendingQuestion`.
    - Notification: title `${label} asks`, body `${question}` plus:
      - confirm: `\nPress ${yes} for yes or ${no} for no.`
      - number: `\nSwitch to Starlight to type the number.`
      - choice: `\nSwitch to Starlight to pick: ${choices.join(' / ')}.`
    - Clicking it focuses the agent view. The yes/no hotkeys are bound only while a `confirm` question is pending.
  - `session.ts`: `AgentSessionDeps` gains `hotkeys: AgentHotkeysPort`. Stop's hotkey is bound while `attached` (→ `stop('hotkey')`), and unbound on Stop.
  - `tools-ask.ts`: `askPlayerTool(prompts, prefs)`. `timeout_s` defaults to `askTimeoutSec`. Summary: `ask_player "${question}" → ${answer}` or `→ no answer (timeout)`.
  - IPC: `agentAnswer { id, value }` → `answer`.

- [ ] **Step 1: Write the failing tests**

`player-prompt.test.ts`:
```ts
it('ask shows a notification with the question and the hotkeys', ...)   // body === 'Did your gold change?\nPress Ctrl+Shift+Y for yes or Ctrl+Shift+N for no.'
it('the Yes hotkey answers a confirm question true; No answers false', ...)
it('yes/no hotkeys are unbound when no confirm question is pending', ...)
it('a number answer from the app resolves the ask; a non-number is refused', ...)
it('a choice must be one of the choices', ...)
it('times out with reason timeout', ...)                                   // fake timers, 300 s
it('a second question while one is waiting is a tool error', ...)
it('Stop resolves the pending question as stopped', ...)
```
`hotkey-host.agent.test.ts` (uiohook mocked as in `hotkey-host.test.ts`):
```ts
it('agent bindings fire and survive registerForTrainer and unregisterAll', ...)
it('reports invalid accelerators', ...)
it('null clears the agent bindings', ...)
```
`tools-ask.test.ts`: `uses the configured timeout by default`, `summary includes the answer`.

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 player-prompt hotkey-host tools-ask`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2`
Expected: all pass, including the existing `hotkey-host` tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): ask_player with notifications and confirm hotkeys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Activity panel, approval card and questions in the app

**Files:**
- Create: `apps/desktop/src/renderer/stores/agent-store.ts`, `src/renderer/routes/AgentRoute.tsx`, `src/renderer/components/agent/ApprovalCard.tsx`, `components/agent/QuestionCard.tsx`, `components/agent/ActivityList.tsx`, and `test/routes/AgentRoute.test.tsx`, `test/components/ApprovalCard.test.tsx`, `test/stores/agent-store.test.ts`
- Modify: `apps/desktop/src/renderer/App.tsx` (route `/agent`, `ApprovalCard` overlay, `agent:focus` → `navigate('/agent')`), `src/renderer/components/Sidebar.tsx` (an **Agent** item with a mint dot while attached)

**Interfaces:**
- Consumes: `agentGetState`, `agentRespondApproval`, `agentAnswer`, `agentSetCanModify`, `agentStop`, and the `agent:state` / `agent:focus` events (Tasks 9–10).
- Produces:
  - `useAgentStore`: `{ state: AgentSnapshot | null; load(): Promise<void>; respond(allow: boolean): Promise<void>; answer(id: string, value: number | boolean | string): Promise<{ ok: boolean; error?: string }>; setCanModify(on: boolean): Promise<void>; stop(): Promise<void> }`, plus `attachAgentEvents(): () => void`.
  - `ApprovalCard`: a fixed, centered overlay while `state.approval` is set. Heading `${label} wants to attach to ${game} — Allow?`, the line `This closes the current Cheat Engine table.` when `closesCeTable`, a countdown to `expiresAt`, and the buttons **Allow** (primary) / **Deny**. Allow navigates to `/agent`.
  - `AgentRoute`:
    - header: game name, the client label, a **Stop** button (with the Stop hotkey label) and the **Agent can modify the game** switch;
    - the pending question (`QuestionCard`): number questions show an input that auto-focuses on mount and when the window gains focus; confirm questions show **Yes**/**No** with the hotkey labels; choice questions show one button per choice. An error from `answer` shows under the input.
    - a **Live** strip: freezes (`where ?? address` = value), test cheats, watches (with seconds left), speed when ≠ 1;
    - `ActivityList`: newest first, status dot, summary, `old → new` for changes, error text, relative time; new rows `animate-rise`.
    - Idle: `No agent attached` and `Connect Claude Code or Codex in Settings, then ask it to find a cheat.` with a link to `/settings`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('ApprovalCard shows the attach question and the CE-close note; Allow responds and opens the agent view', ...)
it('Deny responds false', ...)
it('lists activity newest first with old → new for writes', ...)
it('a number question focuses its input and submits the number', ...)
it('shows the answer error under the input', ...)
it('confirm questions show Yes/No with the hotkey labels', ...)
it('the switch calls setCanModify; Stop calls agentStop', ...)
it('the Live strip shows freezes, test cheats, watches and speed', ...)
it('idle state points to Settings', ...)
it('agent:state events update the store; agent:focus navigates to /agent', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 AgentRoute ApprovalCard agent-store`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block and the visual direction: centered column, max width about 760 px, panels on `bg-panel`, mint accent for live items, amber for refused entries, pink for errors.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): agent activity panel, approval card and player questions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Discovery tools (read-only)

**Files:**
- Create: `apps/desktop/src/main/agent/tools-discovery.ts`, `test/main/agent/tools-discovery.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (register the tools)

**Interfaces:**
- Consumes: `AttachedContext` (Task 9); `scanFirst`, `scanNext`, `scanResults`, `read`, `readMany`, `pointerScan`, `pointerResults`, `pointerRescan`, `disassemble`, `makeSignature` (engine); `resolveAddressExpr` (Task 2).
- Produces: `discoveryTools(engine?: Partial<EngineApi>): ToolDef[]` for `scan_first`, `scan_next`, `scan_results`, `read`, `pointer_scan`, `pointer_results`, `pointer_rescan`, `disassemble` and `make_signature`, with the inputs and results in the MCP reference (`EngineApi` from Task 7).
  - Scan ids from `scan_first` are remembered per session. `scan_next` or `scan_results` on another id → `ToolError('Unknown scan ${id}; start one with scan_first.')`.
  - Pointer scan ids are tracked with `track.pointerScan`.
  - `Path.text` = `${module}+${base} → ${offsets.join(' → ')}`.
  - Summaries (exact formats): `scan_first ${type} ${mode}${value ? ' ' + value : ''} → ${count.toLocaleString('en-US')} matches`, `scan_next ${mode}${value ? ' ' + value : ''} → ${count} matches`, `read ${where ?? address} = ${value}`, `pointer_scan ${where ?? address} → ${count} paths`, `make_signature ${where} → ${unique ? 'unique' : matches + ' matches'}`.

- [ ] **Step 1: Write the failing tests** (fake `AttachedContext` with `describe` from a fixed module list; fake engine functions)

```ts
it('scan_first includes results only when there are 50 or fewer', ...)
it('scan_results annotates addresses with module+offset and caps limit at 500', ...)   // limit 501 → schema error (isError)
it('scan_next on an unknown scan id is a tool error', ...)
it('read resolves module expressions and requires length for bytes', ...)            // 'target+0x10' → resolveAddressExpr called; bytes without length → error
it('pointer_scan returns the first 20 paths with readable text and tracks the id', ...)
it('make_signature returns a ready aob address', ...)                               // aob: { kind:'aob', module:'target', pattern }
it('disassemble caps count at 100', ...)
it('summaries use the exact formats', ...)                                          // 'scan_first int32 exact 100 → 1,204 matches'
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 tools-discovery`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2 agent/`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): agent discovery tools (scans, pointer scans, disassembly, signatures)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Tools that modify the game (`write`, `freeze`, watches, `set_speed`, `test_cheat`)

**Files:**
- Create: `apps/desktop/src/main/agent/tools-modify.ts`, `test/main/agent/tools-modify.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `AttachedContext.track` (Task 9); `read`, `write`, `freeze`, `watchStart`, `setSpeed` (engine); `enableCheat`, `verifyCheat` (Task 2); `validateAgentCheat` (Task 1).
- Produces: `modifyTools(engine?: Partial<EngineApi>): ToolDef[]` for `write`, `freeze`, `unfreeze`, `watch_writes`, `watch_accesses`, `set_speed` and `test_cheat`, per the MCP reference.
  - `write` reads the old value first. Its activity `change` is `{ address: where ?? address, old, new }`.
  - `watch_*` stops early when the session's `gen` changes, and then returns `reason: 'stopped'`.
  - `test_cheat apply` runs `validateAgentCheat(cheat, { forTest: true })` (errors joined by `\n` → `ToolError`). It refuses a 9th live test with `ToolError('At most 8 test cheats can be on at once; revert one first.')`. Then `verifyCheat`, `enableCheat` (a `NeedsUpdateError` → `describeEngineError`) and `track.test`. An unknown `test` on revert → `ToolError('Unknown test ${id}.')`.
  - Summaries: `write ${where ?? address} ${old} → ${new}`, `freeze ${where ?? address} = ${value}`, `watch_writes ${where ?? address} ${duration}s → ${total_sites} sites`, `set_speed ${speed}×`, `test_cheat apply "${name}" (${verify.status})`, `test_cheat revert #${test}`.

- [ ] **Step 1: Write the failing tests**

```ts
it('write reports old → new and records the change', ...)
it('freeze is tracked and shown in the snapshot; unfreeze cancels it', ...)
it('freeze created after the switch went off is cancelled', ...)                 // track throws STOPPED_MIDWAY; h.cancel called
it('watch_writes blocks until the watch ends and returns sites by count', ...)
it('watch_writes returns registers only when asked; duration over 60000 is refused', ...)
it('watch_writes ends early with reason stopped when the player stops the session', ...)
it('set_speed refuses values outside 0.1–10', ...)
it('test_cheat applies a value draft and revert cancels it', ...)
it('test_cheat applies a patch draft and revert restores it', ...)
it('test_cheat rejects absolute addresses but not a missing range', ...)
it('test_cheat refuses a draft that needs updating, with the reasons', ...)
it('at most 8 test cheats at once', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 tools-modify`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass**

Run: `pnpm --filter ./apps/desktop lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2 agent/`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): agent tools that change the game, gated by the player's switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `save_cheat` and `list_cheats`

**Files:**
- Create: `apps/desktop/src/main/agent/tools-library.ts`, `test/main/agent/tools-library.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (register; `catalogTrainerFor`)

**Interfaces:**
- Consumes: `validateAgentCheat` (Task 1); `verifyCheat` (Task 2); `GameIdentity` (Task 3); `saveUserCheat`, `loadUserTrainer` (Task 5); `fetchTrainer`, `fetchTrainerLive`, `getCachedIndex` (`catalog-host.ts`, `trainer-live-fetch.ts`).
- Produces: `libraryTools(deps: { dir: string; catalogTrainerFor(game: GameIdentity): Promise<StarlightTrainer | null>; onSaved(key: string): void; verify?: typeof verifyCheat; now?(): Date }): ToolDef[]` for `save_cheat` and `list_cheats`.
  - `save_cheat`:
    1. `validateAgentCheat(cheat)` → errors joined by `\n` → `ToolError`.
    2. `verifyCheat` on the attached game: `needs-update` → `ToolError('This cheat doesn\'t match the running game: ' + reasons.join('; '))`.
    3. Add `provenance = { kind: 'agent', agent: `${client.name} ${client.version}`, createdAt: now().toISOString(), game: { steamAppId?, buildId?, exeHash? } }` (only the fields that are non-null).
    4. `saveUserCheat(dir, game.key, …, { category, replaces })`, then `onSaved(game.key)`, which broadcasts `userCheats:changed`.
    5. Summary `save_cheat "${name}" → ${game.name}`.
  - `list_cheats`: library cheats from `loadUserTrainer`; catalog cheats from `catalogTrainerFor`, where `index.ts` uses the catalog entry with id `game.catalogId`: `trainerPath` → `fetchTrainer`, `trainerSource` → `fetchTrainerLive`, else `null`. Paging is over each list separately, and only the page's cheats are verified. Unsupported catalog cheats list `unsupported: unsupportedReason`, with verify `{ status: 'unverified', reasons: [] }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('save_cheat rejects absolute addresses with the exact message', ...)
it('save_cheat requires verify.range for value cheats', ...)
it('save_cheat refuses a cheat that does not match the running game', ...)
it('save_cheat adds agent provenance with the build id and exe hash', ...)   // provenance deep-equals { kind:'agent', agent:'claude-code 2.1.0', createdAt:'2026-11-23T12:00:00.000Z', game:{ steamAppId:2784470, buildId:'17012345', exeHash:'ab…' } }
it('save_cheat with replaces repairs the cheat in place', ...)
it('save_cheat tells the game page', ...)                                   // onSaved('9kings')
it('list_cheats returns library and catalog cheats with verify status, paged', ...)
it('list_cheats lists unsupported catalog cheats with their reason', ...)
it('list_cheats works for a game with no catalog entry', ...)
```

- [ ] **Step 2: Run tests and see them fail**

Run: `pnpm --filter ./apps/desktop test -- --maxWorkers=2 tools-library`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests and see them pass, then the full suite**

Run: `pnpm -r build && pnpm -r lint && pnpm --filter ./apps/desktop test -- --maxWorkers=2 && pnpm --filter @starlight/engine test -- --maxWorkers=2 && pnpm --filter @starlight/ct-importer test -- --maxWorkers=2`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): agent save_cheat and list_cheats with provenance and verify

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Live verification (self-launched native target and Proton program)

No new product code is expected. Any bug found goes back to its owning task, with a test. The new files are a Windows test program and the script.

**Files:**
- Create: `packages/engine/test-target/win/gold.c`, `scripts/live-m3.mjs`
- Modify: `packages/engine/test-target/win/Makefile` (adds `build/gold.exe`)

**Interfaces:**
- `gold.exe`: allocates a struct on the heap, `{ pad[0x10]; int32 gold = 500 }`, stores its pointer in a static `g_player`, and every 500 ms calls a `noinline` `earn(void)` that does `gold += 1`. It prints `addr g_player=0x…` once.
- `scripts/live-m3.mjs <native|proton|claude>`. It reuses `live-m2.mjs`'s safety rules: it kills only pids it spawned and their descendants, uses a throwaway prefix, and runs cleanup on signals. It:
  - starts the dev app with a temporary `XDG_CONFIG_HOME` and `--remote-debugging-port=9223` (it waits for 9223 to be free);
  - drives the renderer over CDP (`window.starlight.*` and clicks on real buttons);
  - reads the connect info with `agentConnectInfo()`;
  - connects an SDK MCP client with the token.

- [ ] **Step 1: Build**

Run: `cargo build --release --manifest-path packages/starlightd/Cargo.toml && cargo build --manifest-path packages/starlightd/Cargo.toml && pnpm -r build && make -C packages/engine/test-target && make -C packages/engine/test-target/win`
Expected: `packages/engine/test-target/win/build/gold.exe` exists.

- [ ] **Step 2: Native target, agent flow**

Run `node scripts/live-m3.mjs native`. The script spawns `target --heap-chain --writer` and adds it as a manual game through `updateConfig`. It also spawns `target --map <tmp>/EasyAntiCheat_x64.dll`. It checks:
- `curl` without a token → 401; with `Origin: http://example.com` → 403.
- `list_games` lists both targets, and the second has `antiCheat` set. `attach` to it fails with the anti-cheat message, and no approval card appears.
- `attach` to the first shows the approval card with `… wants to attach to target — Allow?`; clicking **Allow** attaches, and the Agent view opens.
- While the session is attached, `dbus-monitor "interface='org.freedesktop.Notifications'"` sees the approval and the `ask_player` notifications.
- `scan_first int32 exact 777` → `ask_player confirm` (answered by clicking **Yes**) → `pointer_scan` finds `target+… → 0x18 → 0x10`.
- `test_cheat` freezes it at 9999 (`/proc/<pid>/mem` reads 9999), then reverts. `save_cheat` succeeds with range 0–100000.
- `watch_writes` on `g_counter` → a site inside `bump_counter` → `make_signature` → `test_cheat` with a `writeBytes c3` patch stops `g_counter`; revert resumes it. `save_cheat` saves the patch.
- The activity panel lists every call.
- Turning **Agent can modify the game** off makes `write` refuse with `MODIFY_OFF`.
- **Stop**: within 1 s, `TracerPid` is 0, `bump_counter`'s bytes are the originals, and a direct write to `heap_value` sticks.

Expected: every check prints `ok`.

- [ ] **Step 3: Restart survival from the game page**

Still in `native` mode, the script kills the target, spawns a new one, and opens its page (the manual game's tile). It checks:
- **My cheats** shows both cheats as yours.
- If a CE session started for it, toggling the pointer cheat shows the close-table confirm; **Continue** closes CE.
- The pointer cheat freezes the new `heap_value` at 9999.
- The patch cheat stops `g_counter`, and toggling it off resumes it.
- Quitting the app restores `bump_counter`'s bytes.
- One cheat saved with a deliberately wrong range (`verify.range 0–10`) shows **Needs updating** and won't enable.

Expected: all `ok`.

- [ ] **Step 4: Proton program**

Run `node scripts/live-m3.mjs proton`. It runs `gold.exe` with Proton 11.0 `run`, a fresh `STEAM_COMPAT_DATA_PATH=$(mktemp -d)/pfx`, and `STEAM_COMPAT_CLIENT_INSTALL_PATH=$HOME/.steam/steam`. It finds the Linux pid whose comm is `gold.exe` **among its own descendants**. It checks:
- `list_games` shows it with `proton: true`.
- attach (approved over CDP), then a scan for 500, then `ask_player`, then `scan_next increased`.
- `watch_writes` reports a site whose `where` starts with `gold.exe+0x`.
- `make_signature` → `test_cheat` patch → `save_cheat`.
- After restarting `gold.exe` in the same throwaway prefix, the tools-only game page (opened from **Running now**) lists the cheat, and enabling it stops `gold`.

Expected: all `ok`. Record anything Proton-specific.

- [ ] **Step 5: A real agent (only if the `claude` CLI is installed)**

Run `STARLIGHT_LIVE_CLAUDE=1 node scripts/live-m3.mjs claude`. It writes a temp MCP config with the URL and token, then runs `claude -p "Use the starlight tools: attach to the game named target (pid <pid>), find the 32-bit value that is 777 right now, build a cheat that freezes it at 9999 that survives a restart, test it and save it." --mcp-config <tmp> --strict-mcp-config --allowedTools "mcp__starlight"` against a fresh `target --heap-chain`. The script plays the player: it clicks **Allow**, answers confirm questions **Yes**, and answers number questions with the current `heap_value` read from `/proc`. If `codex` is installed, it also checks the snippet with `CODEX_HOME=$(mktemp -d)`, a `config.toml` holding `codexConfig`, and `codex mcp list` (expects `starlight`).

Expected: a library cheat is saved, its address resolves to `heap_value`, and after a target restart it toggles from the game page. Note the token cost and transcript length in the PR.

- [ ] **Step 6: Record results**

Write the outcomes (anything skipped, Proton surprises, the Claude run) in the PR description and update memory `starlight-native-engine-plan.md`. Commit:

```bash
git add packages/engine/test-target/win scripts/live-m3.mjs
git commit -m "test: live verification for native engine milestone 3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Follow-ups (later milestone plans)

- **Milestone 4** (separate plan): the AA-subset compiler emits v2 `patch` cheats with `disable` steps. The M3 runner refuses those (D8), so M4 extends `enableCheat`. It also covers the engine-agnostic session (this replaces Task 4's starlightd mode with a real `starlightd` backend for CT tables, and moves the speed buttons for good), `ct-runner` routing with reason codes, and the coverage script.
- An E2E run on a real Proton game (spec §12: 9 Kings) needs the player present. The live task only uses self-launched programs.
- `list_cheats` for catalog games only covers importer-supported records until M4 compiles script records. Repairing a CE script cheat waits for M4.
- Signature builder backward extension (M2 D22) and freeing hook pages (M2 D9) are still open.
- Game Mode (gamescope) gets notifications only. A real overlay is future work (spec non-goal).
