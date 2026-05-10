# Cheat Engine Runtime Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a headless Cheat Engine subprocess from Starlight, replacing our static-only trainer execution path. Single-window UX: CE runs invisibly, our React UI is the only visible interface.

**Architecture:** CE Linux native ELF + autorun Lua script + HTTP polling between Electron main (server) and CE (client). Spec: `docs/superpowers/specs/2026-05-10-ce-runtime-bridge-design.md`.

**Tech Stack additions:** Node `http` (built-in) for the bridge server. No new npm deps.

---

## File Structure

```
starlight-runtimes/                           # NEW SIBLING REPO
├── README.md                                 # Provenance, GPL attribution
├── LICENSE.gpl-v2.txt
├── manifest.json                             # version + SHA256 + URLs per platform
└── (releases hold the actual tarballs)

apps/desktop/
├── src/main/
│   ├── ce-runtime-detect.ts          (NEW — Task 2)
│   ├── ce-runtime-install.ts         (NEW — Task 3)
│   ├── ce-bridge.ts                  (NEW — Task 5: HTTP server + JSON-RPC)
│   ├── ce-process.ts                 (NEW — Task 6: spawn/watchdog)
│   ├── ce-control-script.ts          (NEW — Task 4: emits the autorun Lua)
│   └── index.ts                      (modified — Task 7: wire IPC handlers)
├── src/shared/ipc.ts                 (modified — Task 7: new channels)
├── src/preload/index.ts              (modified — Task 7)
├── src/renderer/
│   ├── stores/ce-runtime-store.ts    (NEW — Task 3)
│   ├── components/RuntimeSetupModal.tsx (NEW — Task 3)
│   └── routes/ActiveTrainerRoute.tsx (modified — Task 8)
└── test/main/
    ├── ce-runtime-install.test.ts    (NEW — Task 3)
    └── ce-bridge.test.ts             (NEW — Task 5)
```

---

## Task 1: Set up `starlight-runtimes` repo + first release

**Files:**
- New repo: `darkharasho/starlight-runtimes` (or similar)
- Inside repo: `README.md`, `LICENSE.gpl-v2.txt`, `manifest.json`

This task lives outside the main repo. Goal: prepare the runtime tarball and the metadata our app fetches.

- [ ] **Step 1: Download CE Linux 7.6.6-4 from cheatengine.org**

```bash
mkdir -p /tmp/starlight-runtimes-build
cd /tmp/starlight-runtimes-build
curl -L -o ce-linux.zip 'https://cheatengine.org/download/CheatEngineLinux766-4.zip'
sha256sum ce-linux.zip
```

Expected size ≈ 24 MB. Record the SHA256.

- [ ] **Step 2: Repackage as tarball**

The published .zip works as-is. We could also `tar.zst` it for smaller size, but for v1 keep it as the original .zip — the consumer code is simpler if we don't repackage.

- [ ] **Step 3: Create `starlight-runtimes` GitHub repo**

```bash
gh repo create darkharasho/starlight-runtimes --public --description 'Runtime tarballs (Cheat Engine) for Starlight. CE is GPLv2 — sources at https://github.com/cheat-engine/cheat-engine.'
```

- [ ] **Step 4: Add README.md**

```markdown
# starlight-runtimes

Holds the Cheat Engine runtime tarballs that Starlight downloads on first
run. Cheat Engine is licensed under GPLv2 — full sources at
[github.com/cheat-engine/cheat-engine](https://github.com/cheat-engine/cheat-engine).

This repo only holds release artifacts; no derivative work or modification.

## Releases

| Tag | Platform | File | SHA256 | Upstream |
|---|---|---|---|---|
| `ce-7.6.6-4-linux` | linux-x64 | `CheatEngineLinux766-4.zip` | … | https://cheatengine.org/download/CheatEngineLinux766-4.zip |

See `manifest.json` for the machine-readable index.
```

- [ ] **Step 5: Add `LICENSE.gpl-v2.txt`**

Copy the GPLv2 text verbatim from https://www.gnu.org/licenses/gpl-2.0.txt.

- [ ] **Step 6: Add `manifest.json` and commit**

```json
{
  "schemaVersion": 1,
  "cheatEngine": {
    "version": "7.6.6-4",
    "platforms": {
      "linux-x64": {
        "url": "https://github.com/darkharasho/starlight-runtimes/releases/download/ce-7.6.6-4/CheatEngineLinux766-4.zip",
        "sha256": "<computed in step 1>",
        "extractedDir": "CheatEngineLinux766-4",
        "binaryRelative": "cheatengine-x86_64"
      }
    }
  }
}
```

```bash
cd starlight-runtimes
git add README.md LICENSE.gpl-v2.txt manifest.json
git commit -m "feat: bootstrap runtimes repo with CE 7.6.6-4 manifest"
git push
```

- [ ] **Step 7: Cut a GitHub release with the asset**

```bash
gh release create ce-7.6.6-4 \
  /tmp/starlight-runtimes-build/ce-linux.zip \
  --title 'Cheat Engine 7.6.6-4 (Linux)' \
  --notes 'Upstream: https://cheatengine.org/download/CheatEngineLinux766-4.zip'
```

Verify the URL in `manifest.json` matches the released asset's URL.

- [ ] **Step 8: From the main starlight repo, smoke-test the manifest URL**

```bash
curl -sSL 'https://raw.githubusercontent.com/darkharasho/starlight-runtimes/main/manifest.json' | python3 -m json.tool
```

Expected: prints the manifest. If 404, the repo is private — make it public or change the URL.

---

## Task 2: `ce-runtime-detect.ts` — locate or report missing runtime

**Files:**
- Create: `apps/desktop/src/main/ce-runtime-detect.ts`
- Create: `apps/desktop/test/main/ce-runtime-detect.test.ts`

Pure functions: given the user-data dir, report whether CE is installed and where its binary lives.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/main/ce-runtime-detect.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectCeRuntime } from '../../src/main/ce-runtime-detect.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-cedetect-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('detectCeRuntime', () => {
  it('returns not-installed when runtime dir is missing', async () => {
    const r = await detectCeRuntime({ runtimeRoot: join(dir, 'absent') });
    expect(r.status).toBe('not-installed');
  });

  it('returns not-installed when binary is missing', async () => {
    const ceDir = join(dir, 'CheatEngineLinux766-4');
    await mkdir(ceDir, { recursive: true });
    const r = await detectCeRuntime({ runtimeRoot: dir, extractedDir: 'CheatEngineLinux766-4', binaryRelative: 'cheatengine-x86_64' });
    expect(r.status).toBe('not-installed');
  });

  it('returns ready with absolute paths when binary exists and is executable', async () => {
    const ceDir = join(dir, 'CheatEngineLinux766-4');
    await mkdir(ceDir, { recursive: true });
    const bin = join(ceDir, 'cheatengine-x86_64');
    await writeFile(bin, '#!/bin/sh\nexit 0\n');
    await chmod(bin, 0o755);
    const r = await detectCeRuntime({ runtimeRoot: dir, extractedDir: 'CheatEngineLinux766-4', binaryRelative: 'cheatengine-x86_64' });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.binary).toBe(bin);
    expect(r.installDir).toBe(ceDir);
  });

  it('returns not-installed when binary exists but is not executable', async () => {
    const ceDir = join(dir, 'CheatEngineLinux766-4');
    await mkdir(ceDir, { recursive: true });
    const bin = join(ceDir, 'cheatengine-x86_64');
    await writeFile(bin, '#!/bin/sh\nexit 0\n');
    await chmod(bin, 0o644);
    const r = await detectCeRuntime({ runtimeRoot: dir, extractedDir: 'CheatEngineLinux766-4', binaryRelative: 'cheatengine-x86_64' });
    expect(r.status).toBe('not-installed');
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm --filter @starlight/desktop test -- ce-runtime-detect
```

Expected: module not found.

- [ ] **Step 3: Implement `ce-runtime-detect.ts`**

```ts
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

export interface DetectOpts {
  runtimeRoot: string;
  extractedDir?: string;
  binaryRelative?: string;
}

export type DetectResult =
  | { status: 'ready'; installDir: string; binary: string }
  | { status: 'not-installed' };

const DEFAULT_EXTRACTED = 'CheatEngineLinux766-4';
const DEFAULT_BIN = 'cheatengine-x86_64';

export async function detectCeRuntime(opts: DetectOpts): Promise<DetectResult> {
  const installDir = join(opts.runtimeRoot, opts.extractedDir ?? DEFAULT_EXTRACTED);
  const binary = join(installDir, opts.binaryRelative ?? DEFAULT_BIN);
  try {
    await access(binary, constants.X_OK);
    return { status: 'ready', installDir, binary };
  } catch {
    return { status: 'not-installed' };
  }
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm --filter @starlight/desktop test -- ce-runtime-detect
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ce-runtime-detect.ts apps/desktop/test/main/ce-runtime-detect.test.ts
git commit -m "feat(desktop): ce-runtime-detect locates installed Cheat Engine"
```

---

## Task 3: `ce-runtime-install.ts` + setup modal

**Files:**
- Create: `apps/desktop/src/main/ce-runtime-install.ts`
- Create: `apps/desktop/test/main/ce-runtime-install.test.ts`
- Create: `apps/desktop/src/renderer/stores/ce-runtime-store.ts`
- Create: `apps/desktop/src/renderer/components/RuntimeSetupModal.tsx`
- Modify: `apps/desktop/src/shared/ipc.ts` (CHANNELS additions)
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts` (handlers)

Downloads + verifies + extracts the CE bundle. Emits progress events to the renderer for the setup modal.

- [ ] **Step 1: Write the failing test for the install module**

Create `apps/desktop/test/main/ce-runtime-install.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { installCeRuntime } from '../../src/main/ce-runtime-install.js';

let dir: string;
let server: Server;
let port: number;

async function startServer(handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  });
}

async function makeFakeZip(): Promise<Buffer> {
  const z = new yazl.ZipFile();
  z.addBuffer(Buffer.from('#!/bin/sh\nexit 0\n'), 'CheatEngineLinux766-4/cheatengine-x86_64');
  z.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve());
    z.outputStream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-ceinstall-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('installCeRuntime', () => {
  it('downloads, verifies SHA256, extracts, and marks the binary executable', async () => {
    const zipBytes = await makeFakeZip();
    const sha = createHash('sha256').update(zipBytes).digest('hex');
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zipBytes.length) });
      res.end(zipBytes);
    });
    const events: Array<{ phase: string; current?: number; total?: number }> = [];
    await installCeRuntime({
      url: `http://127.0.0.1:${port}/CheatEngineLinux766-4.zip`,
      sha256: sha,
      runtimeRoot: dir,
      onProgress: (e) => events.push(e),
    });
    expect(events.some(e => e.phase === 'downloading')).toBe(true);
    expect(events.some(e => e.phase === 'extracting')).toBe(true);
    expect(events.some(e => e.phase === 'done')).toBe(true);
    const bin = join(dir, 'CheatEngineLinux766-4', 'cheatengine-x86_64');
    const stat = (await import('node:fs/promises')).stat;
    const s = await stat(bin);
    expect(s.mode & 0o100).not.toBe(0);
  });

  it('rejects when SHA256 mismatches and removes partial files', async () => {
    const zipBytes = await makeFakeZip();
    await startServer((_req, res) => { res.writeHead(200); res.end(zipBytes); });
    await expect(installCeRuntime({
      url: `http://127.0.0.1:${port}/x.zip`,
      sha256: 'deadbeef'.repeat(8),
      runtimeRoot: dir,
      onProgress: () => {},
    })).rejects.toThrow(/sha256/i);
  });

  it('rejects when HTTP returns non-200', async () => {
    await startServer((_req, res) => { res.writeHead(404); res.end(); });
    await expect(installCeRuntime({
      url: `http://127.0.0.1:${port}/x.zip`,
      sha256: 'a'.repeat(64),
      runtimeRoot: dir,
      onProgress: () => {},
    })).rejects.toThrow(/HTTP 404/);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm --filter @starlight/desktop test -- ce-runtime-install
```

Expected: module not found.

- [ ] **Step 3: Implement `ce-runtime-install.ts`**

```ts
import { createWriteStream } from 'node:fs';
import { mkdir, rm, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fromBuffer as openZipFromBuffer, type Entry } from 'yauzl';

export type ProgressEvent =
  | { phase: 'downloading'; current: number; total: number }
  | { phase: 'verifying' }
  | { phase: 'extracting'; current: number; total: number }
  | { phase: 'done' };

export interface InstallOpts {
  url: string;
  sha256: string;
  runtimeRoot: string;
  onProgress: (e: ProgressEvent) => void;
  /** binary path inside the extracted dir; chmod +x'd. Default: cheatengine-x86_64 in the only top-level dir. */
  binaryRelative?: string;
}

export async function installCeRuntime(opts: InstallOpts): Promise<void> {
  await mkdir(opts.runtimeRoot, { recursive: true });

  // Download to a temp file so partial downloads don't pollute runtimeRoot.
  const tmpZip = join(opts.runtimeRoot, `.download-${process.pid}-${Date.now()}.zip`);
  let res: Response;
  try {
    res = await fetch(opts.url);
  } catch (err) {
    await rm(tmpZip, { force: true });
    throw new Error(`runtime download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    await rm(tmpZip, { force: true });
    throw new Error(`HTTP ${res.status} fetching ${opts.url}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body) throw new Error('no response body');

  const out = createWriteStream(tmpZip);
  const hasher = createHash('sha256');
  let received = 0;
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
    received += value.length;
    opts.onProgress({ phase: 'downloading', current: received, total });
    await new Promise<void>((resolve, reject) => out.write(value, (err) => err ? reject(err) : resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((err: unknown) => err ? reject(err as Error) : resolve()));

  opts.onProgress({ phase: 'verifying' });
  const got = hasher.digest('hex');
  if (got.toLowerCase() !== opts.sha256.toLowerCase()) {
    await rm(tmpZip, { force: true });
    throw new Error(`sha256 mismatch: expected ${opts.sha256}, got ${got}`);
  }

  // Extract the zip into runtimeRoot
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(tmpZip);
  await extractZipTo(buf, opts.runtimeRoot, opts.onProgress);
  await rm(tmpZip, { force: true });

  // chmod +x on the binary (zip extraction loses executable bits in some flows)
  const binaryRel = opts.binaryRelative ?? 'CheatEngineLinux766-4/cheatengine-x86_64';
  await chmod(join(opts.runtimeRoot, binaryRel), 0o755).catch(() => {});

  opts.onProgress({ phase: 'done' });
}

function extractZipTo(buf: Buffer, dest: string, onProgress: (e: ProgressEvent) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    openZipFromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      const total = zip.entryCount;
      let i = 0;
      zip.on('entry', (entry: Entry) => {
        const target = join(dest, entry.fileName);
        const isDir = /\/$/.test(entry.fileName);
        if (isDir) {
          mkdir(target, { recursive: true }).then(() => { i++; onProgress({ phase: 'extracting', current: i, total }); zip.readEntry(); }).catch(reject);
          return;
        }
        zip.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) return reject(err2 ?? new Error('failed to open zip entry'));
          mkdir(join(target, '..'), { recursive: true }).then(() => {
            const w = createWriteStream(target);
            stream.pipe(w);
            w.on('finish', () => { i++; onProgress({ phase: 'extracting', current: i, total }); zip.readEntry(); });
            w.on('error', reject);
          }).catch(reject);
        });
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm --filter @starlight/desktop test -- ce-runtime-install
```

Expected: 3 passing.

- [ ] **Step 5: Add IPC channels for setup**

Edit `apps/desktop/src/shared/ipc.ts`. After the existing `CHANNELS` object, add:

```ts
// inside CHANNELS:
ceRuntimeStatus:   'starlight:ceRuntime:status',     // GET current status
ceRuntimeInstall:  'starlight:ceRuntime:install',    // start install (one-shot)
ceRuntimeProgress: 'starlight:ceRuntime:progress',   // event channel (renderer subscribes)

// alongside existing types:
export type CeRuntimeStatus =
  | { status: 'ready'; installDir: string; binary: string }
  | { status: 'not-installed' }
  | { status: 'installing'; phase: string; current?: number; total?: number };
```

Update `StarlightApi`:
```ts
ceRuntimeStatus(): Promise<CeRuntimeStatus>;
ceRuntimeInstall(): Promise<{ ok: true } | { ok: false; error: string }>;
onCeRuntimeProgress(cb: (e: { phase: string; current?: number; total?: number }) => void): () => void;
```

- [ ] **Step 6: Wire main + preload + renderer store**

(Provide concrete code: `apps/desktop/src/main/index.ts` adds two ipcMain.handle calls; preload exposes them; create `apps/desktop/src/renderer/stores/ce-runtime-store.ts` that holds status and a `install()` method calling the IPC.)

```ts
// apps/desktop/src/main/index.ts — additions
import { detectCeRuntime } from './ce-runtime-detect.js';
import { installCeRuntime } from './ce-runtime-install.js';
import { app } from 'electron';
import { join } from 'node:path';

const RUNTIME_ROOT = join(app.getPath('userData'), 'runtime');
const RUNTIMES_MANIFEST_URL = 'https://raw.githubusercontent.com/darkharasho/starlight-runtimes/main/manifest.json';

ipcMain.handle(CHANNELS.ceRuntimeStatus, async () => detectCeRuntime({ runtimeRoot: RUNTIME_ROOT }));
ipcMain.handle(CHANNELS.ceRuntimeInstall, async (evt) => {
  try {
    const m = await fetch(RUNTIMES_MANIFEST_URL).then(r => r.json()) as { cheatEngine: { platforms: { 'linux-x64': { url: string; sha256: string } } } };
    const linux = m.cheatEngine.platforms['linux-x64'];
    await installCeRuntime({
      url: linux.url, sha256: linux.sha256, runtimeRoot: RUNTIME_ROOT,
      onProgress: (e) => evt.sender.send(CHANNELS.ceRuntimeProgress, e),
    });
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
});
```

```ts
// apps/desktop/src/preload/index.ts — additions inside the api object:
ceRuntimeStatus:   () => ipcRenderer.invoke(CHANNELS.ceRuntimeStatus),
ceRuntimeInstall:  () => ipcRenderer.invoke(CHANNELS.ceRuntimeInstall),
onCeRuntimeProgress: (cb: (e: any) => void) => {
  const handler = (_e: unknown, payload: any) => cb(payload);
  ipcRenderer.on(CHANNELS.ceRuntimeProgress, handler);
  return () => ipcRenderer.removeListener(CHANNELS.ceRuntimeProgress, handler);
},
```

```ts
// apps/desktop/src/renderer/stores/ce-runtime-store.ts
import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CeRuntimeStatus } from '../../shared/ipc.js';

interface CeRuntimeState {
  status: CeRuntimeStatus | null;
  installing: boolean;
  installError: string | null;
  refresh: () => Promise<void>;
  install: () => Promise<void>;
}

export const useCeRuntimeStore = create<CeRuntimeState>((set) => ({
  status: null, installing: false, installError: null,
  refresh: async () => { set({ status: await starlight().ceRuntimeStatus() }); },
  install: async () => {
    set({ installing: true, installError: null });
    const off = starlight().onCeRuntimeProgress((e) => {
      set({ status: { status: 'installing', phase: e.phase, current: e.current, total: e.total } });
    });
    try {
      const r = await starlight().ceRuntimeInstall();
      if (!r.ok) set({ installError: r.error });
      const next = await starlight().ceRuntimeStatus();
      set({ status: next, installing: false });
    } finally { off(); }
  },
}));
```

- [ ] **Step 7: Setup modal UI**

Create `apps/desktop/src/renderer/components/RuntimeSetupModal.tsx`. Mounted in `App.tsx`. Visible when status is `not-installed` or `installing`.

```tsx
import { useEffect } from 'react';
import { useCeRuntimeStore } from '../stores/ce-runtime-store.js';

export function RuntimeSetupModal(): JSX.Element | null {
  const status = useCeRuntimeStore((s) => s.status);
  const installing = useCeRuntimeStore((s) => s.installing);
  const error = useCeRuntimeStore((s) => s.installError);
  const refresh = useCeRuntimeStore((s) => s.refresh);
  const install = useCeRuntimeStore((s) => s.install);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!status || status.status === 'ready') return null;
  if (!installing && status.status === 'not-installed') {
    return (
      <Backdrop>
        <h2 className="text-base font-semibold">Set up Cheat Engine</h2>
        <p className="text-xs text-muted mt-2 max-w-[420px]">
          Starlight uses Cheat Engine as its trainer engine. We&apos;ll download a one-time ~24 MB
          runtime to your user data directory. It runs invisibly in the background.
        </p>
        {error && <p className="text-xs text-neon-pink mt-2">{error}</p>}
        <button onClick={() => void install()}
                className="mt-3 px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan">
          Set up
        </button>
      </Backdrop>
    );
  }

  if (status.status === 'installing') {
    const pct = status.total && status.current
      ? Math.round((status.current / status.total) * 100) : 0;
    return (
      <Backdrop>
        <h2 className="text-base font-semibold">Installing runtime…</h2>
        <div className="text-xs text-muted mt-2">{status.phase}</div>
        <div className="w-[280px] h-1.5 bg-line rounded-sm mt-3 overflow-hidden">
          <div className="h-full bg-neon-cyan glow-cyan" style={{ width: `${pct}%` }} />
        </div>
      </Backdrop>
    );
  }
  return null;
}

function Backdrop({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div className="px-6 py-5 rounded-md border border-neon-cyan/40 bg-panel/95 glow-cyan max-w-md">{children}</div>
    </div>
  );
}
```

Mount in `App.tsx` after `<TrainerLoadingOverlay />`.

- [ ] **Step 8: Run + commit**

```bash
pnpm --filter @starlight/desktop test
pnpm --filter @starlight/desktop lint
pnpm --filter @starlight/desktop build
git add ...
git commit -m "feat(desktop): CE runtime download + setup modal"
```

Note: this task is bigger than most because it covers the full setup UX. After Task 3 the app can install CE end-to-end but doesn't yet use it for trainers — that's Task 7+.

---

## Task 4: `ce-control-script.ts` — emits the autorun Lua source

**Files:**
- Create: `apps/desktop/src/main/ce-control-script.ts`
- Create: `apps/desktop/test/main/ce-control-script.test.ts`

A pure function that returns the Lua source for `autorun/zzz-starlight.lua`,
parameterised on the bridge URL. We treat this as a TS string template so
changes are version-controlled and testable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { generateControlScript } from '../../src/main/ce-control-script.js';

describe('generateControlScript', () => {
  it('embeds the supplied bridge URL', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://127.0.0.1:47832' });
    expect(lua).toContain("'http://127.0.0.1:47832'");
  });
  it('hides MainForm and starts an HTTP poll loop', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toMatch(/getMainForm\(\):hide\(\)/);
    expect(lua).toMatch(/getInternet/);
    expect(lua).toMatch(/createTimer/);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface ControlScriptOpts { bridgeUrl: string }

export function generateControlScript(opts: ControlScriptOpts): string {
  const url = JSON.stringify(opts.bridgeUrl);
  return `\
-- Starlight CE control script. Auto-generated.
local BRIDGE_URL = ${url}

local function safe(f) return pcall(f) end

local function trace(msg)
  local f = io.open('/tmp/starlight-ce.log', 'a')
  if f then f:write(os.date('%H:%M:%S') .. ' ' .. tostring(msg) .. '\\n'); f:close() end
end

trace('autorun loaded')

local boot = createTimer(nil, false)
boot.Interval = 200
boot.OnTimer = function()
  boot.Enabled = false
  trace('boot timer fired')
  safe(function() getMainForm():hide() end)
  safe(function() hideAllCEWindows() end)

  local i = getInternet('starlight')
  if not i then trace('no internet object'); return end

  local function dispatch(cmd)
    -- Returns a JSON string. Minimal command set; expanded in Task 5.
    if cmd.method == 'ping' then return '{"ok":true}' end
    if cmd.method == 'list_records' then
      local al = getAddressList()
      local out = {'{\\"records\\":['}
      local n = al.Count
      for idx = 0, n - 1 do
        local r = al:getMemoryRecord(idx)
        local desc = (r.Description or ''):gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"')
        local row = string.format('{\\"id\\":%d,\\"name\\":\\"%s\\",\\"isActive\\":%s,\\"isGroupHeader\\":%s}',
          r.ID or idx, desc, tostring(r.Active or false), tostring(r.IsGroupHeader or false))
        if idx > 0 then table.insert(out, ',') end
        table.insert(out, row)
      end
      table.insert(out, ']}')
      return table.concat(out)
    end
    if cmd.method == 'set_active' then
      local id = cmd.params and cmd.params.id
      local active = cmd.params and cmd.params.active
      local al = getAddressList()
      for idx = 0, al.Count - 1 do
        local r = al:getMemoryRecord(idx)
        if (r.ID or idx) == id then r.Active = active and true or false; return '{"ok":true}' end
      end
      return '{"ok":false,"error":"record not found"}'
    end
    return '{"ok":false,"error":"unknown method"}'
  end

  local poll = createTimer(nil, false)
  poll.Interval = 250
  poll.OnTimer = function()
    local body = i.getURL(BRIDGE_URL .. '/poll')
    if not body or body == '' or body == '{}' then return end
    -- Body is a JSON object: {id, method, params?}
    local cmd = pcall(load('return ' .. body:gsub('\\"', '"'))) and load('return ' .. body:gsub('\\"', '"'))() or nil
    if not cmd then return end
    local result = dispatch(cmd)
    i.postURL(BRIDGE_URL .. '/result', '{"id":' .. (cmd.id or 0) .. ',"result":' .. result .. '}')
  end
  poll.Enabled = true
end
boot.Enabled = true
`;
}
```

(Note: this is a v1 dispatch — JSON parsing on the Lua side is naive. Production would either use a proper JSON library or move to length-prefixed binary. Acceptable for spike.)

- [ ] **Step 3: Run, verify PASS**

```bash
pnpm --filter @starlight/desktop test -- ce-control-script
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/ce-control-script.ts apps/desktop/test/main/ce-control-script.test.ts
git commit -m "feat(desktop): ce-control-script generator (Lua autorun source)"
```

---

## Task 5: `ce-bridge.ts` — HTTP server + JSON-RPC

**Files:**
- Create: `apps/desktop/src/main/ce-bridge.ts`
- Create: `apps/desktop/test/main/ce-bridge.test.ts`

Hosts an HTTP server on a random localhost port. Maintains a command queue and pending-response map. CE polls `/poll` (long-poll up to 5s); we respond with the next queued command. CE posts results to `/result`.

- [ ] **Step 1: Write the failing test**

(Outline: spin up `createBridge()`, simulate an HTTP client, verify queue/poll/result roundtrip.)

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createBridge, type Bridge } from '../../src/main/ce-bridge.js';

let bridge: Bridge;
afterEach(async () => { await bridge?.close(); });

describe('ce-bridge', () => {
  it('roundtrips a command via /poll then /result', async () => {
    bridge = await createBridge();
    const promise = bridge.send({ method: 'ping' });
    // Simulate CE polling
    const polled = await fetch(`${bridge.url}/poll`).then(r => r.json());
    expect(polled.method).toBe('ping');
    expect(typeof polled.id).toBe('number');
    // Simulate CE posting a result back
    await fetch(`${bridge.url}/result`, {
      method: 'POST', body: JSON.stringify({ id: polled.id, result: { ok: true } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const r = await promise;
    expect(r).toEqual({ ok: true });
  });

  it('long-polls /poll up to a timeout and returns 204 if no command', async () => {
    bridge = await createBridge({ pollTimeoutMs: 250 });
    const start = Date.now();
    const res = await fetch(`${bridge.url}/poll`);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(204);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { createServer, type Server } from 'node:http';

interface PendingCommand {
  id: number;
  method: string;
  params?: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface BridgeOpts {
  pollTimeoutMs?: number;
}

export interface Bridge {
  url: string;
  port: number;
  send: (cmd: { method: string; params?: unknown }) => Promise<unknown>;
  close: () => Promise<void>;
}

export async function createBridge(opts: BridgeOpts = {}): Promise<Bridge> {
  const pollTimeoutMs = opts.pollTimeoutMs ?? 5000;
  const queue: PendingCommand[] = [];
  const pending = new Map<number, PendingCommand>();
  let nextId = 1;
  let waiter: ((cmd: PendingCommand | null) => void) | null = null;

  const handler = (req: import('http').IncomingMessage, res: import('http').ServerResponse): void => {
    if (req.url === '/poll' && req.method === 'GET') {
      const next = queue.shift();
      if (next) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: next.id, method: next.method, params: next.params ?? null }));
        return;
      }
      const timer = setTimeout(() => { waiter = null; res.writeHead(204); res.end(); }, pollTimeoutMs);
      waiter = (cmd) => {
        clearTimeout(timer);
        if (cmd) { res.writeHead(200, { 'Content-Type': 'application/json' });
                   res.end(JSON.stringify({ id: cmd.id, method: cmd.method, params: cmd.params ?? null })); }
        else    { res.writeHead(204); res.end(); }
      };
      return;
    }
    if (req.url === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        try {
          const obj = JSON.parse(body) as { id: number; result?: unknown; error?: string };
          const p = pending.get(obj.id);
          if (p) { pending.delete(obj.id); if (obj.error) p.reject(new Error(obj.error)); else p.resolve(obj.result ?? null); }
          res.writeHead(204); res.end();
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url, port: addr.port,
    send: (cmd) => new Promise((resolve, reject) => {
      const id = nextId++;
      const p: PendingCommand = { id, method: cmd.method, ...(cmd.params !== undefined ? { params: cmd.params } : {}), resolve, reject };
      pending.set(id, p);
      if (waiter) { const w = waiter; waiter = null; w(p); }
      else queue.push(p);
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @starlight/desktop test -- ce-bridge
git add apps/desktop/src/main/ce-bridge.ts apps/desktop/test/main/ce-bridge.test.ts
git commit -m "feat(desktop): ce-bridge HTTP server with JSON-RPC queue"
```

---

## Task 6: `ce-process.ts` — spawn / watchdog / shutdown

**Files:**
- Create: `apps/desktop/src/main/ce-process.ts`
- Create: `apps/desktop/test/main/ce-process.test.ts`

Manages the CE child process lifecycle. Spawns CE pointing at a .CT file
with the autorun control script written into its `autorun/` directory.
Watches for unexpected exit and cleans up on shutdown.

- [ ] **Step 1: Write the failing test**

(Test uses a fake CE binary — a shell script that writes a heartbeat then exits cleanly. Validates: process spawns, exit triggers callback, cleanup removes autorun script.)

(Concrete code omitted for brevity; details: createProcess({ binaryPath, ctPath, autorunPath, controlScriptSource, onExit }) returns { pid, kill() }.)

- [ ] **Step 2: Implement** (sketch — full code in execution)

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface CeProcessOpts {
  binaryPath: string;
  installDir: string;        // where to drop the autorun script
  ctPath: string;            // .CT to load on launch
  controlScript: string;     // Lua source from generateControlScript()
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface CeProcessHandle {
  pid: number;
  kill: (signal?: NodeJS.Signals) => Promise<void>;
}

export async function spawnCeProcess(opts: CeProcessOpts): Promise<CeProcessHandle> {
  const autorunPath = join(opts.installDir, 'autorun', 'zzz-starlight.lua');
  await writeFile(autorunPath, opts.controlScript, 'utf8');
  const child: ChildProcess = spawn(opts.binaryPath, [opts.ctPath], {
    cwd: opts.installDir, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cleanup = async (): Promise<void> => { await unlink(autorunPath).catch(() => {}); };
  child.on('exit', (code, signal) => { void cleanup(); opts.onExit?.(code, signal); });
  if (!child.pid) throw new Error('CE failed to spawn (no pid)');
  return {
    pid: child.pid,
    kill: async (signal = 'SIGTERM') => {
      child.kill(signal);
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}
```

- [ ] **Step 3: Run + commit**

---

## Task 7: Wire into trainer-launch flow

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (orchestrate detect → spawn → bridge)
- Modify: `apps/desktop/src/renderer/stores/catalog-store.ts` (replace fetchTrainerLive path)
- Modify: `apps/desktop/src/shared/ipc.ts` (new channels for cheat ops)

Orchestrate the full launch: when renderer requests a trainer, detect runtime → ensure setup if missing → spawn CE → connect bridge → fetch records → return to renderer.

(Detailed steps in execution; this task is the integration centre and biggest piece.)

---

## Task 8: Renderer integration

**Files:**
- Modify: `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`
- Modify: `apps/desktop/src/renderer/stores/trainer-store.ts`

Wire the existing `ToggleCheatCard` / `ValueCheatCard` onclick handlers to the bridge instead of (or in addition to) the existing engine path. The user-visible UX is identical — toggles fire, values change — but under the hood the work happens in CE.

---

## Task 9: End-to-end + license attribution screen

**Files:**
- Modify: `apps/desktop/src/renderer/routes/SettingsRoute.tsx` (or new About modal)

Add a "Licenses" or "Attributions" panel listing CE, ct-importer dependencies, etc. Link to upstream sources. Required by GPLv2 distribution.

End-to-end test: pick a real fearlessrevolution Type-B trainer (CK3 test target). Verify:
- Setup modal flows on first run
- Trainer fetched, CE spawned invisibly
- Cheats render in our UI
- Toggling activates real cheats in the game

---

## Self-Review

**Spec coverage** (against `2026-05-10-ce-runtime-bridge-design.md`):
- Process lifecycle: Tasks 6, 7
- IPC protocol: Tasks 4, 5
- Distribution model: Tasks 1, 2, 3
- License compliance: Tasks 1, 9
- Failure modes (CE crashes, network blocked, partial download): Tasks 3, 6

**Type consistency:** `DetectResult`, `ProgressEvent`, `Bridge`, `CeProcessHandle` defined once each, used across modules.

**Risks flagged:**
- Lua JSON parsing in Task 4 is naive (uses `load()` to eval); acceptable for v1 but a real JSON encoder/decoder belongs in Task 4 follow-up.
- `pollTimeoutMs` default of 5s is arbitrary; tune after end-to-end testing.
- The CE Linux 7.6.6-4 binary expects Qt6 to be present on the host. Bazzite/Fedora has it. Other distros may not — the setup modal should surface an "X server / Qt6 missing" diagnostic when CE fails to launch (Task 6 follow-up).
- Long-running CE process leaks if Electron crashes ungracefully. Add a PID file and cleanup on next launch (Task 6 follow-up).
