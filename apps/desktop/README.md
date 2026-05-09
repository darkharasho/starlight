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

## What's mocked in Phase 3

- **Catalog** is hard-coded in `src/renderer/data/catalog.ts` (12 games).
- **Trainer** is hard-coded in `src/renderer/data/elden-ring-trainer.ts` (Elden Ring; matches `@starlight/ct-importer` shape).
- **Latch state** is in-memory Zustand. Clicking a tile sets state to "detected"; clicking the in-page Latch button sets "latched". No real process detection.
- **Cheats are visual only.** Toggling a cheat does not call Frida — Phase 4 will wire that.
- **Hotkeys are static labels.** Global shortcuts are not registered — Phase 4 will use Electron's globalShortcut.
