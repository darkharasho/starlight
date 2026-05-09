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

## Phase 4.5 / 5 deferred items
- Library auto-detection (Steam/Epic/Heroic/Lutris) — Phase 4.5
- Process auto-detection — Phase 4.5
- Inc/Dec hotkeys for value cheats — Phase 4.5
- Catalog repo + community trainer index — Phase 5
