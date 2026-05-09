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
