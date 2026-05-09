# Starlight — Design Spec

**Status:** Draft v1
**Date:** 2026-05-08

A cross-platform Electron app that wraps community cheat tables in a polished, WeMod/Aurora-style UI. Detects running games, attaches to their processes, and exposes their cheats as toggles, sliders, and global hotkeys.

---

## 1. Goals & Non-Goals

### Goals
- **Cross-platform desktop app** — Windows, Linux, macOS — built on Electron.
- **WeMod/Aurora-style UX** — boxart-driven discovery, one-click latch, polished cheat-table view with toggles, value steppers, and global hotkeys.
- **Tap the existing community library** — import Cheat Engine `.CT` files (the de-facto open format, hosted at fearlessrevolution.com and elsewhere) and execute the convertible subset.
- **Hide implementation details from the user** — they see "Infinite HP" and a toggle, not XML or memory addresses.
- **Distinctive Neon Arcade visual identity** — dark cyberpunk grid background, neon cyan/magenta/green accents, sharp edges.

### Non-Goals (v1)
- **Full Cheat Engine parity.** Lua scripts and complex assembler injection are flagged as unsupported, not executed. Users with such cheats are directed to open the original `.CT` in Cheat Engine.
- **Authoring new cheats from scratch.** No memory scanner, no AOB-discovery UI. v1 imports existing tables only.
- **Anti-cheat evasion.** This is for offline/single-player use. Multiplayer/online detection is the user's risk.
- **Mobile / console support.**
- **Tapping WeMod's catalog.** Their content is proprietary and DRM-protected.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│  Electron Renderer (React + TypeScript)             │
│  ─ Home / Library / Browse / Search / Active Trainer│
│  ─ Neon Arcade theme                                │
└──────────────┬──────────────────────────────────────┘
               │ IPC (typed, contextBridge)
┌──────────────▼──────────────────────────────────────┐
│  Electron Main Process                              │
│  ┌────────────────┐  ┌─────────────────────────┐    │
│  │ Process Watcher│  │ Catalog Service         │    │
│  │ (poll ps-list) │  │ (fetch + cache index)   │    │
│  └────────┬───────┘  └─────────────────────────┘    │
│           │                                          │
│  ┌────────▼───────┐  ┌─────────────────────────┐    │
│  │ Trainer Engine │  │ .CT Importer            │    │
│  │ (Frida bridge) │  │ (XML → Starlight JSON)  │    │
│  └────────┬───────┘  └─────────────────────────┘    │
│           │          ┌─────────────────────────┐    │
│           │          │ Hotkey Manager          │    │
│           │          │ (global, cross-platform)│    │
│           │          └─────────────────────────┘    │
└───────────┼──────────────────────────────────────────┘
            │ frida-node
┌───────────▼──────────────────────────────────────────┐
│  Frida Agent (injected JS in target process)         │
│  ─ Memory.read*/write*, Memory.scan, pointer chains  │
│  ─ Freeze loops, Interceptor hooks                   │
└──────────────────────────────────────────────────────┘
```

**Process model.** Renderer is pure UI — never touches memory or files directly. Main process owns all engines and exposes a typed IPC surface. Frida runs as a separate native subsystem invoked from main.

---

## 3. Components

### 3.1 Trainer Engine (Frida-based)
The memory layer. Wraps `frida-node` to provide:
- **Attach / detach** to a target process by PID or process name.
- **Read / write** typed values at addresses.
- **Pointer-chain resolution** — `module + base → +o1 → +o2 → …`.
- **AOB scan** — module-scoped pattern search, returns matching addresses.
- **Freeze loop** — periodic write of a value (10–30 Hz) for "always X" cheats.
- **Code hook** — `Interceptor.attach` for simple "skip damage subtraction"-style cheats translated from CT assembler scripts.

**Why Frida:** cross-platform (Win/Mac/Linux), official Node bindings, battle-tested in reverse-engineering. Alternatives considered (libmem, custom Rust engine) require us to build and maintain native bindings.

**Linux note:** Frida requires `ptrace` permission. App will detect `kernel.yama.ptrace_scope` and surface a clear instruction dialog if blocked.

### 3.2 `.CT` Importer
Parses Cheat Engine `.CT` XML and converts each entry into Starlight Trainer JSON. Handles:

| Construct | Conversion |
|---|---|
| Static address (`module+offset`) | Direct |
| Pointer chains (`<Offsets>`) | Direct |
| AOB scan entries (pattern + offset) | Direct (Frida `Memory.scan`) |
| Type info (Byte, 2/4/8 Bytes, Float, Double, String, Array of Bytes) | Direct map to Starlight types |
| Group/folder structure | Preserved as categories |
| Hotkey definitions | Preserved when present; defaults assigned otherwise |
| Simple "freeze value" entries | Direct (freeze loop) |
| Simple assembler hooks (`db ##`, NOP-out, conditional jump flip) | Best-effort translation to `Memory.patchCode` |
| Complex assembler with `aobscanmodule + alloc + label` flow | Flagged unsupported |
| Lua scripts (`{$lua}`) | Flagged unsupported |

Each unsupported entry is preserved in the JSON with `unsupported: true` and a reason, so the UI can render it greyed-out with the "open in Cheat Engine" affordance.

**Realistic conversion rate:** ~60–80% of entries in typical community tables. The product works around the rest.

### 3.3 Catalog Service
Manages the searchable game catalog.

- **Index source:** A separate GitHub-hosted repo `starlight-trainers` containing:
  - `index.json` — array of `{steamAppId, name, processName[], coverUrl, trainerCount, lastUpdated}`
  - `trainers/<steamAppId>.json` — pre-converted Starlight Trainer files (one or more per game)
- **Periodic indexer** (separate tooling, not part of the app): crawls fearlessrevolution, runs `.CT` files through the importer, commits results to the repo. Runs on a schedule (GitHub Actions). Out of scope for v1 of the app itself, but the index format is part of this spec.
- **Client behavior:** App fetches `index.json` on launch (cached locally with ETag), falls back to cache when offline. Lazy-fetches per-game trainer files on demand.
- **Boxart:** Steam CDN (`cdn.cloudflare.steamstatic.com/steam/apps/{id}/library_600x900.jpg`) by default; SteamGridDB fallback for non-Steam games.

### 3.4 Game Detection / Library
Two parallel mechanisms:

**Installed-games detection (Library tab):**
- **Steam:** parse `libraryfolders.vdf` and `appmanifest_*.acf` (cross-platform format).
- **Epic Games (Win/Mac):** read `~/AppData/Local/EpicGamesLauncher/Saved/Config/...` JSON manifests.
- **Heroic (Linux):** read `~/.config/heroic/` library JSON.
- **Lutris (Linux):** read `~/.local/share/lutris/games/` SQLite DB.
- **Manual:** user adds an executable path → tries to match it against the catalog by filename.

**Running-process detection (Latch):**
- `ps-list` (Node module, cross-platform) polled every 2s.
- Match by exe name from `processName[]` in catalog entries.
- When a match appears, the latch pill animates and "Latch" becomes the primary action.

### 3.5 Hotkey Manager
Cross-platform global hotkeys via Electron's `globalShortcut` API. Each cheat can register up to three hotkeys: `on` (toggle), `inc`, `dec`. Conflict detection prevents duplicate bindings; bindings persist per-trainer in user config.

### 3.6 UI (Renderer)
React + TypeScript. Five top-level routes (sidebar nav):

1. **Home** — recently played, featured trainers, "X installed games have trainers" callout.
2. **Library** — auto-detected installed games as a boxart grid; badges for "has trainer" and "running".
3. **Browse** — full catalog as boxart grid, filters (genre, has-trainer-only, sort by recency/popularity).
4. **Search** — text search across the catalog; "request a trainer" CTA when no result.
5. **Active Trainer** — appears as the visible/active route when a game is latched. Categories sidebar + cheat cards.

**Top status bar** is global: shows current latch state with pulsing pill (`Waiting for game` / `Game detected — click to Latch` / `LATCHED`).

**Cheat card variants:**
- **Toggle cheat:** title, description, hotkey badge, on/off toggle.
- **Value cheat:** title, description, inline `−`/value/`+` stepper, hotkey *stack* (toggle / increase / decrease), on/off toggle. Step size and clamp range configurable per cheat.
- **Unsupported cheat:** dimmed, "UNSUPPORTED" amber tag, hotkey "—", helpful tooltip.

Visual style: **Neon Arcade** — `#07070b` background with subtle 26px cyan/magenta grid lines, `#00ffc8` (cyan) for primary actions and active states, `#ff00b4` (magenta) for category accents and "waiting" status, `#00ff7a` (green) for "LATCHED" and active cheats. Sharp 3–4px corners, 1px borders, neon `box-shadow` glow on active items.

---

## 4. Data Model: Starlight Trainer Format

```json
{
  "schemaVersion": 1,
  "id": "starlight-elden-ring-frx-1",
  "game": {
    "name": "Elden Ring",
    "steamAppId": 1245620,
    "processName": ["eldenring.exe", "start_protected_game.exe"],
    "version": "1.16",
    "platform": ["windows", "linux-proton"]
  },
  "metadata": {
    "author": "FLiNG (FRX)",
    "source": { "url": "https://fearlessrevolution.com/...", "convertedFrom": ".CT" },
    "convertedAt": "2026-05-01T12:00:00Z",
    "warnings": ["4 entries unsupported (Lua scripts)"]
  },
  "categories": [
    {
      "name": "Player",
      "cheats": [
        {
          "id": "infinite-hp",
          "name": "Infinite HP",
          "description": "Freezes current HP at maximum.",
          "type": "freeze",
          "valueType": "float",
          "value": 999999.0,
          "address": {
            "kind": "pointer",
            "module": "eldenring.exe",
            "baseOffset": "0x4A2B3C",
            "offsets": ["0x10", "0x20"]
          },
          "hotkeys": { "toggle": "F1" }
        },
        {
          "id": "movement-speed",
          "name": "Movement Speed Multiplier",
          "type": "set",
          "valueType": "float",
          "default": 1.0,
          "step": 0.1,
          "min": 0.1,
          "max": 10.0,
          "address": { "kind": "aob", "module": "eldenring.exe", "pattern": "F3 0F 11 ?? ?? ?? ?? F3 0F 10", "offset": "+0x3" },
          "hotkeys": { "toggle": "F4", "inc": "F4+Up", "dec": "F4+Down" }
        },
        {
          "id": "auto-block",
          "name": "Auto-Block Script",
          "unsupported": true,
          "unsupportedReason": "Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.",
          "originalSource": "<lua-script-bytes>"
        }
      ]
    }
  ]
}
```

---

## 5. Data Flow Examples

### 5.1 First launch
1. App boots, renderer mounts, sidebar shows nav.
2. Main fetches `index.json` from `starlight-trainers` repo (or loads cache).
3. Library detector scans Steam/Epic/Heroic/Lutris → emits `library:games` event.
4. Renderer renders Home with detected installed games + "has trainer" badges.

### 5.2 Game launch + latch
1. User opens Elden Ring (any way — Steam, manual, Heroic).
2. Process watcher sees `eldenring.exe` → matches catalog → emits `process:detected`.
3. Latch pill animates magenta → "Game detected — click to Latch".
4. User clicks Latch.
5. Main fetches `trainers/1245620.json` if not cached.
6. Frida agent injects into PID. Memory engine resolves all addresses (pointer walks, AOB scans).
7. Hotkey manager registers per-cheat global shortcuts.
8. Latch pill turns green ("LATCHED"). Renderer routes to Active Trainer view.

### 5.3 Toggle a freeze cheat
1. User clicks the toggle on "Infinite HP" (or presses F1).
2. Renderer sends `cheat:toggle { id: "infinite-hp", on: true }`.
3. Trainer engine starts freeze loop: every 50ms, write `999999.0` to resolved address.
4. UI updates to green-glow active state.

### 5.4 Adjust a value cheat
1. User clicks `+` on Movement Speed (or presses F4+Up).
2. Renderer sends `cheat:setValue { id: "movement-speed", value: 1.6 }`.
3. Trainer engine writes new value (and continues freeze if active).

### 5.5 Game closes
1. Process watcher notices `eldenring.exe` is gone.
2. Main tears down Frida session, unregisters hotkeys.
3. Latch pill returns to magenta "Waiting for game".

---

## 6. Cross-Platform Considerations

| Concern | Windows | Linux | macOS |
|---|---|---|---|
| Memory R/W | Frida — works | Frida — needs `ptrace_scope ≤ 1` | Frida — needs codesign + `task_for_pid` entitlement |
| Privilege | Usually user-mode for non-DRM games; some need admin | Usually user-mode if ptrace allowed; some need root | Hardened runtime + entitlements; non-trivial dev signing |
| Global hotkeys | `globalShortcut` works | `globalShortcut` works on X11; Wayland is partial | `globalShortcut` works |
| Game detection (Steam) | `libraryfolders.vdf` standard | Same | Same |
| Proton/Wine games (Linux) | n/a | Process is the wine-wrapped exe; latch by exe name still works because Frida sees the Linux process |

**v1 Linux scope:** X11 first (Wayland hotkeys deferred). Proton games are supported because Frida attaches to the Linux process.

**v1 macOS scope:** Best-effort. Codesigning + entitlements add significant complexity; we'll document the dev-build path and defer signed-distribution to v2.

---

## 7. Error Handling

- **Frida attach fails (permissions):** Show actionable dialog with platform-specific fix (`sudo sysctl kernel.yama.ptrace_scope=0` on Linux, "Run as Admin" on Windows).
- **Pointer chain resolves to invalid memory:** Cheat marks itself "unstable", auto-disabled, user notified inline on the cheat card.
- **AOB scan returns 0 or >1 matches:** Cheat disabled with "version mismatch — game may have been updated since this trainer was made"; user can submit feedback to the catalog.
- **Game updates mid-session:** Process exit triggers automatic detach; user notified.
- **Unsupported cheat toggled:** Toggle is disabled at the UI level; clicking shows the "open in Cheat Engine" tooltip.
- **Catalog fetch fails:** Falls back to local cache; banner shows "offline mode".

---

## 8. Testing Strategy

- **Unit tests:** `.CT` importer (against a corpus of real `.CT` files committed to the repo as fixtures), Starlight format validator, pointer-chain resolver logic, hotkey conflict detection.
- **Integration tests:** Trainer Engine against a small purpose-built target binary (a "test game" with known memory layout) — enables freeze, set, AOB scan, and pointer-chain tests in CI on all three platforms.
- **Manual / smoke:** A list of 10 known-good trainers (Elden Ring, Stardew Valley, etc.) exercised manually before each release.
- **No network in tests:** Catalog Service is mocked in unit/integration tests; index fetching is tested separately with recorded fixtures.

---

## 9. Tech Stack

| Layer | Choice |
|---|---|
| Shell | Electron (latest stable) |
| Renderer | React + TypeScript + Vite |
| Styling | Tailwind (custom theme tokens for Neon Arcade palette) |
| State | Zustand (lightweight, fits the small main↔renderer surface) |
| Memory engine | Frida via `frida-node` |
| Process listing | `ps-list` |
| `.CT` parsing | `fast-xml-parser` |
| Build / packaging | electron-builder |
| Testing | Vitest + Playwright for UI smoke |

---

## 10. Phased Delivery

This spec is large. The implementation plan should sequence it as:

1. **Phase 1 — Engine spike.** Frida + frida-node attaching to a test process, reading and writing memory, on Linux + Windows. No UI yet. Validates the foundation.
2. **Phase 2 — `.CT` importer + Starlight format.** Parse a corpus of real `.CT` files; emit Starlight JSON; report conversion stats. Pure data, no UI.
3. **Phase 3 — Electron shell + Neon Arcade UI.** Static screens for all five routes with hard-coded data. No engine wiring yet.
4. **Phase 4 — Wire engine to UI.** Library detection, process watcher, latch flow, toggle + value cheats, hotkeys.
5. **Phase 5 — Catalog repo + indexer.** Set up `starlight-trainers` GitHub repo + indexing tooling. App pulls real catalog.
6. **Phase 6 — Polish + cross-platform hardening.** macOS path, Wayland investigation, error states, packaging.

Each phase is its own implementation plan.

---

## 11. Open Questions / Risks

- **Frida + DRM/anticheat games.** Many high-profile games (anti-cheat protected MP) will refuse Frida attach. We'll list this as a known limitation; ratings on each catalog entry can flag "may not work with anti-cheat".
- **Distribution signing.** Code-signing Electron apps (especially macOS) costs money and adds release complexity. v1 may ship unsigned; document the install path.
- **Catalog moderation.** Community-PR'd trainers could ship malicious payloads if we accept arbitrary JSON. Mitigation: schema validation rejects anything beyond declarative addresses + values; no script execution from catalog content. Anything that *could* be code-injection (e.g. `Memory.patchCode`) goes through the importer's whitelist of patterns we recognize.
- **Legal posture.** Hosting `.CT` files ourselves vs. linking to fearlessrevolution. v1: link only, convert client-side; the catalog repo holds JSON we generated, keyed to a source URL. We do not redistribute Cheat Engine content directly.
