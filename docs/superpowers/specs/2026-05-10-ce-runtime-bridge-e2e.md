# CE Runtime Bridge — End-to-End Walkthrough

Status: ready to test  ·  Companion to `docs/superpowers/specs/2026-05-10-ce-runtime-bridge-design.md`

This is the manual walkthrough for verifying the CE runtime bridge against
real fearlessrevolution trainers. Run it after the unit suite passes.

## Pre-flight

- `pnpm --filter @starlight/desktop test` — should be 230+ green.
- `pnpm --filter @starlight/desktop build` — clean.
- The runtimes manifest is reachable:

  ```bash
  curl -sSL https://raw.githubusercontent.com/darkharasho/starlight-runtimes/main/manifest.json | python3 -m json.tool
  ```

## First-run setup

1. Wipe any prior runtime state to test the cold-start:

   ```bash
   rm -rf ~/.config/@starlight/desktop/runtime
   rm -rf ~/.config/@starlight/desktop/ct-cache
   ```

2. Start the app: `pnpm dev`.
3. **Expect** the `RuntimeSetupModal` appears on first paint with:
   - "Set up the trainer engine" header
   - GPLv2 attribution + link to cheat-engine sources
   - "Set up" button
4. Click **Set up**. Modal updates to show:
   - phase: `downloading` with progress bar
   - then `verifying`
   - then `extracting`
   - then `done` and the modal disappears
5. Verify on disk:

   ```bash
   ls ~/.config/@starlight/desktop/runtime/CheatEngineLinux766-4/cheatengine-x86_64
   # → exists, mode +x
   ```

## Smoke: launch a real trainer

Pick a known-working fearlessrevolution thread. Suggested test target: CK3
(viewtopic id 13576 — that's a Type B asm-heavy table that should fully
work via CE).

1. In the app, navigate to **Browse**, scroll to "Crusader Kings III" (or
   search via /search).
2. Click the tile.
3. **Expect**:
   - Loading overlay: "Fetching trainer…"
   - Small flash (~1-2s) — CE process starting up invisibly
   - Navigates to /active route
   - The route renders **CeSessionView**: flat list of records with
     toggle buttons. Section headers visible.
   - No CE window pops up. Verify with `wmctrl -lx | grep -i cheat` —
     should find no visible CE window.
4. With the target game running on your system, click **Latch** in CE (or
   directly attach via the CK3 process — CK3 must be open). Then toggle a
   cheat in our UI:
   - Click "Off" → "On" on a record like "Health".
   - **Expect** the button updates to On after a short delay (the
     bridge round-trips through CE).
5. End the session: click **End session**. CE's child process should
   exit; the in-memory session clears.

## Failure-path checks

### Runtime missing
- After running the smoke once, `rm -rf ~/.config/@starlight/desktop/runtime`
  while the app is open.
- Click a tile → expect `ceSessionStart` to fail with `runtime-missing`.
  The `RuntimeSetupModal` should re-appear (since `ceRuntimeStatus` IPC
  re-fires on the next `refresh`).

### CE crashes
- Spawn a session, then `pkill -9 cheatengine-x86_64`.
- The session's `onExit` callback fires; the renderer's
  `useCeSessionStore.sessionId` should clear (manual click of "End session"
  works as a fallback if it doesn't auto-clear in v1).

### Network blocked at install
- Block GitHub release URLs in your firewall, click **Set up**.
- Expect the modal to surface "HTTP …" or fetch error, not crash. Retry
  works after unblocking.

## Out-of-scope (for v1)

- Live record updates (CE's hotkeys flipping a record from outside our UI
  won't reflect back to our renderer until end-of-session). Phase 2 adds
  push events from CE.
- Toggle latency optimization (currently ~250-500ms per click — one HTTP
  round-trip plus CE's internal dispatch).
- Multi-session support (one trainer at a time; clicking a second tile
  ends the first session).
- macOS support (CE's macOS build is older; deferred).

## What "good" looks like

A realistic "it works" verdict means:
- Cold install completes in under 30s on a typical home connection.
- Tile click → records visible in under 5s on first launch (most of that
  is CE booting + initial autoload).
- Toggling a record actually changes the in-game state.
- CE's window never appears. Only our UI is visible.
- Closing Starlight kills the CE child process cleanly (verify with
  `pgrep -af cheatengine` after Starlight quits — should be empty).
