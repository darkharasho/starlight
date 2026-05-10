# Cheat Engine Runtime Bridge — Design

**Status:** approved 2026-05-10
**Predecessor:** Phase 6.1 catalog work (HEAD `d05e067`)

## Problem

Most fearlessrevolution trainers ("Type B" in our taxonomy) require Cheat
Engine's runtime: AOB scans, x86 asm patches via `<AssemblerScript>` blocks,
Lua activation logic, symbol tables. Without that runtime our static parser
yields ~50% of CK3-class entries as toggleable; the rest have symbolic
addresses (`pSelectedCharacter`, `+1A8`) that need CE machinery to resolve.

Reimplementing CE's runtime ourselves is a 2–6 week project plus permanent
maintenance burden as fearlessrevolution authors adopt new CE idioms.

## Decision

Don't reimplement. Bundle Cheat Engine itself, run it headless, drive it
over HTTP from our Electron app. CE handles 100% of the hard parts —
assembler, Lua, AOB scans, symbol tables, asm patching — and our app
provides the curated catalog UI and library detection.

## Spike findings (2026-05-10)

Manual probing of `CheatEngineLinux766-4` against the user's Bazzite
Wayland system established these capabilities:

| Capability | Result |
|---|---|
| Native Linux ELF (no Wine) | ✅ `cheatengine-x86_64` runs natively, Qt6 GUI |
| `autorun/*.lua` runs on startup | ✅ Confirmed via file-based heartbeat |
| `getMainForm():hide()` keeps window invisible | ✅ MainForm.Visible stays false; only an unmapped Qt utility window remains |
| `getInternet()` HTTP I/O from Lua | ✅ Returns a working internet client |
| Download | 24 MB compressed, ~150 MB extracted |

One assumption flipped during the spike:

- ❌ **LuaSocket is not bundled** with CE Linux. The original plan was
  bidirectional raw TCP, which would need `require 'socket'`.
- ✅ **HTTP via `getInternet()` is available** and is actually cleaner.
  Standard tooling on both sides, no custom framing.

## Architecture

```
┌─────────────────────────────┐                ┌──────────────────────────┐
│  Starlight (Electron main)  │ HTTP           │  cheatengine-x86_64      │
│                             │ poll/post      │  (native Linux ELF,      │
│  HTTP server on :PORT       │ ◄────────────► │   MainForm hidden)       │
│  Command queue              │                │                          │
│  Event handler              │                │  autorun/zzz-starlight   │
│  Process lifecycle mgr      │                │  HTTP poll loop          │
└─────────────────────────────┘                │  Dispatches commands     │
        ▲                                      │  to AddressList records  │
        │ JSON-RPC                             └────────────┬─────────────┘
        │                                                   │
        │                                                   ▼
┌──────────────────────────┐                       ┌──────────────────┐
│  Renderer (React)        │                       │  Target game     │
│  ToggleCheatCard /       │                       │  process         │
│  ValueCheatCard          │                       └──────────────────┘
└──────────────────────────┘
```

### Process lifecycle

1. User clicks a Library tile.
2. Main process verifies CE runtime is installed; if not, runs setup flow.
3. Main process downloads the .CT (existing behavior).
4. Main process spawns `cheatengine-x86_64 <ct-path>`. CE's autorun
   discovers `zzz-starlight.lua`, hides MainForm, opens HTTP poll loop.
5. Main process polls CE bridge for `list_records` → renders cheats.
6. User toggles → JSON-RPC → CE flips record → game changes.
7. User detaches → main sends `shutdown` → CE runs `[DISABLE]` scripts and exits.

### IPC protocol — JSON-RPC over HTTP

Electron main hosts an HTTP server on `127.0.0.1:<random-port>` written
into the Lua autorun's startup config (env var or auxiliary file). The
control script long-polls `GET /poll` (5s timeout) for commands and
`POST /event` to send results / state changes back.

Initial command set (extensible):

| Method | Args | Returns |
|---|---|---|
| `list_records` | none | `[{id, name, address, valueType, type, parentId, isActive, isGroupHeader, hasScript}…]` |
| `set_active` | `{id, active: bool}` | `{ok, error?}` |
| `read_value` | `{id}` | `{value: string}` (CE formats per type) |
| `write_value` | `{id, value: string}` | `{ok}` |
| `open_process` | `{processName: string}` | `{pid?: number, ok}` |
| `shutdown` | none | `{ok}` (CE exits after replying) |

Events from CE → main:

| Event | Payload |
|---|---|
| `attached` | `{pid, processName}` |
| `detached` | `{}` |
| `record_changed` | `{id, isActive, value?}` |
| `error` | `{message, context?}` |

### Distribution model

| Component | Where | Size | When |
|---|---|---|---|
| CE Linux | `starlight-runtimes` GitHub Release | ~24 MB compressed | First-run, auto |
| CE Windows | same release | similar | First-run, auto |
| macOS support | flagged experimental; CE's `.app.zip` linked | external | manual |

The `starlight-runtimes` repo holds the runtime tarballs and a
`manifest.json` with version, SHA256, download URL per platform. Our app
fetches `manifest.json` on first need, downloads the matching asset, and
verifies before extracting to `~/.local/share/starlight/runtime/`
(or platform equivalent).

### License compliance

CE is GPLv2. We distribute the binaries unchanged with:

- An attribution screen in our app linking to upstream sources at
  `https://github.com/cheat-engine/cheat-engine`.
- A `LICENSE.gpl-v2.txt` file alongside the bundled binaries.
- The `starlight-runtimes` README documents the source provenance.

CE runs in its own process and we communicate over HTTP — no static
linking — so our app's MIT license is unaffected.

## Failure modes

- **CE crashes mid-session.** Watchdog detects process exit; renderer
  shows "trainer engine crashed, retry?" modal; on retry we relaunch CE
  with the same .CT.
- **CE network access blocked.** The autorun script fails to reach our
  HTTP server. The CE window briefly flashes (until the timer can call
  `hide()`); user sees CE without our control. Mitigation: bind to
  `127.0.0.1` only (no firewall path), and the autorun's first action
  is `hide()` — no network needed for that.
- **Runtime download fails / partial.** Setup modal shows error with
  retry. Existing partial files are deleted and re-downloaded.
- **Game has anti-cheat.** Same problem any CE user has. Out of scope.

## Out of scope

- Replicating CE's UI in our renderer (we surface only the cheat list +
  toggle/value cards we already have).
- Non-fearlessrevolution table sources.
- Driving CE on macOS (deferred until CE itself improves Mac support).
- Hot-reloading CE's Lua state if user edits the .CT mid-session.
