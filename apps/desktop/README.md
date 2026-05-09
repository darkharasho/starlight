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

## Phase 4.5 / 5 deferred items
- Library auto-detection (Steam) — DONE — Phase 4.5
- Process auto-detection — DONE — Phase 4.5
- Inc/Dec hotkeys for value cheats — DONE — Phase 4.5
- Catalog repo + community trainer index — Phase 5
