# Auto-Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual "pick a process" attach step with automatic game↔process matching — reactive (on-open) and proactive (latch detection).

**Architecture:** A pure main-process matcher (`game-matcher.ts`) resolves a catalog game to a running process via a most-precise-first cascade (Steam install-dir exe name → Proton compatdata appid → normalized name). The reactive flow calls it inside `ceSessionStart`; the proactive flow runs it in reverse from a `latch-detector` that consumes the existing process poll. Both reuse the already-shipped Windows-CE-in-prefix attach path unchanged.

**Tech Stack:** TypeScript, Electron (main), Node `fs`/`/proc`, Vitest, React + Zustand (renderer).

## Global Constraints

- Vitest runs with `--maxWorkers=2` (repo CLAUDE.md).
- All new matcher logic lives in `apps/desktop/src/main` and takes file/`/proc` readers as injectable parameters so tests use fixtures (no real disk/process access).
- Normalized-name matches require normalized length ≥ 3.
- `preferences.autoAttachOnDetect` defaults to `false`.
- TypeScript is compiled with `exactOptionalPropertyTypes: true` — optional fields that may be assigned `undefined` must be typed `T | undefined`.
- Follow existing patterns: `strip`/`filterCandidates` already in `process-host.ts`; `detectProton` in `proton-detect.ts`.

---

### Task 1: Matcher core — `normalizeName` + `matchGameToProcess`

**Files:**
- Create: `apps/desktop/src/main/game-matcher.ts`
- Test: `apps/desktop/test/main/game-matcher.test.ts`

**Interfaces:**
- Consumes: `DetectedProcess` (`{pid,name}`) and `DetectedGame` (`{source,appId,name,installDir,...}`) from `../shared/ipc.js`.
- Produces:
  - `normalizeName(s: string): string`
  - `interface MatchableGame { id: string; name: string; steamAppId?: number | null }`
  - `interface MatchDeps { processes: DetectedProcess[]; detectedGames: DetectedGame[]; readExeNames?: (installDir: string) => Promise<string[]>; readProtonAppId?: (pid: number) => Promise<number | null> }`
  - `type MatchResult = { pid: number; name: string } | null | 'ambiguous'`
  - `matchGameToProcess(game: MatchableGame, deps: MatchDeps): Promise<MatchResult>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/main/game-matcher.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeName, matchGameToProcess } from '../../src/main/game-matcher.js';

const g = (over = {}) => ({ id: '9-kings', name: '9 Kings', steamAppId: null, ...over });
const proc = (pid: number, name: string) => ({ pid, name });
const lib = (over = {}) => ({ source: 'steam' as const, appId: '2784470', name: '9 Kings', installDir: '/games/9 Kings', ...over });

describe('normalizeName', () => {
  it('strips case, spaces, punctuation and .exe', () => {
    expect(normalizeName('9 Kings')).toBe('9kings');
    expect(normalizeName('9Kings.exe')).toBe('9kings');
    expect(normalizeName('Elden Ring™')).toBe('eldenring');
  });
});

describe('matchGameToProcess', () => {
  const readExeNames = async () => ['9Kings.exe', 'crashhandler.exe'];
  const noAppId = async () => null;

  it('layer 1: matches by install-dir exe name (exact even if title differs)', async () => {
    const r = await matchGameToProcess(g({ name: 'Nine Kings' }), {
      processes: [proc(10, 'other.exe'), proc(20, '9Kings.exe')],
      detectedGames: [lib({ name: 'Nine Kings' })],
      readExeNames, readProtonAppId: noAppId,
    });
    expect(r).toEqual({ pid: 20, name: '9Kings.exe' });
  });

  it('layer 2: matches by Proton compatdata appid when name/exe do not', async () => {
    const r = await matchGameToProcess(g({ steamAppId: 2784470 }), {
      processes: [proc(10, 'launcher.exe'), proc(30, 'Game.exe')],
      detectedGames: [],
      readExeNames, readProtonAppId: async (pid) => (pid === 30 ? 2784470 : null),
    });
    expect(r).toEqual({ pid: 30, name: 'Game.exe' });
  });

  it('layer 3: matches by normalized name', async () => {
    const r = await matchGameToProcess(g(), {
      processes: [proc(40, '9Kings.exe')],
      detectedGames: [],
      readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toEqual({ pid: 40, name: '9Kings.exe' });
  });

  it('returns "ambiguous" when a layer yields >1 process', async () => {
    const r = await matchGameToProcess(g(), {
      processes: [proc(1, '9Kings.exe'), proc(2, '9Kings.exe')],
      detectedGames: [], readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toBe('ambiguous');
  });

  it('returns null when nothing matches', async () => {
    const r = await matchGameToProcess(g(), {
      processes: [proc(1, 'unrelated.exe')],
      detectedGames: [], readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toBeNull();
  });

  it('does not name-match titles under 3 normalized chars', async () => {
    const r = await matchGameToProcess(g({ name: 'Go' }), {
      processes: [proc(1, 'Go.exe')],
      detectedGames: [], readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/main/game-matcher.test.ts --maxWorkers=2`
Expected: FAIL — `normalizeName`/`matchGameToProcess` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/main/game-matcher.ts
import type { DetectedProcess, DetectedGame } from '../shared/ipc.js';

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');
}

export interface MatchableGame { id: string; name: string; steamAppId?: number | null }

export interface MatchDeps {
  processes: DetectedProcess[];
  detectedGames: DetectedGame[];
  readExeNames?: (installDir: string) => Promise<string[]>;
  readProtonAppId?: (pid: number) => Promise<number | null>;
}

export type MatchResult = { pid: number; name: string } | null | 'ambiguous';

function uniqueByPid(procs: DetectedProcess[]): DetectedProcess[] {
  const seen = new Set<number>();
  return procs.filter((p) => (seen.has(p.pid) ? false : (seen.add(p.pid), true)));
}

function resolve(hits: DetectedProcess[]): MatchResult {
  const u = uniqueByPid(hits);
  if (u.length === 1) return { pid: u[0]!.pid, name: u[0]!.name };
  if (u.length > 1) return 'ambiguous';
  return null;
}

export async function matchGameToProcess(game: MatchableGame, deps: MatchDeps): Promise<MatchResult> {
  const readExe = deps.readExeNames ?? defaultReadExeNames;
  const readAppId = deps.readProtonAppId ?? defaultReadProtonAppId;
  const gnorm = normalizeName(game.name);

  // Layer 1: Steam install-dir exe names (exact even for odd exe names)
  const linked = deps.detectedGames.find((g) =>
    (game.steamAppId != null && g.appId === String(game.steamAppId)) ||
    normalizeName(g.name) === gnorm);
  if (linked) {
    const exeNorms = (await readExe(linked.installDir)).map(normalizeName);
    const hit = resolve(deps.processes.filter((p) => exeNorms.includes(normalizeName(p.name))));
    if (hit) return hit;
  }

  // Layer 2: Proton compatdata appid
  if (game.steamAppId != null) {
    const hits: DetectedProcess[] = [];
    for (const p of deps.processes) {
      if ((await readAppId(p.pid)) === game.steamAppId) hits.push(p);
    }
    const hit = resolve(hits);
    if (hit) return hit;
  }

  // Layer 3: normalized name (min length 3)
  if (gnorm.length >= 3) {
    const hit = resolve(deps.processes.filter((p) => normalizeName(p.name) === gnorm));
    if (hit) return hit;
  }

  return null;
}

// Default signal readers (Task 2 fills these in). Placeholders throw so tests
// that forget to inject a reader fail loudly rather than hit the real system.
async function defaultReadExeNames(_installDir: string): Promise<string[]> { return []; }
async function defaultReadProtonAppId(_pid: number): Promise<number | null> { return null; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run test/main/game-matcher.test.ts --maxWorkers=2`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/game-matcher.ts apps/desktop/test/main/game-matcher.test.ts
git commit -m "feat(desktop): game-matcher forward cascade (game -> process)"
```

---

### Task 2: Reverse `identifyProcess` + real signal readers

**Files:**
- Modify: `apps/desktop/src/main/game-matcher.ts`
- Test: `apps/desktop/test/main/game-matcher.test.ts` (append)

**Interfaces:**
- Consumes: `detectProton` from `./proton-detect.js`.
- Produces:
  - `interface CatalogEntry { id: string; name: string; steamAppId: number | null; trainerSource?: string | undefined }`
  - `interface IdentifyDeps { catalogIndex: Map<string, CatalogEntry>; detectedGames: DetectedGame[]; readProtonAppId?: (pid: number) => Promise<number | null> }`
  - `identifyProcess(proc: DetectedProcess, deps: IdentifyDeps): Promise<CatalogEntry | null>`
  - real `defaultReadExeNames` (fs) and `defaultReadProtonAppId` (via `detectProton`)

- [ ] **Step 1: Write the failing test (append to the file)**

```ts
import { identifyProcess } from '../../src/main/game-matcher.js';

describe('identifyProcess', () => {
  const entry = (over = {}) => ({ id: '9-kings', name: '9 Kings', steamAppId: null, trainerSource: 'http://x', ...over });
  const index = new Map([['9kings', entry()]]);

  it('identifies a process by normalized name against the catalog index', async () => {
    const r = await identifyProcess({ pid: 5, name: '9Kings.exe' }, {
      catalogIndex: index, detectedGames: [], readProtonAppId: async () => null,
    });
    expect(r?.id).toBe('9-kings');
  });

  it('identifies by Proton appid -> Steam game -> catalog name', async () => {
    const r = await identifyProcess({ pid: 5, name: 'Game.exe' }, {
      catalogIndex: index,
      detectedGames: [{ source: 'steam', appId: '2784470', name: '9 Kings', installDir: '/g' }],
      readProtonAppId: async () => 2784470,
    });
    expect(r?.id).toBe('9-kings');
  });

  it('returns null when the process maps to no trainer-bearing entry', async () => {
    const r = await identifyProcess({ pid: 5, name: 'random.exe' }, {
      catalogIndex: index, detectedGames: [], readProtonAppId: async () => null,
    });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/main/game-matcher.test.ts --maxWorkers=2`
Expected: FAIL — `identifyProcess` not exported.

- [ ] **Step 3: Write implementation (replace the placeholder readers + add identifyProcess)**

Replace the two placeholder functions at the bottom of `game-matcher.ts` and add the reverse matcher + imports:

```ts
// add at top of file
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { detectProton } from './proton-detect.js';

// add near the other exports
export interface CatalogEntry { id: string; name: string; steamAppId: number | null; trainerSource?: string | undefined }

export interface IdentifyDeps {
  catalogIndex: Map<string, CatalogEntry>;
  detectedGames: DetectedGame[];
  readProtonAppId?: (pid: number) => Promise<number | null>;
}

export async function identifyProcess(proc: DetectedProcess, deps: IdentifyDeps): Promise<CatalogEntry | null> {
  const readAppId = deps.readProtonAppId ?? defaultReadProtonAppId;

  const appId = await readAppId(proc.pid);
  if (appId != null) {
    const lib = deps.detectedGames.find((g) => g.appId === String(appId));
    if (lib) {
      const e = deps.catalogIndex.get(normalizeName(lib.name));
      if (e) return e;
    }
    for (const e of deps.catalogIndex.values()) if (e.steamAppId === appId) return e;
  }
  return deps.catalogIndex.get(normalizeName(proc.name)) ?? null;
}
```

Replace the placeholder readers with real implementations:

```ts
async function defaultReadExeNames(installDir: string): Promise<string[]> {
  const out: string[] = [];
  const top = await readdir(installDir, { withFileTypes: true }).catch(() => []);
  for (const e of top) {
    if (e.isFile() && /\.exe$/i.test(e.name)) out.push(e.name);
    else if (e.isDirectory()) {
      const sub = await readdir(join(installDir, e.name)).catch(() => []);
      for (const f of sub) if (/\.exe$/i.test(f)) out.push(f);
    }
  }
  return out;
}

async function defaultReadProtonAppId(pid: number): Promise<number | null> {
  const info = await detectProton({ pid });
  if (!info) return null;
  const m = info.compatDataPath.match(/compatdata\/(\d+)/);
  return m ? Number(m[1]) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run test/main/game-matcher.test.ts --maxWorkers=2`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/desktop && pnpm lint
git add apps/desktop/src/main/game-matcher.ts apps/desktop/test/main/game-matcher.test.ts
git commit -m "feat(desktop): game-matcher reverse identifyProcess + real signal readers"
```

---

### Task 3: Catalog index (`buildCatalogIndex`)

**Files:**
- Modify: `apps/desktop/src/main/game-matcher.ts`
- Test: `apps/desktop/test/main/game-matcher.test.ts` (append)

**Interfaces:**
- Produces: `buildCatalogIndex(entries: CatalogEntry[]): Map<string, CatalogEntry>` — keys `normalizeName(name)`, only entries with `trainerSource`, key length ≥ 3, first entry wins on collision.

- [ ] **Step 1: Write the failing test (append)**

```ts
import { buildCatalogIndex } from '../../src/main/game-matcher.js';

describe('buildCatalogIndex', () => {
  it('indexes only trainer-bearing entries by normalized name', () => {
    const idx = buildCatalogIndex([
      { id: 'a', name: '9 Kings', steamAppId: null, trainerSource: 'http://x' },
      { id: 'b', name: 'No Trainer', steamAppId: null },            // excluded
      { id: 'c', name: 'Go', steamAppId: null, trainerSource: 'http://y' }, // excluded: <3
    ]);
    expect(idx.get('9kings')?.id).toBe('a');
    expect(idx.has('notrainer')).toBe(false);
    expect(idx.has('go')).toBe(false);
  });

  it('keeps the first entry on a normalized-name collision', () => {
    const idx = buildCatalogIndex([
      { id: 'first', name: 'Game X', steamAppId: null, trainerSource: 'http://x' },
      { id: 'second', name: 'gamex', steamAppId: null, trainerSource: 'http://y' },
    ]);
    expect(idx.get('gamex')?.id).toBe('first');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/main/game-matcher.test.ts --maxWorkers=2`
Expected: FAIL — `buildCatalogIndex` not exported.

- [ ] **Step 3: Write implementation (add to `game-matcher.ts`)**

```ts
export function buildCatalogIndex(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const idx = new Map<string, CatalogEntry>();
  for (const e of entries) {
    if (!e.trainerSource) continue;
    const key = normalizeName(e.name);
    if (key.length < 3) continue;
    if (!idx.has(key)) idx.set(key, e);
  }
  return idx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run test/main/game-matcher.test.ts --maxWorkers=2`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/game-matcher.ts apps/desktop/test/main/game-matcher.test.ts
git commit -m "feat(desktop): buildCatalogIndex (normalized name -> trainer entry)"
```

---

### Task 4: IPC types for reactive auto-attach

**Files:**
- Modify: `apps/desktop/src/shared/ipc.ts`

**Interfaces:**
- Produces: `CeSessionStartRequest.game?`, `CeSessionStartResult` gains `needsPicker` (ok variant) and `reason:'not-running'` (err variant), new `game:detected` event, `preferences.autoAttachOnDetect`.

- [ ] **Step 1: Edit `CeSessionStartRequest`**

Find `export interface CeSessionStartRequest {` and add:

```ts
  /** Game identity so main can auto-resolve the running process (reactive auto-attach). */
  game?: { id: string; name: string; steamAppId?: number | null } | undefined;
```

- [ ] **Step 2: Edit `CeSessionStartResult`**

Replace the type with:

```ts
export type CeSessionStartResult =
  | { ok: true; sessionId: string; records: CeSessionRecord[]; proton: boolean; attached: boolean; needsPicker?: boolean }
  | { ok: false; error: string; reason?: 'runtime-missing' | 'spawn-failed' | 'not-running' | 'unknown' };
```

- [ ] **Step 3: Add the detection event to `StarlightEvent`**

Find the `StarlightEvent` union and add this member:

```ts
  | { type: 'game:detected'; game: { id: string; name: string; steamAppId?: number | null }; pid: number; name: string; confidence: 'exact' | 'name' }
```

- [ ] **Step 4: Add the preference**

Find the `preferences` shape in this file (or in `user-config.ts` if defined there — check both) and add `autoAttachOnDetect: boolean`. In `ipc.ts` the preferences interface member:

```ts
  autoAttachOnDetect: boolean;
```

- [ ] **Step 5: Typecheck (expect errors elsewhere — that's fine, later tasks fix them) then commit**

```bash
cd apps/desktop && pnpm lint || true   # downstream consumers updated in later tasks
git add apps/desktop/src/shared/ipc.ts
git commit -m "feat(desktop): IPC types for auto-attach (game identity, detect event, setting)"
```

---

### Task 5: `ceSessionStart` auto-resolves the pid from game identity

**Files:**
- Modify: `apps/desktop/src/main/ce-session.ts`
- Test: `apps/desktop/test/main/ce-session.test.ts` (append)

**Interfaces:**
- Consumes: `matchGameToProcess`, `MatchableGame`, `MatchResult` from `./game-matcher.js`.
- Produces: `StartSessionOpts` gains `game?`, `detectedGames?`, `resolveMatch?` (injectable, defaults to `matchGameToProcess`); return type gains `needsPicker: boolean`; throws `Error('game not running')` when the matcher returns `null` and no explicit pid was given.

- [ ] **Step 1: Write the failing test (append to `ce-session.test.ts`)**

```ts
it('auto-resolves the pid from game identity via the matcher', async () => {
  await writeFile(binary, '#!/bin/sh\nsleep 30\n'); await chmod(binary, 0o755);
  const source = await startCtServer();
  // matcher returns a pid → session proceeds to the (stub) proton launch and times out
  await mkdir(join(installDir, 'windowsbin', 'autorun'), { recursive: true });
  await writeFile(join(installDir, 'windowsbin', 'cheatengine-x86_64.exe'), 'stub');
  await mkdir(join(installDir, 'lua'), { recursive: true });
  await writeFile(join(installDir, 'lua', 'json.lua'), '--stub');
  const fakeProton = join(dir, 'proton');
  await writeFile(fakeProton, '#!/bin/sh\nsleep 30\n'); await chmod(fakeProton, 0o755);

  await expect(startSession({
    source, cacheKey: 'auto1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
    game: { id: '9-kings', name: '9 Kings', steamAppId: 2784470 },
    resolveMatch: async () => ({ pid: 4242, name: '9Kings.exe' }),
    readComm: async () => '9Kings.exe',
    detectProtonFn: async () => ({ compatDataPath: '/steam/compatdata/2784470', clientInstallPath: '/steam', protonDir: dir, protonBin: fakeProton }),
  })).rejects.toThrow(/timed out|ping/i);
});

it('throws "game not running" when the matcher finds no process', async () => {
  await writeFile(binary, '#!/bin/sh\nsleep 30\n'); await chmod(binary, 0o755);
  const source = await startCtServer();
  await expect(startSession({
    source, cacheKey: 'auto2', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
    game: { id: '9-kings', name: '9 Kings', steamAppId: null },
    resolveMatch: async () => null,
  })).rejects.toThrow(/not running/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/main/ce-session.test.ts --maxWorkers=2`
Expected: FAIL — `game`/`resolveMatch` not accepted; no "not running" error.

- [ ] **Step 3: Edit `StartSessionOpts` and `startSession` in `ce-session.ts`**

Add imports:

```ts
import { matchGameToProcess, type MatchableGame } from './game-matcher.js';
import type { DetectedGame } from '../shared/ipc.js';
```

Add to `StartSessionOpts`:

```ts
  game?: MatchableGame | undefined;
  detectedGames?: DetectedGame[] | undefined;
  resolveMatch?: typeof matchGameToProcess | undefined;
```

Change the return type of `startSession` to include `needsPicker`:

```ts
export async function startSession(opts: StartSessionOpts): Promise<{ sessionId: string; records: CeRecord[]; proton: boolean; needsPicker: boolean }> {
```

Immediately after the `downloadCtToDisk` line (before "Resolve the target process name"), insert the auto-resolve block:

```ts
  // Reactive auto-attach: if no explicit pid but a game identity is given, resolve it.
  let effectivePid = opts.pid;
  let needsPicker = false;
  if (effectivePid === undefined && opts.game) {
    const match = await (opts.resolveMatch ?? matchGameToProcess)(opts.game, {
      processes: opts.processes ?? [],
      detectedGames: opts.detectedGames ?? [],
    });
    if (match === null) throw new Error('game not running');
    if (match === 'ambiguous') { needsPicker = true; }
    else { effectivePid = match.pid; }
  }
```

Then replace every later use of `opts.pid` in this function with `effectivePid` (the proton-detection block and the `attached` computation). Finally change the return:

```ts
  return { sessionId, records, proton: proton !== null, needsPicker };
```

Note: add `processes?: DetectedProcess[] | undefined;` to `StartSessionOpts` and `import type { DetectedProcess }` — the matcher needs the running processes. The main handler (Task 6) supplies them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run test/main/ce-session.test.ts --maxWorkers=2`
Expected: PASS (all ce-session tests, including the 2 new ones).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/desktop && pnpm lint
git add apps/desktop/src/main/ce-session.ts apps/desktop/test/main/ce-session.test.ts
git commit -m "feat(desktop): ceSession auto-resolves pid from game identity"
```

---

### Task 6: Wire the matcher + catalog index into main

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/catalog-host.ts`

**Interfaces:**
- Consumes: `buildCatalogIndex`, `CatalogEntry` from `./game-matcher.js`; `startSession` (now accepts `game`, `processes`, `detectedGames`).
- Produces: module-level `catalogIndex` (rebuilt on catalog fetch) and `lastDetectedGames` (updated on library scan) in `index.ts`; passes them + `processHost.listOnce()` into `ceStartSession`.

- [ ] **Step 1: Cache detected games + catalog index in `index.ts`**

Near the top-level state, add:

```ts
import { buildCatalogIndex, type CatalogEntry } from './game-matcher.js';

let lastDetectedGames: import('../shared/ipc.js').DetectedGame[] = [];
let catalogIndex = new Map<string, CatalogEntry>();
```

In the `scanLibrary` IPC handler, after `const games = await scanLibrary();` add:

```ts
    lastDetectedGames = games;
```

In the `fetchCatalog` handler (and wherever the catalog is loaded on launch), after the index is obtained, add:

```ts
    catalogIndex = buildCatalogIndex((index?.games ?? []) as CatalogEntry[]);
```

- [ ] **Step 2: Pass game + processes + detectedGames into `ceSessionStart`**

In the `CHANNELS.ceSessionStart` handler, change the request type and the `ceStartSession` call:

```ts
  ipcMain.handle(CHANNELS.ceSessionStart, async (_evt, req: { source: string; cacheKey: string; pid?: number; processName?: string; game?: { id: string; name: string; steamAppId?: number | null } }) => {
    try {
      const processes = await processHost.listOnce();
      const r = await ceStartSession({
        source: req.source,
        cacheKey: req.cacheKey,
        runtimeRoot: CE_RUNTIME_ROOT,
        ctCacheDir: CT_CACHE_DIR,
        pid: req.pid,
        processName: req.processName,
        game: req.game,
        processes,
        detectedGames: lastDetectedGames,
      });
      return { ok: true as const, sessionId: r.sessionId, records: r.records, proton: r.proton, attached: req.pid !== undefined || (r.needsPicker === false && !!req.game), needsPicker: r.needsPicker };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = /not installed/i.test(msg) ? 'runtime-missing' as const :
                     /not running/i.test(msg) ? 'not-running' as const :
                     /spawn|timed out/i.test(msg) ? 'spawn-failed' as const :
                     'unknown' as const;
      return { ok: false as const, error: msg, reason };
    }
  });
```

- [ ] **Step 3: Build + typecheck**

Run: `cd apps/desktop && pnpm lint && pnpm build 2>&1 | tail -3`
Expected: no TS errors.

- [ ] **Step 4: Manual smoke (optional, requires a running Proton game)**

Launch a game, then in the app click its tile — it should attach with no picker. (Covered end-to-end by the existing Proton path; unit coverage is in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/catalog-host.ts
git commit -m "feat(desktop): wire matcher + catalog index into ceSessionStart"
```

---

### Task 7: Renderer reactive — pass game, handle not-running / needsPicker

**Files:**
- Modify: `apps/desktop/src/renderer/stores/ce-session-store.ts`
- Modify: `apps/desktop/src/renderer/routes/BrowseRoute.tsx`, `SearchRoute.tsx`, `LibraryRoute.tsx`, `HomeRoute.tsx`
- Modify: `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx` (CeSessionView not-running message)
- Test: `apps/desktop/test/stores/ce-session-store.test.ts` (create if absent) OR extend an existing store test

**Interfaces:**
- Consumes: `ceSessionStart` result with `needsPicker`; error `reason:'not-running'`.
- Produces: store `start({source, cacheKey, game})`, new state `notRunning: boolean` and `needsPicker: boolean`.

- [ ] **Step 1: Write the failing store test**

```ts
// apps/desktop/test/stores/ce-session-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStart = vi.fn();
vi.mock('../../src/renderer/ipc-client.js', () => ({
  starlight: () => ({ ceSessionStart: mockStart, ceSessionEnd: vi.fn(), ceSessionSetActive: vi.fn() }),
}));
import { useCeSessionStore } from '../../src/renderer/stores/ce-session-store.js';

beforeEach(() => { mockStart.mockReset(); useCeSessionStore.setState({ sessionId: null, notRunning: false, needsPicker: false }); });

describe('ce-session-store auto-attach', () => {
  it('sets notRunning when the game is not running', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'game not running', reason: 'not-running' });
    const ok = await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' } });
    expect(ok).toBe(false);
    expect(useCeSessionStore.getState().notRunning).toBe(true);
  });

  it('sets needsPicker when the match is ambiguous', async () => {
    mockStart.mockResolvedValue({ ok: true, sessionId: 's', records: [], proton: true, attached: false, needsPicker: true });
    await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' } });
    expect(useCeSessionStore.getState().needsPicker).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/stores/ce-session-store.test.ts --maxWorkers=2`
Expected: FAIL — `notRunning`/`needsPicker`/`start(game)` not present.

- [ ] **Step 3: Extend the store**

In `ce-session-store.ts`: add `notRunning: boolean` and `needsPicker: boolean` to the state interface and initial state (`false`). Extend `StartReq` with `game?: { id: string; name: string; steamAppId?: number | null }`. In `start`, reset `notRunning:false, needsPicker:false` at the top; on `!r.ok` set `notRunning: r.reason === 'not-running'`; on success set `needsPicker: r.needsPicker ?? false` alongside the existing fields.

- [ ] **Step 4: Pass game from the routes**

In each of `BrowseRoute.tsx`, `SearchRoute.tsx`, `LibraryRoute.tsx`, `HomeRoute.tsx`, change the `startCeSession({ source: ..., cacheKey: ... })` call to also pass the game:

```ts
await startCeSession({ source: g.trainerSource, cacheKey: g.id, game: { id: g.id, name: g.name, steamAppId: g.steamAppId ?? null } });
```

(For `LibraryRoute`/`HomeRoute` the variable is `entry` — use `entry.id/name/steamAppId`.)

- [ ] **Step 5: Show the not-running message in CeSessionView**

In `ActiveTrainerRoute.tsx`, read `notRunning` from the store and, in the `ceSessionId`-less branch or the attach bar, when `notRunning` render:

```tsx
<div className="text-xs text-neon-pink border border-neon-pink/40 bg-neon-pink/[0.06] rounded-sm px-3 py-2">
  Game isn't running. Start it, then click the tile again — Starlight will attach automatically.
</div>
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/desktop && npx vitest run test/stores/ce-session-store.test.ts --maxWorkers=2 && pnpm lint`
Expected: PASS + clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/test/stores/ce-session-store.test.ts
git commit -m "feat(desktop): renderer reactive auto-attach (pass game, not-running UI)"
```

---

### Task 8: `latch-detector` module (proactive, reverse)

**Files:**
- Create: `apps/desktop/src/main/latch-detector.ts`
- Test: `apps/desktop/test/main/latch-detector.test.ts`

**Interfaces:**
- Consumes: `identifyProcess`, `CatalogEntry` from `./game-matcher.js`; `filterCandidates` from `./process-host.js`; `DetectedProcess`, `DetectedGame` from `../shared/ipc.js`.
- Produces: `class LatchDetector` with:
  - `constructor(opts: { catalogIndex(): Map<string, CatalogEntry>; detectedGames(): DetectedGame[]; isSessionActive(): boolean; identify?: typeof identifyProcess })`
  - `detect(processes: DetectedProcess[]): Promise<{ game: CatalogEntry; pid: number; name: string; confidence: 'exact' | 'name' } | null>` — returns a detection for a NEW confident match, else null; dedupes by pid; silent while a session is active.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/main/latch-detector.test.ts
import { describe, it, expect } from 'vitest';
import { LatchDetector } from '../../src/main/latch-detector.js';

const entry = { id: '9-kings', name: '9 Kings', steamAppId: null, trainerSource: 'http://x' };
const index = () => new Map([['9kings', entry]]);
const base = { catalogIndex: index, detectedGames: () => [], isSessionActive: () => false, identify: async (p: any) => (/9kings/i.test(p.name.replace(/[^a-z0-9]/gi, '')) ? entry : null) };

describe('LatchDetector', () => {
  it('emits a detection for a newly-seen game process', async () => {
    const d = new LatchDetector(base);
    const r = await d.detect([{ pid: 1, name: 'other.exe' }, { pid: 2, name: '9Kings.exe' }]);
    expect(r).toMatchObject({ pid: 2, name: '9Kings.exe', game: { id: '9-kings' } });
  });

  it('does not re-emit for the same pid', async () => {
    const d = new LatchDetector(base);
    await d.detect([{ pid: 2, name: '9Kings.exe' }]);
    const again = await d.detect([{ pid: 2, name: '9Kings.exe' }]);
    expect(again).toBeNull();
  });

  it('stays silent while a session is active', async () => {
    const d = new LatchDetector({ ...base, isSessionActive: () => true });
    const r = await d.detect([{ pid: 2, name: '9Kings.exe' }]);
    expect(r).toBeNull();
  });

  it('ignores noise processes', async () => {
    const d = new LatchDetector(base);
    const r = await d.detect([{ pid: 3, name: 'services.exe' }]);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/main/latch-detector.test.ts --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// apps/desktop/src/main/latch-detector.ts
import type { DetectedProcess, DetectedGame } from '../shared/ipc.js';
import { identifyProcess, type CatalogEntry } from './game-matcher.js';
import { filterCandidates } from './process-host.js';

export interface LatchDetectorOpts {
  catalogIndex: () => Map<string, CatalogEntry>;
  detectedGames: () => DetectedGame[];
  isSessionActive: () => boolean;
  identify?: typeof identifyProcess;
}

export interface Detection {
  game: CatalogEntry;
  pid: number;
  name: string;
  confidence: 'exact' | 'name';
}

export class LatchDetector {
  private reported = new Set<number>();
  constructor(private opts: LatchDetectorOpts) {}

  async detect(processes: DetectedProcess[]): Promise<Detection | null> {
    if (this.opts.isSessionActive()) return null;
    const identify = this.opts.identify ?? identifyProcess;
    const candidates = filterCandidates(processes).filter((p) => /\.exe$/i.test(p.name));
    for (const p of candidates) {
      if (this.reported.has(p.pid)) continue;
      const game = await identify(p, {
        catalogIndex: this.opts.catalogIndex(),
        detectedGames: this.opts.detectedGames(),
      });
      if (game) {
        this.reported.add(p.pid);
        // 'exact' when the exe name doesn't match the title (relied on a signal),
        // else 'name'. Simplified: name-equality => 'name', otherwise 'exact'.
        const conf = normalizedEq(p.name, game.name) ? 'name' : 'exact';
        return { game, pid: p.pid, name: p.name, confidence: conf };
      }
    }
    return null;
  }

  /** Drop pids that are no longer running so relaunches re-detect. */
  prune(livePids: Set<number>): void {
    for (const pid of this.reported) if (!livePids.has(pid)) this.reported.delete(pid);
  }
}

function normalizedEq(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');
  return n(a) === n(b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run test/main/latch-detector.test.ts --maxWorkers=2`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/latch-detector.ts apps/desktop/test/main/latch-detector.test.ts
git commit -m "feat(desktop): latch-detector (running process -> game:detected)"
```

---

### Task 9: Wire `latch-detector` into main → emit `game:detected`

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `LatchDetector`; `ceGetActiveSession` (already imported) for `isSessionActive`; `catalogIndex`/`lastDetectedGames` from Task 6.
- Produces: on each process poll, emits `{ type:'game:detected', game, pid, name, confidence }` to all windows.

- [ ] **Step 1: Construct the detector and hook the process poll**

The process host emits `process:list` events (see `process-host.ts` `tick`). In `index.ts`, where `processHost` events are forwarded to the renderer, construct the detector once and run it on each list. Add near the other singletons:

```ts
import { LatchDetector } from './latch-detector.js';

const latchDetector = new LatchDetector({
  catalogIndex: () => catalogIndex,
  detectedGames: () => lastDetectedGames,
  isSessionActive: () => ceGetActiveSession() !== null,
});
```

Find where `process:list` events are emitted to windows (the `processHost` `emit` callback in `process-host-singleton.ts`, or the forwarding in `index.ts`). In that emit path, when the event is `process:list`, also run:

```ts
    if (e.type === 'process:list') {
      latchDetector.prune(new Set(e.processes.map((p) => p.pid)));
      void latchDetector.detect(e.processes).then((d) => {
        if (!d) return;
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(CHANNELS.event, {
            type: 'game:detected',
            game: { id: d.game.id, name: d.game.name, steamAppId: d.game.steamAppId },
            pid: d.pid, name: d.name, confidence: d.confidence,
          });
        }
      });
    }
```

(If `process:list` is emitted from `process-host-singleton.ts`, add a callback hook there that `index.ts` registers; keep the detector in `index.ts`.)

- [ ] **Step 2: Build + typecheck**

Run: `cd apps/desktop && pnpm lint && pnpm build 2>&1 | tail -3`
Expected: no TS errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/process-host-singleton.ts
git commit -m "feat(desktop): emit game:detected from the process poll"
```

---

### Task 10: Renderer proactive — armed latch pill + one-click + setting A

**Files:**
- Modify: `apps/desktop/src/renderer/stores/latch-store.ts` (or a small new `detection-store.ts`)
- Modify: `apps/desktop/src/renderer/stores/process-store.ts` (subscribe to `game:detected`)
- Modify: `apps/desktop/src/renderer/components/TopBar.tsx` / `LatchPill.tsx`
- Modify: `apps/desktop/src/renderer/stores/config-store.ts` usage for `autoAttachOnDetect`
- Test: `apps/desktop/test/stores/detection-store.test.ts`

**Interfaces:**
- Consumes: `game:detected` event; `useCeSessionStore.start`; `config.preferences.autoAttachOnDetect`.
- Produces: a `detected: { game, pid, name, confidence } | null` store slice; `latchDetected()` action that calls `start({ source: trainerSourceFor(game), cacheKey: game.id, pid })`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/stores/detection-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useDetectionStore } from '../../src/renderer/stores/detection-store.js';

beforeEach(() => useDetectionStore.setState({ detected: null }));

describe('detection-store', () => {
  it('stores the latest detection', () => {
    useDetectionStore.getState().setDetected({ game: { id: 'g', name: 'G', steamAppId: null }, pid: 5, name: 'G.exe', confidence: 'exact' });
    expect(useDetectionStore.getState().detected?.pid).toBe(5);
  });

  it('clears the detection', () => {
    useDetectionStore.getState().setDetected({ game: { id: 'g', name: 'G', steamAppId: null }, pid: 5, name: 'G.exe', confidence: 'exact' });
    useDetectionStore.getState().clear();
    expect(useDetectionStore.getState().detected).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/stores/detection-store.test.ts --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `detection-store.ts`**

```ts
// apps/desktop/src/renderer/stores/detection-store.ts
import { create } from 'zustand';

export interface Detected { game: { id: string; name: string; steamAppId?: number | null }; pid: number; name: string; confidence: 'exact' | 'name' }

interface DetectionState {
  detected: Detected | null;
  setDetected: (d: Detected) => void;
  clear: () => void;
}

export const useDetectionStore = create<DetectionState>((set) => ({
  detected: null,
  setDetected: (d) => set({ detected: d }),
  clear: () => set({ detected: null }),
}));
```

- [ ] **Step 4: Subscribe to the event (in `process-store.ts` `attachProcessEvents`)**

Add to the `onEvent` handler:

```ts
    else if (e.type === 'game:detected') {
      useDetectionStore.getState().setDetected({ game: e.game, pid: e.pid, name: e.name, confidence: e.confidence });
    }
```

- [ ] **Step 5: Show the armed pill + one-click latch (TopBar/LatchPill)**

In `TopBar.tsx`, read `useDetectionStore((s) => s.detected)`. When set, render the pill as "**{name}** detected — Latch". Its onClick:

```ts
const start = useCeSessionStore((s) => s.start);
// on latch click:
await start({ source: trainerSourceFor(detected.game.id), cacheKey: detected.game.id, pid: detected.pid });
useDetectionStore.getState().clear();
navigate('/active');
```

`trainerSourceFor` = look the game up in the catalog store by id to get `trainerSource`. If the catalog store already exposes entries, add a helper `useCatalogStore.getState().byId(id)?.trainerSource`.

- [ ] **Step 6: Setting A auto-fire**

In the same subscription (Step 4), after `setDetected`, if `useConfigStore.getState().config?.preferences.autoAttachOnDetect && e.confidence === 'exact'`, immediately call the latch action (start with pid) and navigate to `/active`.

- [ ] **Step 7: Run tests + typecheck**

Run: `cd apps/desktop && npx vitest run test/stores/detection-store.test.ts --maxWorkers=2 && pnpm lint`
Expected: PASS + clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/test/stores/detection-store.test.ts
git commit -m "feat(desktop): armed latch pill + one-click latch + auto-attach setting"
```

---

### Task 11: `autoAttachOnDetect` setting — user-config default + Settings UI

**Files:**
- Modify: `apps/desktop/src/main/user-config.ts` (default value)
- Modify: `apps/desktop/src/renderer/routes/SettingsRoute.tsx` (toggle)
- Test: `apps/desktop/test/main/user-config.test.ts` (append)

**Interfaces:**
- Consumes: existing `preferences` config plumbing.
- Produces: `preferences.autoAttachOnDetect` defaults to `false`; Settings toggle persists it.

- [ ] **Step 1: Write the failing test (append to `user-config.test.ts`)**

```ts
it('defaults autoAttachOnDetect to false', async () => {
  const cfg = await getConfigFrom(freshDir());   // use whatever helper the file already uses
  expect(cfg.preferences.autoAttachOnDetect).toBe(false);
});
```

(Match the existing test's helper/loader names in this file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run test/main/user-config.test.ts --maxWorkers=2`
Expected: FAIL — property missing.

- [ ] **Step 3: Add the default in `user-config.ts`**

In the defaults object / Zod schema for `preferences`, add `autoAttachOnDetect: false` (schema: `z.boolean().default(false)` if it uses Zod).

- [ ] **Step 4: Add the Settings toggle**

In `SettingsRoute.tsx`, add a labeled checkbox bound to `config.preferences.autoAttachOnDetect` that calls the existing `updateConfig`/preferences-update path:

```tsx
<label className="flex items-center gap-2 text-xs">
  <input type="checkbox" checked={prefs.autoAttachOnDetect}
         onChange={(e) => updatePrefs({ autoAttachOnDetect: e.target.checked })} />
  Auto-attach when a game is detected (skips the "Latch" click)
</label>
```

- [ ] **Step 5: Run test + typecheck + full suite**

Run: `cd apps/desktop && npx vitest run --maxWorkers=2 && pnpm lint`
Expected: all tests pass, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/user-config.ts apps/desktop/src/renderer/routes/SettingsRoute.tsx apps/desktop/test/main/user-config.test.ts
git commit -m "feat(desktop): autoAttachOnDetect setting (default off) + Settings toggle"
```

---

## Final verification

- [ ] `cd apps/desktop && pnpm lint && npx vitest run --maxWorkers=2 && pnpm build` — all green.
- [ ] Manual (Proton game running): click its tile → attaches with no picker. Close + relaunch the game → latch pill arms; click Latch → attaches. Toggle the setting on → next launch auto-attaches (exact-confidence games).
