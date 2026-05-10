# @starlight/desktop

Electron desktop app for Starlight. Phase 3: clickable UI shell with hard-coded data. Phase 4 will wire the engine and importer.

## Develop

```bash
pnpm --filter @starlight/desktop dev
```

Opens the dev window with HMR.

## Build

```bash
pnpm --filter @starlight/desktop build
```

Produces `out/{main,preload,renderer}/`.

## Test

```bash
pnpm --filter @starlight/desktop test
```

Component tests run in jsdom via Vitest. No Electron is started.

## End-to-end Phase 4 demo

Phase 4 connects the renderer to the real engine. To run the full demo against the C test target:

1. **Build the C test target:**
   ```bash
   make -C packages/engine/test-target
   ```

2. **Run the test target (it idles and prints its memory addresses):**
   ```bash
   packages/engine/test-target/build/target &
   ```
   Note the PID from `echo $!`.

3. **(Linux only) Lower ptrace_scope** so the desktop app can attach:
   ```bash
   sudo sysctl kernel.yama.ptrace_scope=0
   ```

4. **Start the desktop app:**
   ```bash
   pnpm --filter @starlight/desktop dev
   ```

5. **In the app:** click "Load Trainer (.CT)" on the Home screen, pick `packages/engine/test-target/target.CT`. Then go to Active Trainer, type the PID, click Latch. The pill goes green.

6. **Test toggles:** click "Health" to freeze. Press F1 globally to toggle from anywhere on the desktop. Type a new value into the Speed stepper.

7. **Test process-exit:** in the terminal, `kill <pid>` the test target. The desktop app should clear active state and show "Process exited."

## Phase 4.5 demo additions

Phase 4.5 adds Library auto-detection, process-picker auto-fill, and Inc/Dec hotkeys. Run through the Phase 4 demo first (test target latched), then continue:

3. **Library tab:** Click "Library" in the sidebar. If Steam is installed, the grid shows boxart tiles for each detected game. If Steam is absent (or no games are installed), the empty-state message is shown instead.

4. **Process picker auto-fill:** Click "Home" → "Load Trainer (.CT)" → pick `packages/engine/test-target/target.CT`. Navigate to Active Trainer. Because the trainer's `processName` list is `['target', 'target.exe']`, the process picker should automatically highlight the running `target` PID. Select it and click Latch.

5. **Inc/Dec hotkeys:** With the trainer latched and the "Speed" cheat toggled on, press the Inc hotkey (default `F4+Up` as specified in the .CT accelerators) and confirm the displayed value increases by one `step`. Press the Dec hotkey (`F4+Down`) and confirm it decreases. The test-target binary prints ticking values to stdout — the stepped delta should be visible there.

6. **Detach:** Click Detach. The process-poll loop resumes. Minimise the window and confirm CPU drops; restore and confirm the UI updates.

## Phase 5.0 demo additions

7. **Browse / Search:** the static placeholder catalog is gone. Browse renders the live catalog from `https://darkharasho.github.io/starlight/catalog/index.json` (cached under `<userData>/catalog-cache/`), or the bundled `packages/catalog/` files in dev. Search filters by name across the same data.
8. **Home — Installed Games With Trainers:** appears when your detected Steam library overlaps the catalog (joined by `steamAppId`).
9. **Library "Trainer" badge:** lit when the tile's Steam App ID matches a catalog entry.
10. **Catalog from a tile:** clicking a tile fetches the per-trainer JSON and activates it without a `.CT` dialog.

Note: the live catalog URL becomes reachable only after the `Publish Pages` GitHub Actions workflow completes its first run. To enable that workflow on a fresh clone, go to GitHub → repo Settings → Pages → Source: "GitHub Actions" and trigger the workflow (push to main or use Run workflow). Until then, the in-app Browse view will show "Catalog unavailable" with a Retry button.

## Phase 5.1 demo additions

11. **Settings route:** sidebar → Settings → adjust the process-poll interval (500–30000ms) and toggle "Refresh catalog on launch". Changes persist to `<userData>/config.json` and apply live.
12. **Recently Played:** Home tab now shows the last 6 trainers you opened. Catalog entries are clickable; file-loaded `.CT` entries are display-only.
13. **Process-name override persistence:** in Active Trainer → Trainer Info, edit the process name. The change is saved per-trainer and re-applied next time you open it.
14. **Corrupt config recovery:** if `config.json` ever becomes unreadable, Starlight backs it up as `config.json.corrupt-<ts>` and starts fresh.

## Phase 5.2 demo additions

15. **Add manually:** Library tab now has an "Add manually" button. Click → pick an executable on disk → enter a display name → Save. The game appears as a tile alongside auto-detected entries.
16. **Manual tile boxart:** if your manual entry's exe basename matches a catalog game's `processName[]` (e.g. `eldenring.exe`), Starlight renders that game's Steam CDN cover. Otherwise the tile shows a name-only placeholder (until Phase 5.5 adds SteamGridDB fallback).
17. **Remove a manual entry:** hover a manual tile and click the `×` in the top-right. Confirms before removing from your config.

## Phase 5.3 demo additions

18. **Rebind a hotkey:** open a trainer → on any cheat card click the ✎ next to a hotkey badge → press your new key combo (e.g. `Ctrl+Shift+G`). The new accelerator binds live. Press Esc to cancel.
19. **Clear a hotkey:** click the ↺ button to clear the slot. The hotkey is unregistered immediately, regardless of whether it was a default or a previous override.
20. **Conflict detection:** if your new accelerator is already bound to another cheat in this trainer, an inline error appears and the rebind is rejected before reaching the OS.
21. **Persistence:** overrides save per-trainer-per-cheat to `<userData>/config.json` and re-apply automatically next time you open that trainer.

## Phase 5.4 demo additions

22. **Indexer:** `pnpm --filter @starlight/indexer build && node packages/indexer/dist/index.js`
    reads `packages/indexer/seeds.yaml`, downloads each URL (direct `.CT` or zip-with-CT),
    runs `@starlight/ct-importer`, writes `packages/catalog/trainers/<id>.json`, and
    regenerates `packages/catalog/index.json`. Idempotent via SHA-256 cache.
23. **Cron:** `.github/workflows/indexer.yml` runs the indexer weekly (Sunday 06:00 UTC) +
    on demand. Opens a PR with the diff via `peter-evans/create-pull-request`. Authorize
    the action in repo Settings → Actions → "Allow GitHub Actions to create and approve
    pull requests" before the first run.
24. **Curate seeds:** edit `packages/indexer/seeds.yaml` with the fearlessrevolution URLs
    you want indexed. Each entry needs `url`, `name`, `processName[]`, `platform[]`;
    `steamAppId` and `tags` are optional but recommended. Direct `.CT` and `.zip`
    (containing one `.CT`) URLs are both supported.

## Phase 5.5 demo additions

25. **SteamGridDB fallback:** non-Steam games (manual entries, future Epic/Heroic/Lutris)
    that don't have a Steam CDN cover now fall back to SteamGridDB grid art. Set
    `STEAMGRIDDB_API_KEY=<your-key>` in your environment before launching the app to
    enable. Without the key, tiles continue to show the existing name-only placeholder.
26. **Cache:** resolved URLs are cached in `<userData>/boxart-cache.json`. Positive results
    are cached indefinitely; negative results (no art found) refresh after 24h. Delete the
    cache file to force a re-resolve.
27. **Get a key:** sign up at https://www.steamgriddb.com/profile/preferences/api and
    create an API key. Free, rate-limited (sufficient for personal use).

## Phase 4.5 / 5 deferred items
- Library auto-detection (Steam) — DONE — Phase 4.5
- Process auto-detection — DONE — Phase 4.5
- Inc/Dec hotkeys for value cheats — DONE — Phase 4.5
- Catalog repo + community trainer index — DONE — Phase 5.0
- User config persistence (processName overrides, recents, preferences, manual games, hotkey overrides) — DONE — Phase 5.1
- Manual library entries UI — DONE — Phase 5.2
- Hotkey rebinding UI + `HotkeyCapture` — DONE — Phase 5.3
- Periodic indexer — DONE — Phase 5.4
- SteamGridDB boxart fallback — DONE — Phase 5.5
- Epic / Heroic / Lutris scanners (replace 4.5 stubs) — Phase 5.6
- Astro product page real content — Phase 5.7
