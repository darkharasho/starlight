# Phase 4 — Engine Integration via IPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the desktop renderer (Phase 3) to the real `@starlight/engine` and `@starlight/ct-importer` packages via Electron IPC so that the user can load a `.CT` file, attach to a running process by PID, and toggle/adjust real cheats with global hotkeys driving real Frida memory writes.

**Architecture:** Main process gets a small `engine-host` module that owns the Frida `Session` lifecycle plus a `Map<cheatId, FreezeHandle>` of active freezes. A typed IPC bridge (declared in `apps/desktop/src/shared/ipc.ts` and consumed via the preload script's `contextBridge`) exposes async functions to the renderer. The renderer's existing Zustand store grows a `currentTrainer` slice, and the cheat-card callbacks call IPC instead of mutating local state directly. Hotkey registration uses Electron's `globalShortcut` and dispatches the same IPC actions when fired.

**Tech Stack additions:** `electron`'s `ipcMain` / `ipcRenderer` / `contextBridge` / `globalShortcut` / `dialog`, plus the existing engine and ct-importer packages added to `apps/desktop`'s deps.

**Deliberately deferred to Phase 4.5 / 5:**
- Library auto-detection (Steam libraryfolders.vdf, Epic, Heroic, Lutris) — Phase 4.5
- Process auto-detection by exe name (`ps-list` polling) — Phase 4.5
- Catalog repo + community trainer index — Phase 5
- macOS code signing — Phase 6

In Phase 4 the user picks a `.CT` file and types a PID. That's enough to prove end-to-end correctness against the engine's C test target.

---

## File Structure

```
apps/desktop/
├── src/
│   ├── shared/
│   │   └── ipc.ts                    (NEW — IPC channel names + typed interfaces; imported by main, preload, renderer)
│   ├── main/
│   │   ├── index.ts                  (modified — register IPC handlers, install hotkey hooks on app ready)
│   │   ├── engine-host.ts            (NEW — owns Frida Session, freeze handles, IPC handlers)
│   │   ├── trainer-loader.ts         (NEW — open dialog, read .CT, run importCt, return Starlight JSON)
│   │   └── hotkey-host.ts            (NEW — globalShortcut registration tied to active cheats)
│   ├── preload/
│   │   └── index.ts                  (modified — exposes window.starlight = { ...IPC bridge methods })
│   └── renderer/
│       ├── ipc-client.ts             (NEW — thin wrapper around window.starlight returning typed Promises)
│       ├── stores/
│       │   ├── latch-store.ts        (modified — adds error state; latch() now async, calls IPC)
│       │   └── trainer-store.ts      (NEW — currentTrainer + per-cheat active/value state, IPC-driven)
│       ├── routes/
│       │   ├── HomeRoute.tsx         (modified — adds "Load Trainer (.CT)" button)
│       │   └── ActiveTrainerRoute.tsx (modified — uses trainer-store; cheat callbacks call IPC; PID input)
│       └── data/
│           └── elden-ring-trainer.ts (DELETE — replaced by IPC-loaded trainer)
└── test/
    ├── ipc-contract.test.ts          (NEW — fakes window.starlight, verifies the renderer never imports Frida directly)
    ├── stores/
    │   ├── trainer-store.test.ts     (NEW — store behavior + active/value state)
    │   └── latch-store.test.ts       (NEW — async latch flow with mocked IPC)
    └── routes/
        └── ActiveTrainerRoute.test.tsx (modified — uses fake IPC client + trainer-store)
```

```
packages/engine/test-target/
└── target.CT                          (NEW — hand-authored Cheat Engine table for the existing C target binary;
                                        used as the canonical Phase 4 end-to-end fixture)
```

**Boundaries:**
- `shared/ipc.ts` is the contract. It declares channel names, request/response types, and the `StarlightApi` interface. Both sides import it.
- `main/engine-host.ts` is the only place Frida is imported in the desktop app.
- `main/hotkey-host.ts` consumes `engine-host` callbacks — it does not import Frida itself.
- `renderer/ipc-client.ts` is the only place `window.starlight` is read in the renderer; everything else uses the typed wrapper.
- `renderer/stores/trainer-store.ts` is the source of truth for the active trainer in the renderer. Routes and components subscribe to it.

---

## Background: Why the IPC Boundary Matters

Electron renderers run sandboxed (`contextIsolation: true`, `nodeIntegration: false` — set in Phase 3). They cannot `require('frida')`. The renderer must talk to the main process to do anything that touches the OS, including memory R/W. The preload script is the only bridge: it runs with Node access, declares a typed surface via `contextBridge.exposeInMainWorld`, and that surface is the only thing the renderer's `window` sees from main.

Phase 3 left the preload empty. Phase 4 fills it.

---

## IPC Surface (Defined in Task 1, Used Throughout)

```ts
// apps/desktop/src/shared/ipc.ts

export interface AttachRequest { pid: number }
export interface AttachResult { ok: true } | { ok: false; code: 'permission' | 'not-found' | 'unknown'; message: string }

export interface ToggleCheatRequest { cheatId: string; on: boolean }
export interface SetValueRequest    { cheatId: string; value: number }

export interface LoadTrainerResult {
  trainer: import('@starlight/ct-importer').StarlightTrainer;
  stats: import('@starlight/ct-importer').ImportStats;
} | { error: string }

export interface StarlightApi {
  loadTrainer(): Promise<LoadTrainerResult>;            // opens file dialog
  attach(req: AttachRequest): Promise<AttachResult>;
  detach(): Promise<void>;
  toggleCheat(req: ToggleCheatRequest): Promise<{ ok: true } | { error: string }>;
  setCheatValue(req: SetValueRequest): Promise<{ ok: true } | { error: string }>;
  /** Subscribe to events pushed from main (e.g. hotkey-fired). */
  onEvent(listener: (e: StarlightEvent) => void): () => void;
}

export type StarlightEvent =
  | { type: 'cheat:toggled'; cheatId: string; on: boolean; cause: 'hotkey' }
  | { type: 'cheat:value-changed'; cheatId: string; value: number; cause: 'hotkey' }
  | { type: 'session:detached'; reason: 'process-exit' | 'manual' };

declare global {
  interface Window { starlight: StarlightApi }
}
```

---

## Task 1: Shared IPC Types + Preload Bridge Skeleton

**Files:**
- Create: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/tsconfig.json` (add `src/shared/**/*` to `include`)
- Modify: `apps/desktop/src/main/index.ts` (placeholder ipcMain handlers — return errors until Tasks 3-4 land)
- Modify: `apps/desktop/package.json` (add `@starlight/engine` + `@starlight/ct-importer` as workspace deps)

- [ ] **Step 1: Add the workspace deps**

Edit `apps/desktop/package.json` — add to `dependencies`:

```json
"@starlight/engine": "workspace:*",
"@starlight/ct-importer": "workspace:*",
```

Run from repo root: `pnpm install`
Expected: lockfile updates; `frida` native binary already cached from Phase 1.

- [ ] **Step 2: Create the shared IPC types file**

Create `apps/desktop/src/shared/ipc.ts`:

```ts
import type { StarlightTrainer, ImportStats } from '@starlight/ct-importer';

export const CHANNELS = {
  loadTrainer:   'starlight:loadTrainer',
  attach:        'starlight:attach',
  detach:        'starlight:detach',
  toggleCheat:   'starlight:toggleCheat',
  setCheatValue: 'starlight:setCheatValue',
  event:         'starlight:event',
} as const;

export interface AttachRequest { pid: number }
export type AttachResult =
  | { ok: true }
  | { ok: false; code: 'permission' | 'not-found' | 'unknown'; message: string };

export interface ToggleCheatRequest { cheatId: string; on: boolean }
export interface SetValueRequest    { cheatId: string; value: number }

export type LoadTrainerResult =
  | { ok: true; trainer: StarlightTrainer; stats: ImportStats }
  | { ok: false; error: string };

export type IpcOk<T = void> = T extends void ? { ok: true } : { ok: true; value: T };
export type IpcErr = { ok: false; error: string };
export type IpcResult<T = void> = IpcOk<T> | IpcErr;

export type StarlightEvent =
  | { type: 'cheat:toggled';        cheatId: string; on: boolean; cause: 'hotkey' }
  | { type: 'cheat:value-changed';  cheatId: string; value: number; cause: 'hotkey' }
  | { type: 'session:detached';     reason: 'process-exit' | 'manual' };

export interface StarlightApi {
  loadTrainer():     Promise<LoadTrainerResult>;
  attach(req: AttachRequest): Promise<AttachResult>;
  detach():          Promise<void>;
  toggleCheat(req: ToggleCheatRequest):     Promise<IpcResult>;
  setCheatValue(req: SetValueRequest):      Promise<IpcResult>;
  onEvent(listener: (e: StarlightEvent) => void): () => void;
}

declare global {
  interface Window { starlight: StarlightApi }
}
```

- [ ] **Step 3: Update tsconfig include**

Edit `apps/desktop/tsconfig.json` — change `"include"`:

```json
"include": ["src/main/**/*", "src/preload/**/*", "src/renderer/**/*", "src/shared/**/*"]
```

- [ ] **Step 4: Replace preload with the contextBridge surface**

Replace `apps/desktop/src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type StarlightApi, type StarlightEvent } from '../shared/ipc.js';

const api: StarlightApi = {
  loadTrainer:   ()    => ipcRenderer.invoke(CHANNELS.loadTrainer),
  attach:        (req) => ipcRenderer.invoke(CHANNELS.attach, req),
  detach:        ()    => ipcRenderer.invoke(CHANNELS.detach),
  toggleCheat:   (req) => ipcRenderer.invoke(CHANNELS.toggleCheat, req),
  setCheatValue: (req) => ipcRenderer.invoke(CHANNELS.setCheatValue, req),
  onEvent: (listener) => {
    const handler = (_evt: unknown, e: StarlightEvent): void => listener(e);
    ipcRenderer.on(CHANNELS.event, handler);
    return () => ipcRenderer.off(CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld('starlight', api);
```

- [ ] **Step 5: Add placeholder ipcMain handlers in main**

Edit `apps/desktop/src/main/index.ts`. Inside `app.whenReady().then(...)`, BEFORE `createWindow()`, add:

```ts
import { ipcMain } from 'electron';
import { CHANNELS, type AttachResult, type LoadTrainerResult } from '../shared/ipc.js';

ipcMain.handle(CHANNELS.loadTrainer, async (): Promise<LoadTrainerResult> =>
  ({ ok: false, error: 'loadTrainer not implemented (Phase 4 Task 2)' }));

ipcMain.handle(CHANNELS.attach, async (): Promise<AttachResult> =>
  ({ ok: false, code: 'unknown', message: 'attach not implemented (Phase 4 Task 3)' }));

ipcMain.handle(CHANNELS.detach,        async () => undefined);
ipcMain.handle(CHANNELS.toggleCheat,   async () => ({ ok: false, error: 'not implemented (Phase 4 Task 4)' }));
ipcMain.handle(CHANNELS.setCheatValue, async () => ({ ok: false, error: 'not implemented (Phase 4 Task 4)' }));
```

(Imports go at the top of the file with the existing imports.)

- [ ] **Step 6: Lint + build**

Run from repo root:
- `pnpm --filter @starlight/desktop lint` — clean
- `pnpm --filter @starlight/desktop build` — clean

If lint fails because the renderer can't see `window.starlight`, verify `tsconfig.json`'s `include` was updated and the global `declare` in `shared/ipc.ts` is reachable.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/shared/ apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/tsconfig.json apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(desktop): IPC scaffold with typed contextBridge surface"
```

---

## Task 2: Trainer Loader (file dialog → ct-importer → JSON)

**Files:**
- Create: `apps/desktop/src/main/trainer-loader.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Create: `packages/engine/test-target/target.CT`

The user picks a `.CT` file via Electron's `dialog.showOpenDialog`. The handler reads the file, calls `importCt()`, and returns the result. Phase 4's e2e fixture is a hand-written `.CT` for the existing C test target.

- [ ] **Step 1: Author the test-target trainer fixture**

Create `packages/engine/test-target/target.CT`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"Player"</Description>
      <Options moHideChildren="1"/>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
        <CheatEntry>
          <ID>2</ID>
          <Description>"Health"</Description>
          <VariableType>4 Bytes</VariableType>
          <Address>"target"+0x403030</Address>
          <Hotkeys>
            <Hotkey><Action>Toggle Activation</Action><Keys><Key>112</Key></Keys><ID>0</ID></Hotkey>
          </Hotkeys>
        </CheatEntry>
        <CheatEntry>
          <ID>3</ID>
          <Description>"Speed"</Description>
          <VariableType>Float</VariableType>
          <Address>"target"+0x403034</Address>
          <Hotkeys>
            <Hotkey><Action>Toggle Activation</Action><Keys><Key>113</Key></Keys><ID>0</ID></Hotkey>
          </Hotkeys>
        </CheatEntry>
        <CheatEntry>
          <ID>4</ID>
          <Description>"Souls"</Description>
          <VariableType>8 Bytes</VariableType>
          <Address>"target"+0x403040</Address>
          <Hotkeys>
            <Hotkey><Action>Toggle Activation</Action><Keys><Key>114</Key></Keys><ID>0</ID></Hotkey>
          </Hotkeys>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

(Addresses match the C target's actual globals when built with `-fno-pie -no-pie`. Verify by running `make -C packages/engine/test-target && ./packages/engine/test-target/build/target` and reading the `addr g_health=...` line — should be `0x403030`. If your build produces different addresses, update the offsets to match.)

**Note about address verification:** the test-target binary prints its address table on startup. Phase 4 e2e verification will spawn the binary, parse those addresses, and compare against what the trainer says. If they don't match, the test will tell you which address to adjust in the .CT.

- [ ] **Step 2: Implement trainer-loader.ts**

Create `apps/desktop/src/main/trainer-loader.ts`:

```ts
import { dialog, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { importCt } from '@starlight/ct-importer';
import type { LoadTrainerResult } from '../shared/ipc.js';

export async function loadTrainer(parentWindow?: BrowserWindow): Promise<LoadTrainerResult> {
  const result = await dialog.showOpenDialog(parentWindow ?? BrowserWindow.getFocusedWindow() ?? new BrowserWindow({ show: false }), {
    title: 'Open Cheat Engine table',
    filters: [{ name: 'Cheat Engine table', extensions: ['CT', 'ct'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'cancelled' };
  }
  const path = result.filePaths[0]!;
  let xml: string;
  try {
    xml = await readFile(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const out = importCt(xml, {
      gameName: basename(path).replace(/\.(ct|CT)$/, ''),
      processName: ['unknown'],   // user supplies real process name later
      platform: ['linux'],
    });
    return { ok: true, trainer: out.trainer, stats: out.stats };
  } catch (err) {
    return { ok: false, error: `failed to import ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 3: Wire the handler in main/index.ts**

Edit `apps/desktop/src/main/index.ts`. Replace the placeholder `loadTrainer` handler with:

```ts
import { loadTrainer } from './trainer-loader.js';

ipcMain.handle(CHANNELS.loadTrainer, async (): Promise<LoadTrainerResult> =>
  loadTrainer(BrowserWindow.getFocusedWindow() ?? undefined));
```

(`BrowserWindow` is already imported.)

- [ ] **Step 4: Build to confirm**

Run `pnpm --filter @starlight/desktop build`. Expected: clean.

- [ ] **Step 5: Manually smoke-test via the dev workflow** (skip in headless CI)

If you have a display:
```bash
pnpm --filter @starlight/desktop dev
```
Open the app, then open DevTools and run:
```js
await window.starlight.loadTrainer()
```
A native file dialog appears. Pick `packages/engine/test-target/target.CT`. The result should be `{ ok: true, trainer: { ... }, stats: { total: 3, supported: 3, unsupported: 0, categories: 1 } }`.

In headless CI / no-display environments, skip this smoke. The build passing is sufficient signal for now.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/trainer-loader.ts apps/desktop/src/main/index.ts packages/engine/test-target/target.CT
git commit -m "feat(desktop): trainer loader via dialog and @starlight/ct-importer"
```

---

## Task 3: Engine Host — Attach + Detach + Read

**Files:**
- Create: `apps/desktop/src/main/engine-host.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/electron.vite.config.ts` (mark `frida` as external in main)

The engine host owns one Frida `Session` at a time. `attach()` creates it; `detach()` tears it down. The session reference is module-level state inside `engine-host.ts`. We do not expose the raw session to the renderer.

- [ ] **Step 1: Mark frida as external in electron-vite**

`frida` is a native module. electron-vite's bundler should not try to bundle it. Edit `apps/desktop/electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/main', lib: { entry: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/preload', lib: { entry: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: '.',
    build: { outDir: 'out/renderer', rollupOptions: { input: resolve(__dirname, 'index.html') } },
    plugins: [react()],
  },
});
```

`externalizeDepsPlugin()` keeps every npm dep as a runtime require (not bundled), which is what native modules like `frida` need.

- [ ] **Step 2: Implement engine-host.ts**

Create `apps/desktop/src/main/engine-host.ts`:

```ts
import { attach as engineAttach, type Session, AttachError, PermissionError } from '@starlight/engine';
import type { AttachResult } from '../shared/ipc.js';

let session: Session | null = null;

export function currentSession(): Session | null { return session; }

export async function attach(pid: number): Promise<AttachResult> {
  if (session) await detach();
  try {
    session = await engineAttach(pid);
    return { ok: true };
  } catch (err) {
    if (err instanceof PermissionError) {
      return { ok: false, code: 'permission', message: err.message };
    }
    if (err instanceof AttachError) {
      return { ok: false, code: 'not-found', message: err.message };
    }
    return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function detach(): Promise<void> {
  if (!session) return;
  try { await session.detach(); }
  catch { /* swallow — frida already detached */ }
  session = null;
}

/** Returns true if a session is alive. */
export function isAttached(): boolean {
  return session !== null && session.attached;
}
```

- [ ] **Step 3: Replace placeholder handlers in main**

Edit `apps/desktop/src/main/index.ts`. Replace the `attach` and `detach` placeholder handlers:

```ts
import * as engineHost from './engine-host.js';

ipcMain.handle(CHANNELS.attach,
  async (_evt, req: AttachRequest): Promise<AttachResult> => engineHost.attach(req.pid));

ipcMain.handle(CHANNELS.detach, async () => engineHost.detach());
```

(Add `AttachRequest` to your `shared/ipc.js` import line.)

Also add cleanup on app exit. After the `app.on('window-all-closed', ...)` handler:

```ts
app.on('before-quit', async () => {
  await engineHost.detach();
});
```

- [ ] **Step 4: Build**

Run `pnpm --filter @starlight/desktop build` — clean.

If you see "Cannot find module 'frida'" at build time, the externalizeDepsPlugin isn't applied; double-check Step 1.

- [ ] **Step 5: Manual end-to-end smoke (Linux with display)**

In one terminal: build the C target and run it:
```bash
make -C packages/engine/test-target
packages/engine/test-target/build/target &
echo "PID=$!"
```

In another terminal: `pnpm --filter @starlight/desktop dev`. In DevTools:
```js
await window.starlight.attach({ pid: <PID-from-above> })
// → { ok: true }
await window.starlight.detach()
```

If `ok: false` with `code: 'permission'`, lower ptrace_scope: `sudo sysctl kernel.yama.ptrace_scope=0`.

In headless: skip and verify by build alone.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/engine-host.ts apps/desktop/src/main/index.ts apps/desktop/electron.vite.config.ts
git commit -m "feat(desktop): engine host with attach/detach via frida"
```

---

## Task 4: Engine Host — Freeze + Cancel + SetValue

**Files:**
- Modify: `apps/desktop/src/main/engine-host.ts`
- Modify: `apps/desktop/src/main/index.ts`

Add per-cheat freeze tracking. Toggle on a freeze cheat → resolve address from the trainer + create freeze handle. Toggle off → cancel the handle. SetValue → either write once (if not active) or update the freeze value (if active).

To resolve addresses, the engine-host needs to remember the last-loaded `StarlightTrainer` so it can look up cheat → address translations. We add a `loadTrainer` setter that the IPC layer calls after each successful import.

- [ ] **Step 1: Extend `shared/ipc.ts` with a setActiveTrainer channel**

This isn't a new user-facing IPC method — it's an internal state-sync the renderer fires after `loadTrainer`. The cleanest approach: have `setActiveTrainer` happen inside the `loadTrainer` handler in main itself, so the engine-host always has the latest trainer.

Skip the channel; the loader will call into engine-host directly.

Update `apps/desktop/src/main/trainer-loader.ts` to call `setActiveTrainer` after a successful import:

```ts
import { setActiveTrainer } from './engine-host.js';

// inside loadTrainer, after `const out = importCt(...)`, before `return`:
setActiveTrainer(out.trainer);
```

- [ ] **Step 2: Extend `engine-host.ts`**

Replace `apps/desktop/src/main/engine-host.ts` with:

```ts
import {
  attach as engineAttach,
  read,
  write,
  resolvePointerChain,
  aobScan,
  freeze,
  type Session,
  type FreezeHandle,
  type ValueType,
  AttachError,
  PermissionError,
  ScanError,
  ReadError,
  WriteError,
} from '@starlight/engine';
import type {
  StarlightTrainer,
  StarlightCheat,
  StarlightSupportedCheat,
  StarlightAddress,
} from '@starlight/ct-importer';
import type { AttachResult, IpcResult } from '../shared/ipc.js';

let session: Session | null = null;
let activeTrainer: StarlightTrainer | null = null;
const freezeHandles = new Map<string, FreezeHandle>();
/** Last value chosen by the user per value-cheat (for setValue without freeze). */
const lastValues = new Map<string, number>();

export function currentSession(): Session | null { return session; }
export function setActiveTrainer(t: StarlightTrainer): void { activeTrainer = t; }

export async function attach(pid: number): Promise<AttachResult> {
  if (session) await detach();
  try {
    session = await engineAttach(pid);
    return { ok: true };
  } catch (err) {
    if (err instanceof PermissionError) return { ok: false, code: 'permission', message: err.message };
    if (err instanceof AttachError)     return { ok: false, code: 'not-found', message: err.message };
    return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function detach(): Promise<void> {
  for (const [, h] of freezeHandles) { try { await h.cancel(); } catch { /* ignore */ } }
  freezeHandles.clear();
  if (!session) return;
  try { await session.detach(); }
  catch { /* swallow */ }
  session = null;
}

export function isAttached(): boolean { return session !== null && session.attached; }

function findCheat(cheatId: string): StarlightSupportedCheat | undefined {
  if (!activeTrainer) return undefined;
  for (const c of activeTrainer.categories) {
    for (const x of c.cheats) {
      if (x.id === cheatId && !('unsupported' in x && x.unsupported)) return x as StarlightSupportedCheat;
    }
  }
  return undefined;
}

async function resolveAddress(s: Session, addr: StarlightAddress): Promise<string> {
  switch (addr.kind) {
    case 'absolute':
      return addr.address;
    case 'module':
      // module + offset — frida resolves module base at runtime
      return await resolvePointerChain(s, {
        module: addr.module,
        baseAddress: addr.offset,
        offsets: [],
      }).catch(() => addr.offset); // fallback: caller treats as absolute
    case 'pointer': {
      const args: Parameters<typeof resolvePointerChain>[1] = {
        baseAddress: addr.baseOffset,
        offsets: addr.offsets,
        ...(addr.module !== undefined ? { module: addr.module } : {}),
      };
      return resolvePointerChain(s, args);
    }
    case 'aob': {
      const matches = await aobScan(s, {
        module: addr.module,
        pattern: addr.pattern,
        ...(addr.offset !== undefined ? { resultOffset: parseInt(addr.offset, 16) } : {}),
      });
      if (matches.length === 0) throw new ScanError(`AOB scan returned no matches`);
      return matches[0]!;
    }
  }
}

export async function toggleCheat(cheatId: string, on: boolean): Promise<IpcResult> {
  if (!session)          return { ok: false, error: 'not attached' };
  const cheat = findCheat(cheatId);
  if (!cheat)            return { ok: false, error: `unknown cheat ${cheatId}` };

  try {
    if (!on) {
      const handle = freezeHandles.get(cheatId);
      if (handle) {
        await handle.cancel();
        freezeHandles.delete(cheatId);
      }
      return { ok: true };
    }

    // Cancel any prior handle (defensive)
    const prior = freezeHandles.get(cheatId);
    if (prior) { try { await prior.cancel(); } catch { /* ignore */ } }

    const address = await resolveAddress(session, cheat.address);
    const value = lastValues.get(cheatId) ?? cheat.value ?? cheat.default ?? 0;
    const valueType = cheat.valueType as Exclude<ValueType, 'string'>;

    const handle = await freeze(session, {
      address,
      type: valueType,
      value: valueType === 'int64' || valueType === 'uint64' ? BigInt(value) : value,
      intervalMs: 50,
    });
    freezeHandles.set(cheatId, handle);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setCheatValue(cheatId: string, value: number): Promise<IpcResult> {
  if (!session) return { ok: false, error: 'not attached' };
  const cheat = findCheat(cheatId);
  if (!cheat)   return { ok: false, error: `unknown cheat ${cheatId}` };
  lastValues.set(cheatId, value);

  try {
    const address = await resolveAddress(session, cheat.address);
    const valueType = cheat.valueType as Exclude<ValueType, 'string'>;

    // If currently frozen, replace the freeze with the new value.
    const handle = freezeHandles.get(cheatId);
    if (handle) {
      await handle.cancel();
      const next = await freeze(session, {
        address,
        type: valueType,
        value: valueType === 'int64' || valueType === 'uint64' ? BigInt(value) : value,
        intervalMs: 50,
      });
      freezeHandles.set(cheatId, next);
    } else {
      // One-shot write
      await write(session, address, valueType,
        valueType === 'int64' || valueType === 'uint64' ? BigInt(value) : value);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Re-export `read` for callers that want to inspect current memory (Phase 5+)
export { read, ReadError, WriteError };
```

- [ ] **Step 3: Wire the handlers**

Edit `apps/desktop/src/main/index.ts`. Replace the placeholder `toggleCheat` and `setCheatValue` handlers:

```ts
ipcMain.handle(CHANNELS.toggleCheat,
  async (_evt, req: ToggleCheatRequest): Promise<IpcResult> => engineHost.toggleCheat(req.cheatId, req.on));

ipcMain.handle(CHANNELS.setCheatValue,
  async (_evt, req: SetValueRequest): Promise<IpcResult> => engineHost.setCheatValue(req.cheatId, req.value));
```

Add `ToggleCheatRequest`, `SetValueRequest`, `IpcResult` to the imports from `shared/ipc.js`.

- [ ] **Step 4: Build**

Run `pnpm --filter @starlight/desktop build`. Expected: clean.

- [ ] **Step 5: Manual e2e (Linux with display)**

In one terminal:
```bash
make -C packages/engine/test-target
packages/engine/test-target/build/target &
echo "PID=$!"
```

In the desktop dev DevTools:
```js
await window.starlight.loadTrainer();   // pick packages/engine/test-target/target.CT
await window.starlight.attach({ pid: <PID> });
await window.starlight.toggleCheat({ cheatId: 'cheat-2', on: true }); // freeze health at... value from last set
await window.starlight.setCheatValue({ cheatId: 'cheat-2', value: 9999 });
await window.starlight.toggleCheat({ cheatId: 'cheat-2', on: false });
await window.starlight.detach();
```

In a third terminal, peek at the C target's memory before/after to confirm the value froze. (Optionally add a `printf("health=%d\n", g_health);` SIGUSR1 handler to the test target if you want runtime visibility — out of scope for this task.)

In headless CI: skip; the build is sufficient.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/engine-host.ts apps/desktop/src/main/trainer-loader.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): engine host with freeze/cancel/setValue and address resolution"
```

---

## Task 5: Renderer IPC Client + Trainer Store

**Files:**
- Create: `apps/desktop/src/renderer/ipc-client.ts`
- Create: `apps/desktop/src/renderer/stores/trainer-store.ts`
- Create: `apps/desktop/test/stores/trainer-store.test.ts`
- Modify: `apps/desktop/src/renderer/data/elden-ring-trainer.ts` (delete it)

The renderer needs:
1. A typed wrapper around `window.starlight` that's safe to call from anywhere (mockable in tests).
2. A Zustand store holding the currently loaded `StarlightTrainer` plus per-cheat `active`/`value` state. The store's actions call IPC and update local state on success.

- [ ] **Step 1: Delete the mock trainer fixture**

```bash
rm apps/desktop/src/renderer/data/elden-ring-trainer.ts
```

(`ActiveTrainerRoute.tsx` will be rewritten in Task 6 to consume `trainer-store` instead.)

- [ ] **Step 2: Create the IPC client wrapper**

Create `apps/desktop/src/renderer/ipc-client.ts`:

```ts
import type { StarlightApi } from '../shared/ipc.js';

/* In production, the contextBridge installed `window.starlight`.
 * In tests we inject a fake by calling setStarlightApi(). */

let api: StarlightApi | null = null;

export function setStarlightApi(injected: StarlightApi): void { api = injected; }
export function clearStarlightApi(): void { api = null; }

export function starlight(): StarlightApi {
  if (api) return api;
  if (typeof window !== 'undefined' && window.starlight) return window.starlight;
  throw new Error('Starlight IPC API not available — preload script may not have loaded.');
}
```

- [ ] **Step 3: Write the failing trainer-store test**

Create `apps/desktop/test/stores/trainer-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTrainerStore } from '../../src/renderer/stores/trainer-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi, StarlightTrainer } from '../../src/shared/ipc.js';

const minimalTrainer: StarlightTrainer = {
  schemaVersion: 1,
  id: 't',
  game: { name: 'X', processName: ['x'], platform: ['linux'] },
  metadata: { source: { convertedFrom: '.CT' } },
  categories: [
    { name: 'P', cheats: [
      { id: 'a', name: 'A', type: 'freeze', valueType: 'int32', value: 1, address: { kind: 'absolute', address: '0x1000' } },
      { id: 'b', name: 'B', type: 'set', valueType: 'float', default: 1.5, step: 0.1, address: { kind: 'absolute', address: '0x2000' } },
    ] },
  ],
};

function fakeApi(overrides: Partial<StarlightApi> = {}): StarlightApi {
  return {
    loadTrainer:   vi.fn().mockResolvedValue({ ok: true, trainer: minimalTrainer, stats: { total: 2, supported: 2, unsupported: 0, categories: 1 } }),
    attach:        vi.fn().mockResolvedValue({ ok: true }),
    detach:        vi.fn().mockResolvedValue(undefined),
    toggleCheat:   vi.fn().mockResolvedValue({ ok: true }),
    setCheatValue: vi.fn().mockResolvedValue({ ok: true }),
    onEvent:       vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

beforeEach(() => {
  useTrainerStore.setState({ trainer: null, activeCheats: {}, values: {}, error: null });
  clearStarlightApi();
});

describe('trainer-store', () => {
  it('loadTrainer populates the trainer and seeds default values', async () => {
    setStarlightApi(fakeApi());
    await useTrainerStore.getState().loadTrainer();
    const s = useTrainerStore.getState();
    expect(s.trainer?.id).toBe('t');
    expect(s.values).toEqual({ b: 1.5 });
  });

  it('toggleCheat flips active state on success', async () => {
    setStarlightApi(fakeApi());
    useTrainerStore.setState({ trainer: minimalTrainer });
    await useTrainerStore.getState().toggleCheat('a', true);
    expect(useTrainerStore.getState().activeCheats.a).toBe(true);
    await useTrainerStore.getState().toggleCheat('a', false);
    expect(useTrainerStore.getState().activeCheats.a).toBe(false);
  });

  it('toggleCheat sets error on IPC failure', async () => {
    setStarlightApi(fakeApi({ toggleCheat: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) }));
    useTrainerStore.setState({ trainer: minimalTrainer });
    await useTrainerStore.getState().toggleCheat('a', true);
    expect(useTrainerStore.getState().activeCheats.a).toBe(false); // rolled back
    expect(useTrainerStore.getState().error).toMatch(/boom/);
  });

  it('setCheatValue updates the value map and clamps to [min,max] if defined', async () => {
    setStarlightApi(fakeApi());
    useTrainerStore.setState({ trainer: {
      ...minimalTrainer,
      categories: [{ name: 'P', cheats: [{
        id: 'c', name: 'C', type: 'set', valueType: 'float', default: 1, step: 0.1, min: 0, max: 5,
        address: { kind: 'absolute', address: '0x3000' },
      }] }],
    } });
    await useTrainerStore.getState().setCheatValue('c', 99);
    expect(useTrainerStore.getState().values.c).toBe(5); // clamped
  });
});
```

- [ ] **Step 4: Run test (fails — store missing)**

Run: `pnpm --filter @starlight/desktop test trainer-store`
Expected: FAIL — `../src/renderer/stores/trainer-store.js` not found.

- [ ] **Step 5: Implement the store**

Create `apps/desktop/src/renderer/stores/trainer-store.ts`:

```ts
import { create } from 'zustand';
import type { StarlightTrainer, StarlightCheat, StarlightSupportedCheat } from '../../shared/ipc.js';
import { starlight } from '../ipc-client.js';

interface TrainerStore {
  trainer:     StarlightTrainer | null;
  /** cheatId → on/off */
  activeCheats: Record<string, boolean>;
  /** cheatId → current numeric value (for value/set cheats). */
  values: Record<string, number>;
  error: string | null;

  loadTrainer:   () => Promise<void>;
  toggleCheat:   (cheatId: string, on: boolean) => Promise<void>;
  setCheatValue: (cheatId: string, value: number) => Promise<void>;
  clear:         () => void;
}

function isSupported(c: StarlightCheat): c is StarlightSupportedCheat {
  return !('unsupported' in c) || c.unsupported !== true;
}

function findSupported(t: StarlightTrainer | null, id: string): StarlightSupportedCheat | undefined {
  if (!t) return undefined;
  for (const cat of t.categories) for (const c of cat.cheats) {
    if (c.id === id && isSupported(c)) return c as StarlightSupportedCheat;
  }
  return undefined;
}

function clamp(v: number, min?: number, max?: number): number {
  let r = v;
  if (typeof min === 'number' && r < min) r = min;
  if (typeof max === 'number' && r > max) r = max;
  return r;
}

function seedValues(t: StarlightTrainer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cat of t.categories) for (const c of cat.cheats) {
    if (isSupported(c) && c.type === 'set' && typeof c.default === 'number') {
      out[c.id] = c.default;
    }
  }
  return out;
}

export const useTrainerStore = create<TrainerStore>((set, get) => ({
  trainer: null,
  activeCheats: {},
  values: {},
  error: null,

  async loadTrainer() {
    const result = await starlight().loadTrainer();
    if (!result.ok) {
      set({ error: result.error });
      return;
    }
    set({
      trainer: result.trainer,
      activeCheats: {},
      values: seedValues(result.trainer),
      error: null,
    });
  },

  async toggleCheat(cheatId, on) {
    const r = await starlight().toggleCheat({ cheatId, on });
    if (!r.ok) {
      set({ error: r.error });
      return;
    }
    set((prev) => ({ activeCheats: { ...prev.activeCheats, [cheatId]: on } }));
  },

  async setCheatValue(cheatId, value) {
    const cheat = findSupported(get().trainer, cheatId);
    const clamped = cheat ? clamp(value, cheat.min, cheat.max) : value;
    const r = await starlight().setCheatValue({ cheatId, value: clamped });
    if (!r.ok) {
      set({ error: r.error });
      return;
    }
    set((prev) => ({ values: { ...prev.values, [cheatId]: clamped } }));
  },

  clear() { set({ trainer: null, activeCheats: {}, values: {}, error: null }); },
}));
```

- [ ] **Step 6: Run test (passes)**

Run: `pnpm --filter @starlight/desktop test trainer-store`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/ipc-client.ts apps/desktop/src/renderer/stores/trainer-store.ts apps/desktop/test/stores/trainer-store.test.ts
git rm apps/desktop/src/renderer/data/elden-ring-trainer.ts
git commit -m "feat(desktop): trainer store and IPC client wrapper"
```

---

## Task 6: Async Latch Store + Tests

**Files:**
- Modify: `apps/desktop/src/renderer/stores/latch-store.ts`
- Create: `apps/desktop/test/stores/latch-store.test.ts`

The latch store grows: `latch()` becomes async, calls `attach()` over IPC, and surfaces errors. The renderer needs a way to hold a "PID input" (Phase 4 has no auto-detection). For now we add a simple `pidInput` field set by the UI.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/stores/latch-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLatchState } from '../../src/renderer/stores/latch-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi } from '../../src/shared/ipc.js';

function fakeApi(overrides: Partial<StarlightApi> = {}): StarlightApi {
  return {
    loadTrainer:   vi.fn(),
    attach:        vi.fn().mockResolvedValue({ ok: true }),
    detach:        vi.fn().mockResolvedValue(undefined),
    toggleCheat:   vi.fn(),
    setCheatValue: vi.fn(),
    onEvent:       vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

beforeEach(() => {
  useLatchState.setState({ state: 'waiting', detectedGame: null, error: null, pidInput: '' });
  clearStarlightApi();
});

describe('latch-store async flow', () => {
  it('latch() calls attach and sets state to latched on success', async () => {
    setStarlightApi(fakeApi());
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    expect(useLatchState.getState().state).toBe('latched');
    expect(useLatchState.getState().error).toBeNull();
  });

  it('latch() surfaces a permission error when attach fails', async () => {
    setStarlightApi(fakeApi({
      attach: vi.fn().mockResolvedValue({ ok: false, code: 'permission', message: 'ptrace blocked' }),
    }));
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    expect(useLatchState.getState().state).toBe('waiting');
    expect(useLatchState.getState().error).toMatch(/ptrace blocked/);
  });

  it('latch() with empty PID input fails fast without calling attach', async () => {
    const attach = vi.fn();
    setStarlightApi(fakeApi({ attach }));
    await useLatchState.getState().latch();
    expect(attach).not.toHaveBeenCalled();
    expect(useLatchState.getState().error).toMatch(/pid/i);
  });

  it('detach() calls IPC and resets state', async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    setStarlightApi(fakeApi({ detach }));
    useLatchState.setState({ state: 'latched' });
    await useLatchState.getState().detach();
    expect(detach).toHaveBeenCalled();
    expect(useLatchState.getState().state).toBe('waiting');
  });
});
```

- [ ] **Step 2: Run (fails — methods not async, fields missing)**

Run: `pnpm --filter @starlight/desktop test latch-store`
Expected: FAIL.

- [ ] **Step 3: Replace `latch-store.ts`**

Replace `apps/desktop/src/renderer/stores/latch-store.ts`:

```ts
import { create } from 'zustand';
import { starlight } from '../ipc-client.js';

export type LatchState = 'idle' | 'waiting' | 'detected' | 'latched';

interface LatchStore {
  state: LatchState;
  detectedGame: { name: string; coverUrl: string; processName: string } | null;
  error: string | null;
  /** Free-text PID input from the UI; Phase 4.5 will replace with auto-detection. */
  pidInput: string;

  setPidInput: (s: string) => void;
  detect: (game: { name: string; coverUrl: string; processName: string }) => void;
  latch:  () => Promise<void>;
  detach: () => Promise<void>;
}

export const useLatchState = create<LatchStore>((set, get) => ({
  state: 'waiting',
  detectedGame: null,
  error: null,
  pidInput: '',

  setPidInput: (s) => set({ pidInput: s }),
  detect: (game) => set({ state: 'detected', detectedGame: game, error: null }),

  async latch() {
    const pid = parseInt(get().pidInput.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      set({ error: 'Enter a numeric PID before latching.' });
      return;
    }
    const r = await starlight().attach({ pid });
    if (r.ok) {
      set({ state: 'latched', error: null });
    } else {
      set({ error: r.message });
    }
  },

  async detach() {
    await starlight().detach();
    set({ state: 'waiting', detectedGame: null, error: null });
  },
}));
```

- [ ] **Step 4: Run (passes)**

Run: `pnpm --filter @starlight/desktop test latch-store`
Expected: PASS — 4 tests.

Older `LatchPill.test.tsx` should still pass — verify with `pnpm --filter @starlight/desktop test`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/stores/latch-store.ts apps/desktop/test/stores/latch-store.test.ts
git commit -m "feat(desktop): async latch store with IPC attach/detach"
```

---

## Task 7: Active Trainer Route — Wire to Real Stores

**Files:**
- Modify: `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`
- Modify: `apps/desktop/test/routes/ActiveTrainerRoute.test.tsx`
- Modify: `apps/desktop/src/renderer/routes/HomeRoute.tsx` (add "Load Trainer" button)

The Active Trainer route now reads from `trainer-store` and `latch-store`. The Latch button is gated by `pidInput` — if empty, show a small text field. Toggling a cheat calls `trainerStore.toggleCheat(id, on)` (IPC under the hood). Value steppers call `setCheatValue`.

Home gets a "Load Trainer (.CT)" button so the demo flow is: Home → Load Trainer → Active Trainer (auto-routed by selecting the loaded trainer's id).

- [ ] **Step 1: Add Load Trainer button to Home**

Modify `apps/desktop/src/renderer/routes/HomeRoute.tsx`. After the closing `</PageHeader>` and before the first `<Section>`, add:

```tsx
import { useTrainerStore } from '../stores/trainer-store.js';

// inside HomeRoute(), at top:
const loadTrainer = useTrainerStore((s) => s.loadTrainer);
const trainerLoaded = useTrainerStore((s) => s.trainer);

// add a banner/button just below PageHeader:
<div className="mb-5 flex items-center gap-3">
  <button
    type="button"
    onClick={async () => { await loadTrainer(); navigate('/active'); }}
    className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
  >
    Load Trainer (.CT)
  </button>
  {trainerLoaded && <span className="text-[11px] text-muted">Loaded: {trainerLoaded.game.name}</span>}
</div>
```

(Adjust the imports at the top accordingly.)

- [ ] **Step 2: Update ActiveTrainerRoute test**

Modify `apps/desktop/test/routes/ActiveTrainerRoute.test.tsx`. The pre-Phase-4 version seeded `useLatchState` with a hardcoded fixture. Now it must seed `useTrainerStore` instead.

Replace its `beforeEach` block with:

```tsx
beforeEach(() => {
  setStarlightApi({
    loadTrainer:   vi.fn(),
    attach:        vi.fn().mockResolvedValue({ ok: true }),
    detach:        vi.fn().mockResolvedValue(undefined),
    toggleCheat:   vi.fn().mockResolvedValue({ ok: true }),
    setCheatValue: vi.fn().mockResolvedValue({ ok: true }),
    onEvent:       vi.fn().mockReturnValue(() => {}),
  });
  useLatchState.setState({
    state: 'latched',
    detectedGame: { name: 'Elden Ring', coverUrl: 'https://example.com/x.jpg', processName: 'eldenring.exe' },
    error: null,
    pidInput: '12345',
  });
  useTrainerStore.setState({
    trainer: {
      schemaVersion: 1,
      id: 't',
      game: { name: 'Elden Ring', processName: ['eldenring.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [
        {
          name: 'Player',
          cheats: [
            { id: 'infinite-hp', name: 'Infinite HP', type: 'freeze', valueType: 'int32', value: 999, address: { kind: 'absolute', address: '0x1000' } },
            { id: 'speed',       name: 'Movement Speed Multiplier', type: 'set',  valueType: 'float', default: 1.5, step: 0.1, address: { kind: 'absolute', address: '0x2000' } },
            { id: 'auto-block',  name: 'Auto-Block Script', unsupported: true, unsupportedReason: 'Lua' },
          ],
        },
        { name: 'Stats', cheats: [] },
      ],
    },
    activeCheats: {},
    values: { speed: 1.5 },
    error: null,
  });
});
```

Add the imports at the top:

```ts
import { setStarlightApi } from '../../src/renderer/ipc-client.js';
import { useTrainerStore } from '../../src/renderer/stores/trainer-store.js';
```

The four existing tests should still pass against the new state shape — just confirm the assertions still match (e.g. `screen.getByText('Player')` etc.).

- [ ] **Step 3: Replace `ActiveTrainerRoute.tsx`**

Replace `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`:

```tsx
import { useState } from 'react';
import { useLatchState } from '../stores/latch-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import type { StarlightCheat, StarlightSupportedCheat } from '../../shared/ipc.js';
import { ToggleCheatCard } from '../components/cheat-cards/ToggleCheatCard.js';
import { ValueCheatCard } from '../components/cheat-cards/ValueCheatCard.js';
import { UnsupportedCheatCard } from '../components/cheat-cards/UnsupportedCheatCard.js';

function isSupported(c: StarlightCheat): c is StarlightSupportedCheat {
  return !('unsupported' in c) || c.unsupported !== true;
}

export function ActiveTrainerRoute(): JSX.Element {
  const trainer = useTrainerStore((s) => s.trainer);
  const activeCheats = useTrainerStore((s) => s.activeCheats);
  const values = useTrainerStore((s) => s.values);
  const trainerError = useTrainerStore((s) => s.error);
  const toggleCheat = useTrainerStore((s) => s.toggleCheat);
  const setCheatValue = useTrainerStore((s) => s.setCheatValue);

  const latchState = useLatchState((s) => s.state);
  const latchError = useLatchState((s) => s.error);
  const pidInput = useLatchState((s) => s.pidInput);
  const setPidInput = useLatchState((s) => s.setPidInput);
  const latch = useLatchState((s) => s.latch);
  const detach = useLatchState((s) => s.detach);

  if (!trainer) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted">
        <p className="text-sm">No trainer loaded.</p>
        <p className="text-xs mt-2">Go to Home and click "Load Trainer (.CT)".</p>
      </div>
    );
  }

  const [activeCategory, setActiveCategory] = useState<string>(trainer.categories[0]!.name);
  const category = trainer.categories.find((c) => c.name === activeCategory) ?? trainer.categories[0]!;
  const activeCount = category.cheats.filter((c) => activeCheats[c.id]).length;
  const totalCheats = trainer.categories.reduce((acc, c) => acc + c.cheats.length, 0);
  const supportedCount = trainer.categories.reduce(
    (acc, c) => acc + c.cheats.filter((x) => isSupported(x)).length, 0);

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 h-full">
      <div className="col-span-2 flex items-center gap-3 -mt-2 mb-2">
        <div>
          <div className="text-[13px] font-semibold">{trainer.game.name}</div>
          <div className="text-[10px] text-muted">trainer by {trainer.metadata.author ?? 'unknown'}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {latchState !== 'latched' && (
            <>
              <input
                value={pidInput}
                onChange={(e) => setPidInput(e.target.value)}
                placeholder="PID"
                className="w-20 px-2 py-1.5 text-xs rounded-sm bg-panel border border-line text-ink"
              />
              <button
                type="button"
                onClick={() => void latch()}
                className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
              >
                Latch
              </button>
            </>
          )}
          {latchState === 'latched' && (
            <button
              type="button"
              onClick={() => void detach()}
              className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-pink hover:text-neon-pink"
            >
              Detach
            </button>
          )}
        </div>
      </div>

      {(latchError || trainerError) && (
        <div className="col-span-2 text-xs text-neon-pink border border-neon-pink/40 bg-neon-pink/[0.06] rounded-sm px-3 py-2 mb-2">
          {latchError ?? trainerError}
        </div>
      )}

      <aside className="flex flex-col gap-1">
        <div className="text-[9px] tracking-wider uppercase text-muted px-2 pb-1">Categories</div>
        {trainer.categories.map((c) => {
          const isActive = c.name === activeCategory;
          return (
            <button
              key={c.name}
              type="button"
              onClick={() => setActiveCategory(c.name)}
              className={`text-left px-3 py-2 text-xs rounded-sm border flex justify-between items-center ${isActive ? 'bg-neon-pink/[0.06] border-neon-pink text-neon-pink glow-pink' : 'border-transparent text-ink hover:bg-line/30'}`}
            >
              <span>{c.name}</span>
              <span className={`text-[10px] ${isActive ? 'text-neon-pink' : 'text-muted'}`}>{c.cheats.length}</span>
            </button>
          );
        })}
        <div className="mt-auto pt-2.5 px-2 text-[10px] text-muted border-t border-line leading-relaxed">
          {supportedCount} of {totalCheats} entries supported<br />
          {totalCheats - supportedCount} unsupported
        </div>
      </aside>

      <section className="flex flex-col gap-2 overflow-y-auto">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[11px] text-muted">{category.cheats.length} cheats · {activeCount} active</span>
        </div>
        {category.cheats.map((c) => {
          if (!isSupported(c)) {
            return <UnsupportedCheatCard
              key={c.id}
              id={c.id}
              name={c.name}
              reason={c.unsupportedReason}
              {...(c.description !== undefined ? { description: c.description } : {})}
            />;
          }
          if (c.type === 'set') {
            return (
              <ValueCheatCard
                key={c.id}
                id={c.id}
                name={c.name}
                {...(c.description !== undefined ? { description: c.description } : {})}
                active={!!activeCheats[c.id]}
                value={values[c.id] ?? c.default ?? 0}
                step={c.step ?? 1}
                {...(c.min !== undefined ? { min: c.min } : {})}
                {...(c.max !== undefined ? { max: c.max } : {})}
                {...(c.hotkeys ? { hotkeys: c.hotkeys } : {})}
                onToggle={(id, next) => void toggleCheat(id, next)}
                onValueChange={(id, v) => void setCheatValue(id, v)}
              />
            );
          }
          return (
            <ToggleCheatCard
              key={c.id}
              id={c.id}
              name={c.name}
              {...(c.description !== undefined ? { description: c.description } : {})}
              active={!!activeCheats[c.id]}
              {...(c.hotkeys?.toggle ? { hotkey: c.hotkeys.toggle } : {})}
              onToggle={(id, next) => void toggleCheat(id, next)}
            />
          );
        })}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run all renderer tests**

Run: `pnpm --filter @starlight/desktop test`
Expected: PASS — all suites green (~25+).

- [ ] **Step 5: Build**

Run: `pnpm --filter @starlight/desktop build` — clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx apps/desktop/src/renderer/routes/HomeRoute.tsx apps/desktop/test/routes/ActiveTrainerRoute.test.tsx
git commit -m "feat(desktop): wire ActiveTrainerRoute to real stores via IPC"
```

---

## Task 8: Hotkey Host (globalShortcut)

**Files:**
- Create: `apps/desktop/src/main/hotkey-host.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/engine-host.ts` (re-register hotkeys after trainer loads)
- Modify: `apps/desktop/src/main/trainer-loader.ts` (notify hotkey-host)

When a trainer is loaded, register `globalShortcut` for every cheat that has a `toggle` hotkey. When fired, call `engineHost.toggleCheat()` AND emit a `cheat:toggled` event so the renderer can mirror UI state.

Phase 4 wires only the **toggle** hotkeys. Inc/Dec hotkeys for value cheats are deferred to Phase 4.5 (would need additional wiring to the value field).

- [ ] **Step 1: Implement hotkey-host.ts**

Create `apps/desktop/src/main/hotkey-host.ts`:

```ts
import { globalShortcut, BrowserWindow } from 'electron';
import type { StarlightTrainer, StarlightSupportedCheat } from '@starlight/ct-importer';
import * as engineHost from './engine-host.js';
import { CHANNELS, type StarlightEvent } from '../shared/ipc.js';

const registered: string[] = []; // accelerator strings we own

function isSupported(c: unknown): c is StarlightSupportedCheat {
  return !!c && typeof c === 'object' && !('unsupported' in c && (c as { unsupported: unknown }).unsupported === true);
}

function broadcast(e: StarlightEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.event, e);
}

/** State per cheat to know whether the next hotkey press should turn ON or OFF. */
const isOn = new Map<string, boolean>();

export function registerForTrainer(t: StarlightTrainer | null): void {
  unregisterAll();
  if (!t) return;
  for (const cat of t.categories) {
    for (const cheat of cat.cheats) {
      if (!isSupported(cheat)) continue;
      const accel = cheat.hotkeys?.toggle;
      if (!accel) continue;
      try {
        const ok = globalShortcut.register(accel, async () => {
          const next = !(isOn.get(cheat.id) ?? false);
          const r = await engineHost.toggleCheat(cheat.id, next);
          if (!r.ok) return;  // failure: do not flip local state
          isOn.set(cheat.id, next);
          broadcast({ type: 'cheat:toggled', cheatId: cheat.id, on: next, cause: 'hotkey' });
        });
        if (ok) registered.push(accel);
      } catch {
        // accelerator string Electron does not understand — skip
      }
    }
  }
}

export function unregisterAll(): void {
  for (const a of registered) globalShortcut.unregister(a);
  registered.length = 0;
  isOn.clear();
}

export function syncCheatState(cheatId: string, on: boolean): void {
  isOn.set(cheatId, on);
}
```

- [ ] **Step 2: Wire hotkey-host into trainer-loader**

Edit `apps/desktop/src/main/trainer-loader.ts`. After the `setActiveTrainer(out.trainer)` line, add:

```ts
import { registerForTrainer } from './hotkey-host.js';
// ...
setActiveTrainer(out.trainer);
registerForTrainer(out.trainer);
```

- [ ] **Step 3: Sync hotkey state when renderer toggles**

Edit `apps/desktop/src/main/engine-host.ts`. After the `freezeHandles.set(cheatId, handle)` line in `toggleCheat`, fire a state sync:

Wait — engine-host should not depend on hotkey-host (that's a layering issue). Better: have main/index.ts wrap the IPC handler.

Edit `apps/desktop/src/main/index.ts`. Replace the toggleCheat handler:

```ts
import { syncCheatState } from './hotkey-host.js';

ipcMain.handle(CHANNELS.toggleCheat,
  async (_evt, req: ToggleCheatRequest): Promise<IpcResult> => {
    const r = await engineHost.toggleCheat(req.cheatId, req.on);
    if (r.ok) syncCheatState(req.cheatId, req.on);
    return r;
  });
```

- [ ] **Step 4: Tear down hotkeys on app exit**

Edit `apps/desktop/src/main/index.ts`. Update the existing `before-quit` handler:

```ts
import { unregisterAll as unregisterHotkeys } from './hotkey-host.js';

app.on('before-quit', async () => {
  unregisterHotkeys();
  await engineHost.detach();
});
```

Also `app.on('will-quit', () => globalShortcut.unregisterAll())` belt-and-braces:

```ts
import { globalShortcut } from 'electron';
app.on('will-quit', () => globalShortcut.unregisterAll());
```

- [ ] **Step 5: Build**

Run: `pnpm --filter @starlight/desktop build`. Expected: clean.

- [ ] **Step 6: Manual smoke (Linux X11 with display)**

1. Run the C target.
2. `pnpm --filter @starlight/desktop dev`.
3. Load `target.CT`. Latch with the running PID.
4. Press F1. The terminal output of the desktop app's main process should show no errors; the renderer's UI should reflect that "Health" toggled on (the green pill on the cheat card). Press F1 again — toggles off.

In headless: skip; build is enough.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/hotkey-host.ts apps/desktop/src/main/trainer-loader.ts apps/desktop/src/main/index.ts apps/desktop/src/main/engine-host.ts
git commit -m "feat(desktop): global hotkey registration for cheat toggles"
```

---

## Task 9: Renderer Listens to Hotkey-Fired Events

**Files:**
- Modify: `apps/desktop/src/renderer/stores/trainer-store.ts`
- Modify: `apps/desktop/src/renderer/main.tsx` (wire onEvent listener at app boot)

When main fires a `cheat:toggled` event (because the user pressed F1), the renderer must update the corresponding `activeCheats[id]` so the UI mirrors reality.

- [ ] **Step 1: Add an `applyEvent` action to the trainer store**

Edit `apps/desktop/src/renderer/stores/trainer-store.ts`. Add to the interface:

```ts
applyEvent: (e: import('../../shared/ipc.js').StarlightEvent) => void;
```

Add to the implementation:

```ts
applyEvent(e) {
  if (e.type === 'cheat:toggled') {
    set((prev) => ({ activeCheats: { ...prev.activeCheats, [e.cheatId]: e.on } }));
  } else if (e.type === 'cheat:value-changed') {
    set((prev) => ({ values: { ...prev.values, [e.cheatId]: e.value } }));
  } else if (e.type === 'session:detached') {
    set({ activeCheats: {}, error: e.reason === 'process-exit' ? 'Process exited.' : null });
  }
},
```

- [ ] **Step 2: Subscribe at app boot**

Edit `apps/desktop/src/renderer/main.tsx`. Before `root.render(...)`, add:

```tsx
import { starlight } from './ipc-client.js';
import { useTrainerStore } from './stores/trainer-store.js';

starlight().onEvent((e) => useTrainerStore.getState().applyEvent(e));
```

- [ ] **Step 3: Test the new applyEvent action**

Append to `apps/desktop/test/stores/trainer-store.test.ts`:

```ts
describe('trainer-store applyEvent', () => {
  beforeEach(() => {
    setStarlightApi(fakeApi());
    useTrainerStore.setState({ trainer: minimalTrainer, activeCheats: {}, values: {}, error: null });
  });

  it('updates activeCheats on cheat:toggled', () => {
    useTrainerStore.getState().applyEvent({ type: 'cheat:toggled', cheatId: 'a', on: true, cause: 'hotkey' });
    expect(useTrainerStore.getState().activeCheats.a).toBe(true);
  });

  it('updates values on cheat:value-changed', () => {
    useTrainerStore.getState().applyEvent({ type: 'cheat:value-changed', cheatId: 'b', value: 2.5, cause: 'hotkey' });
    expect(useTrainerStore.getState().values.b).toBe(2.5);
  });

  it('clears active state and surfaces an error on session:detached due to process-exit', () => {
    useTrainerStore.setState({ activeCheats: { a: true } });
    useTrainerStore.getState().applyEvent({ type: 'session:detached', reason: 'process-exit' });
    expect(useTrainerStore.getState().activeCheats).toEqual({});
    expect(useTrainerStore.getState().error).toMatch(/process exited/i);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @starlight/desktop test`
Expected: PASS — store grows by 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/stores/trainer-store.ts apps/desktop/src/renderer/main.tsx apps/desktop/test/stores/trainer-store.test.ts
git commit -m "feat(desktop): renderer mirrors hotkey-driven state changes"
```

---

## Task 10: Process-Exit Detection

**Files:**
- Modify: `apps/desktop/src/main/engine-host.ts`
- Modify: `apps/desktop/src/main/index.ts`

When the target process exits (game closed, crashed), the Frida session emits its `detached` signal. We must:
1. Clear all freeze handles.
2. Tell the renderer via `session:detached` event.
3. Unregister hotkeys.

- [ ] **Step 1: Add a `subscribeDetached` callback hook to engine-host**

Edit `apps/desktop/src/main/engine-host.ts`. Add:

```ts
type DetachedListener = (reason: 'process-exit' | 'manual') => void;
let detachedListener: DetachedListener | null = null;
export function onDetached(listener: DetachedListener): void { detachedListener = listener; }
```

Modify the `attach` function to wire the underlying frida session's `detached` signal:

```ts
export async function attach(pid: number): Promise<AttachResult> {
  if (session) await detach();
  try {
    session = await engineAttach(pid);
    session.fridaSession.detached.connect(() => {
      // Frida fired detached — process exited or session was lost.
      // Clean up our state and notify.
      const wasManual = session === null;  // detach() sets session=null first
      for (const [, h] of freezeHandles) { h.cancel().catch(() => {}); }
      freezeHandles.clear();
      session = null;
      if (!wasManual && detachedListener) detachedListener('process-exit');
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof PermissionError) return { ok: false, code: 'permission', message: err.message };
    if (err instanceof AttachError)     return { ok: false, code: 'not-found', message: err.message };
    return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err) };
  }
}
```

(Adjust `detach()` to also call `detachedListener('manual')` after the manual teardown — for symmetry.)

- [ ] **Step 2: Subscribe in main**

Edit `apps/desktop/src/main/index.ts`. After `app.whenReady().then(...)`, register the detached listener:

```ts
import { unregisterAll as unregisterHotkeys } from './hotkey-host.js';

engineHost.onDetached((reason) => {
  unregisterHotkeys();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.event, { type: 'session:detached', reason });
  }
});
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @starlight/desktop build`. Expected: clean.

- [ ] **Step 4: Manual smoke (skip in headless)**

Repeat the latch + toggle flow. Then `kill <pid>` the C target. The desktop app's UI should clear `activeCheats` and show an error pill: "Process exited."

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/engine-host.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): handle process-exit and notify renderer"
```

---

## Task 11: PermissionError UX in Renderer

**Files:**
- Modify: `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`

The `latchError` already renders a simple banner (Task 7). When the error is a permission issue, show a more helpful message with a copy-paste fix. Detect by message content: if `latchError` matches `/ptrace|permission/i`, render the helpful version.

- [ ] **Step 1: Replace the error banner with a smarter component**

In `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`, find the existing error banner block:

```tsx
{(latchError || trainerError) && (
  <div className="col-span-2 text-xs text-neon-pink border border-neon-pink/40 bg-neon-pink/[0.06] rounded-sm px-3 py-2 mb-2">
    {latchError ?? trainerError}
  </div>
)}
```

Replace with:

```tsx
{(latchError || trainerError) && <ErrorBanner message={latchError ?? trainerError ?? ''} />}
```

Add this component at the bottom of the file:

```tsx
function ErrorBanner({ message }: { message: string }): JSX.Element {
  const isPermission = /ptrace|permission|EPERM/i.test(message);
  return (
    <div className="col-span-2 text-xs text-neon-pink border border-neon-pink/40 bg-neon-pink/[0.06] rounded-sm px-3 py-2 mb-2">
      <div className="font-semibold mb-1">{isPermission ? 'Permission denied' : 'Error'}</div>
      <div>{message}</div>
      {isPermission && (
        <div className="mt-2 text-muted">
          On Linux, lower the ptrace scope:{' '}
          <code className="text-neon-cyan font-mono">sudo sysctl kernel.yama.ptrace_scope=0</code>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Lint + build**

Run: `pnpm --filter @starlight/desktop lint && pnpm --filter @starlight/desktop build` — clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx
git commit -m "feat(desktop): helpful PermissionError banner with ptrace fix"
```

---

## Task 12: Final E2E Verification & CI

**Files:**
- Modify: `apps/desktop/README.md`

The CI workflow already runs `pnpm -r build` and `pnpm -r test`. Phase 4 added several main-process modules; verify they all build and tests pass.

- [ ] **Step 1: Full local verification**

```bash
pnpm -r build
pnpm -r lint
pnpm -r test
```

Expected: all packages build clean, no lint errors. Test counts:
- engine: 22 (unchanged)
- ct-importer: 60 (unchanged)
- desktop: ~28 (LatchPill 4 + GameTile 5 + cheat-cards 8 + ActiveTrainerRoute 4 + trainer-store 4+3 = 28)

- [ ] **Step 2: Manual e2e protocol (document for future testers)**

Edit `apps/desktop/README.md`. Replace the "What's mocked in Phase 3" section with:

```md

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
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/README.md
git commit -m "docs(desktop): document Phase 4 end-to-end demo protocol"
```

---

## Self-Review

**Spec coverage check (against design spec §3.x and Phase 4 plan §10):**

| Construct | Task |
|---|---|
| IPC bridge (typed contextBridge + ipcMain handlers) | Task 1 |
| `.CT` import wired through main | Task 2 |
| Frida attach/detach lifecycle in main | Task 3 |
| Cheat freeze/cancel/setValue via Frida | Task 4 |
| Renderer reads from real trainer store via IPC | Task 5 |
| Renderer latch flow async, with error surface | Task 6 |
| Active Trainer UI driven by IPC-loaded data | Task 7 |
| Global hotkey registration (toggle-only in v4) | Task 8 |
| Hotkey-driven state syncs back to renderer | Task 9 |
| Process-exit detection + cleanup | Task 10 |
| Helpful PermissionError UX | Task 11 |
| End-to-end verifiable against C test target | Task 12 |

**Placeholder scan:** none.

**Type consistency:** `StarlightApi` defined once in `shared/ipc.ts`, consumed identically by preload, main handlers (in pieces), renderer's `ipc-client.ts`, and tests (via injected fakes). `StarlightTrainer`, `StarlightCheat`, `StarlightSupportedCheat`, `StarlightAddress`, `ImportStats` re-exported from `shared/ipc.ts` so renderer doesn't need to depend on `@starlight/ct-importer` directly (Task 1 imports them as types only — runtime import in main only). `LatchState`, `LatchStore` shapes consistent across `latch-store.ts` and tests.

**Scope check:** This plan stays in Phase 4's lane (engine integration). It does NOT:
- Auto-detect installed games (Phase 4.5)
- Auto-detect running processes (Phase 4.5)
- Wire Inc/Dec hotkeys for value cheats (Phase 4.5 — needs additional state machine)
- Pull a community catalog (Phase 5)
- Render multiple latched sessions (out of scope)

**Risks flagged for the implementer:**
- The `module` address kind in `engine-host.resolveAddress` falls back to treating the offset as absolute when frida can't resolve the module. This is a v4 simplification — Phase 5 should refine module resolution semantics.
- The hotkey accelerator strings come from the importer's hotkey parser. Some accelerators (e.g. `Ctrl+F1+Up` chord-style) Electron's `globalShortcut` doesn't accept; the registration silently skips them.
- `globalShortcut` on Linux Wayland is partial (works on X11). Phase 6 will revisit Wayland support.
- `frida-node`'s native binding must NOT be bundled into the main process. The `externalizeDepsPlugin()` (Task 3 Step 1) is the load-bearing config that prevents this — if removed, the build will fail or the runtime will throw "Cannot find module 'frida'".
