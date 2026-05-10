# Phase 5 — Catalog, User Config, Indexer, Product Page Design

**Status:** Design (pre-plan)
**Predecessor:** Phase 4.5 (auto-detection + value-cheat hotkeys) — committed.
**Successors:** Phase 6 (cross-platform polish, packaging, code signing).

## 1. Goals

Replace the hand-coded placeholder catalog with a real community-driven trainer index, persist user-specific configuration to disk, automate trainer ingestion from fearlessrevolution, and ship a marketing/product page alongside the catalog.

The Phase 5 spec covers eight sub-deliverables that will be implemented as separate, sequenced plans. One spec, multiple plans.

| Sub-phase | Scope summary |
|-----------|---------------|
| 5.0 | Catalog format + bootstrap; in-app catalog client; Browse/Search/Library wired to real data; GH Pages publish workflow; placeholder Astro site. |
| 5.1 | User config core: `processName` overrides (A), recents (C), preferences (E). Settings route. |
| 5.2 | Manual library entries (B). |
| 5.3 | Hotkey rebinding (D). |
| 5.4 | Periodic indexer (`packages/indexer/`). |
| 5.5 | SteamGridDB boxart fallback. |
| 5.6 | Epic / Heroic / Lutris scanners (replace 4.5 stubs). |
| 5.7 | Astro product page real content. |

## 2. Non-Goals

- App packaging / code signing — Phase 6.
- Wayland `globalShortcut` workarounds — Phase 6.
- Light theme — out of scope; preference enum reserved for `'dark'` only in 5.1.
- Localization — out of scope.
- User-supplied SteamGridDB API key UI — env-var only in 5.5; user-config field deferred.
- Live indexer integration test in CI — manual smoke only.

## 3. Repo Layout (additions)

```
starlight/
├── apps/
│   ├── desktop/                         (existing)
│   └── site/                            (NEW — Phase 5.0 placeholder, 5.7 real content)
├── packages/
│   ├── ct-importer/                     (existing)
│   ├── engine/                          (existing)
│   ├── catalog/                         (NEW — Phase 5.0)
│   │   ├── package.json
│   │   ├── index.json
│   │   ├── trainers/<id>.json
│   │   ├── src/schema.ts                (Zod definitions)
│   │   └── README.md
│   └── indexer/                         (NEW — Phase 5.4)
│       ├── package.json
│       ├── seeds.yaml
│       └── src/
└── .github/workflows/
    ├── publish-pages.yml                (NEW — Phase 5.0)
    └── indexer.yml                      (NEW — Phase 5.4)
```

`packages/catalog/`'s `package.json` exports the JSON files directly (`"main": "./index.json"` plus a typed `schema.ts` re-export) so the desktop app's tests can use a local fixture without HTTP, and the indexer can read existing entries to dedupe. The published GitHub Pages URL is what production users hit.

## 4. Catalog Schema

### 4.1 `packages/catalog/index.json`

Root index, fetched on app launch.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-09T12:00:00Z",
  "games": [
    {
      "id": "elden-ring",
      "name": "Elden Ring",
      "steamAppId": 1245620,
      "processName": ["eldenring.exe"],
      "platform": ["windows"],
      "tags": ["souls", "rpg"],
      "trainerPath": "trainers/elden-ring.json",
      "trainerUpdatedAt": "2026-05-08T...",
      "trainerSource": "https://fearlessrevolution.com/..."
    }
  ]
}
```

`steamAppId` is `null` for non-Steam-only games. `tags`, `trainerSource`, and `trainerUpdatedAt` are optional in the Zod schema (treated as missing if absent), but the indexer always populates them.

### 4.2 `packages/catalog/trainers/<id>.json`

Full `StarlightTrainer` produced by `@starlight/ct-importer`. Fetched lazily on first use.

### 4.3 ID conventions

`id` is the kebab-case slug derived from the game's display name on first ingest (e.g., `"Elden Ring"` → `"elden-ring"`). Once assigned, never changes. Disambiguate collisions with a `-<year>` suffix (`"need-for-speed-2015"`). `trainerPath` is always `trainers/<id>.json`, lowercase, matching `id`.

### 4.4 Hand-seeded v1 contents

Five entries: Elden Ring, Cyberpunk 2077, Hades II, Stardew Valley, Hollow Knight. Mirrors the existing placeholder catalog so swapping the in-app data source is mechanical.

### 4.5 Validation

`packages/catalog/src/schema.ts` defines a Zod `CatalogIndex` schema mirroring the JSON shape, re-exported from the package root. The desktop app's `catalog-client` validates fetched JSON; malformed entries are dropped with a console warning (graceful degradation). The indexer (5.4) validates its output against the schema before writing.

## 5. Phase 5.0 — Catalog Client

### 5.1 Main process

New `apps/desktop/src/main/catalog-host.ts`:

```ts
const CATALOG_URL = 'https://darkharasho.github.io/starlight/catalog/index.json';
const CACHE_PATH  = join(app.getPath('userData'), 'catalog-cache', 'index.json');
const META_PATH   = join(app.getPath('userData'), 'catalog-cache', 'meta.json');

export async function fetchCatalog(): Promise<CatalogIndex> { /* ETag flow */ }
export async function fetchTrainer(trainerPath: string): Promise<StarlightTrainer> { /* per-trainer cache */ }
```

Flow:
1. Read cached meta + body if any.
2. Issue GET with `If-None-Match: <etag>` if known.
3. On 304 → return cached body.
4. On 200 → validate via Zod, write body + meta atomically, return.
5. On network failure → return cached body if present, else throw.

Per-trainer cache is keyed by `id`; invalidated when `index.json` reports a newer `trainerUpdatedAt` than the cached file.

### 5.2 IPC (extends `shared/ipc.ts`)

```ts
fetchCatalog():    Promise<CatalogResult>;
fetchTrainer(req: { trainerPath: string }): Promise<TrainerResult>;
// Event:
| { type: 'catalog:loaded'; index: CatalogIndex }
```

### 5.3 Renderer

New `apps/desktop/src/renderer/stores/catalog-store.ts`:

```ts
interface CatalogState {
  index: CatalogIndex | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  trainer(trainerPath: string): Promise<StarlightTrainer | null>;   // memoized
}
```

### 5.4 Wiring changes

- App root mounts → `useCatalogStore.getState().load()`. If load fails and there is no cache, Browse/Search show a "Catalog unavailable" empty-state with a Retry button.
- **`BrowseRoute.tsx`** and **`SearchRoute.tsx`** — replace `import { CATALOG } from '../data/catalog.js'` with `useCatalogStore((s) => s.index?.games ?? [])`. Delete `apps/desktop/src/renderer/data/catalog.ts`.
- **`LibraryRoute.tsx`** — read `useCatalogStore` to compute `hasTrainer` per detected game (`catalog.games.some(g => g.steamAppId === detectedGame.appId)`). Wires the badge that has been a placeholder since Phase 4.5.
- **Latch flow:** when a user clicks Latch on a catalog entry, the route calls `await useCatalogStore.getState().trainer(entry.trainerPath)`, then a new `setActiveTrainerFromCatalog(trainer)` helper in `trainer-loader.ts` activates it (skipping the `.CT` import step).

### 5.5 Cache lifecycle

ETag-based revalidation on every launch. No background polling. Manual "Refresh" button on Browse calls `useCatalogStore.getState().load()` again. Cache directory cleared on app uninstall (Electron defaults).

### 5.6 Tests

- `catalog-host.test.ts` — fixture HTTP server (`createServer` from `node:http`), assert ETag flow on 200/304 and offline fallback.
- `catalog-store.test.ts` — fake IPC, assert load/error/refresh.
- Browse/Search route tests updated to inject a fake catalog index.

## 6. Phase 5.1 — User Config Core

### 6.1 Storage

`<userData>/config.json`. Single JSON file, atomic write (write to `.tmp`, fsync, rename), Zod-validated on load. Missing file → defaults; corrupt file → backup as `.corrupt-<timestamp>` and load defaults (with a one-time renderer toast surfaced via event).

### 6.2 Schema (`apps/desktop/src/main/user-config.ts`)

```ts
const UserConfigSchema = z.object({
  schemaVersion: z.literal(1),
  // 5.1 — A: processName overrides per game (catalog id, falls back to trainer.id when ad-hoc)
  processNameOverrides: z.record(z.string(), z.array(z.string())).default({}),
  // 5.1 — C: recently-used trainers (capped at 20)
  recents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    openedAt: z.string(),
    source: z.enum(['catalog', 'file']),
  })).max(20).default([]),
  // 5.1 — E: app preferences
  preferences: z.object({
    theme: z.enum(['dark']).default('dark'),
    pollIntervalMs: z.number().int().min(500).max(30000).default(2000),
    catalogRefreshOnLaunch: z.boolean().default(true),
  }).default({}),
  // 5.2 — B: manual library entries (slot reserved)
  manualGames: z.array(z.object({
    id: z.string(),
    name: z.string(),
    exePath: z.string(),
    addedAt: z.string(),
  })).default([]),
  // 5.3 — D: hotkey overrides per cheat (slot reserved)
  hotkeyOverrides: z.record(
    z.string(),
    z.record(z.string(), z.object({
      toggle: z.string().nullable().optional(),
      inc: z.string().nullable().optional(),
      dec: z.string().nullable().optional(),
    }))
  ).default({}),
});
type UserConfig = z.infer<typeof UserConfigSchema>;
```

Reserving 5.2 and 5.3 slots in v1 avoids a `schemaVersion` bump for items already in scope.

### 6.3 Main-process `config-host`

```ts
let cached: UserConfig | null = null;
export async function getConfig(): Promise<UserConfig> { /* read + validate, in-memory cache */ }
export async function updateConfig(patch: DeepPartial<UserConfig>): Promise<UserConfig> {
  // deep-merge, validate, atomic write, broadcast 'config:changed'
}
```

### 6.4 IPC

```ts
getConfig():    Promise<UserConfig>;
updateConfig(req: { patch: DeepPartial<UserConfig> }): Promise<UserConfig>;
// Event:
| { type: 'config:changed'; config: UserConfig }
```

### 6.5 Renderer store + consumers

`config-store.ts` exposes `config: UserConfig | null`, `load()`, `update(patch)`. Subscribes to `config:changed` events on mount. Consumers read via tailored selectors (`useConfigStore(s => s.config?.recents ?? [])`).

### 6.6 Wiring changes

- **`trainer-loader.ts`** — on successful load, push to `recents[]` via `updateConfig({ recents: [<new>, ...prev].slice(0,20) })`.
- **`HomeRoute.tsx`** — read `recents`, render as a "Recently Played" panel.
- **ActiveTrainerRoute Trainer Info disclosure** — `setProcessName` action also writes to `processNameOverrides[trainer.id]`.
- **Engine pollInterval** — engine's freeze loop reads `preferences.pollIntervalMs` from the config (passed via setup, not a direct config import — keep main modules independent).
- **New `SettingsRoute.tsx`** — small route accessible from sidebar, renders preferences (poll interval, catalog refresh on launch) behind a settings cog in the existing window chrome.

### 6.7 Override resolution

When loading a trainer from catalog, after applying the trainer JSON, overlay `processNameOverrides[trainer.id]` onto `trainer.game.processName` if present. Same pattern for hotkey overrides in 5.3.

### 6.8 Tests

- `user-config.test.ts` — atomic write semantics, corrupt-file recovery, defaults for missing fields, schema migration smoke (v1 stays v1; bump test deferred).
- `config-store.test.ts` — fake IPC, assert `update()` flow + event subscription updates store.

## 7. Phase 5.2 — Manual Library Entries

### 7.1 Storage

`config.manualGames[]` (already reserved in §6). Each entry: `{ id, name, exePath, addedAt }`. The `id` is generated as `manual-<slug-of-name>-<short-hash-of-exePath>` so the same exe re-added doesn't duplicate.

### 7.2 Main

`library-host.ts` gains a `ManualScanner` reading `config.manualGames` and yielding `DetectedGame`s with `source: 'manual'`. Source union widens to `'steam' | 'manual'` (Phase 5.6 widens further). Registered alongside `SteamScanner` in `defaultScanners`. Boxart for manual entries: best-effort match against catalog by exe basename → use catalog's `steamAppId` for the boxart URL; otherwise neutral placeholder until 5.5 lands SteamGridDB fallback.

### 7.3 Renderer

Library route gains an "Add manually" button → opens `dialog.showOpenDialog` filtered to executables → user enters a display name → `updateConfig({ manualGames: [...prev, newEntry] })` → `library-store.scan()` re-runs → tile appears.

Removal: each manual tile gets a tiny `×` on hover → confirms → updates `manualGames` and re-scans.

### 7.4 Tests

`library-host.test.ts` extension — `ManualScanner` reads from a fake config and yields entries.

## 8. Phase 5.3 — Hotkey Rebinding

### 8.1 Storage

`config.hotkeyOverrides` (already reserved): `{ [trainerId]: { [cheatId]: { toggle?, inc?, dec? } } }`. A value of `null` means "explicitly cleared" (no hotkey). A missing slot means "use the trainer's default."

### 8.2 Override application

`hotkey-host.ts:registerForTrainer(trainer)` adds a second arg: `registerForTrainer(trainer, overrides)`. For each cheat, the resolved hotkey set is `{ ...trainer.cheat.hotkeys, ...overrides[trainer.id]?.[cheat.id] }` with `null` values stripped.

`trainer-loader.ts` reads `config.hotkeyOverrides[trainer.id]` after `setActiveTrainer()` and passes it through.

When the user changes an override, the renderer calls IPC `rebindHotkey(trainerId, cheatId, slot, accelerator | null)` → `config-host` updates → main re-runs `registerForTrainer(currentTrainer, newOverrides)` which `unregisterAll()`s and re-registers.

### 8.3 UI

Each cheat card grows an "edit hotkey" affordance (pencil icon next to the existing hotkey badge):

- Click → opens an inline `<HotkeyCapture>` widget that listens for the next keypress + modifiers, normalizes to an Electron accelerator string, validates it (re-using the importer's accelerator parser), shows green check or red error.
- "Reset" button reverts to `null` (clear) or removes the override (revert to default).
- Conflict detection: when capturing, check if the accelerator is already bound to another cheat in the current trainer; refuse and show the conflict.

`HotkeyCapture.tsx` owns the capture state machine. The toggle/inc/dec slots each get their own capture instance.

### 8.4 Tests

- `hotkey-host.test.ts` extension — overrides applied: trainer has `toggle: 'F4'` and config overrides to `'F5'`, only `F5` registers.
- `HotkeyCapture.test.tsx` — keyboard-event-driven, asserts accelerator normalization and invalid-input rejection.

## 9. Phase 5.4 — Indexer

### 9.1 Layout

```
packages/indexer/
├── package.json
├── seeds.yaml
└── src/
    ├── index.ts          (CLI entry)
    ├── seeds.ts          (parses seeds.yaml)
    ├── fetch.ts          (downloads .CT, returns Buffer + URL)
    ├── slug.ts           (kebab-case + dedupe)
    └── write.ts          (atomic JSON write into ../catalog/...)
```

### 9.2 `seeds.yaml`

```yaml
games:
  - url: https://fearlessrevolution.com/elden-ring-trainer-...
    name: Elden Ring
    steamAppId: 1245620
    processName: [eldenring.exe]
    platform: [windows]
    tags: [souls, rpg]
```

The seed file carries everything `index.json` needs except the trainer payload. The indexer downloads each `url`, runs the bytes through `@starlight/ct-importer` with `{ gameName, processName, platform }` from the seed, writes `packages/catalog/trainers/<id>.json`, then regenerates `packages/catalog/index.json` from all seeds + their write timestamps.

### 9.3 Idempotency

Running the indexer multiple times yields the same output if the seed file and source URLs haven't changed. Per-trainer `trainerUpdatedAt` reflects the last time the source's content actually changed (compared via SHA-256 of the downloaded bytes against a `.indexer-cache.json` keyed by URL).

### 9.4 Workflow (`.github/workflows/indexer.yml`)

- Cron: weekly + `workflow_dispatch`.
- Runs `pnpm --filter @starlight/indexer build && node packages/indexer/dist/index.js`.
- If `packages/catalog/` differs after the run, opens a PR titled `chore(catalog): weekly indexer run YYYY-MM-DD`. PR description lists added / updated / unchanged trainers.

### 9.5 Robustness

A URL that fails (404, parse error, bad XML) is logged and skipped; one bad seed doesn't fail the whole run.

### 9.6 Tests

- `slug.test.ts` — collision handling, year-suffix disambiguation.
- `fetch.test.ts` — fixture HTTP server, asserts download + caching.
- `write.test.ts` — atomic write, regenerate `index.json` from a tmp `trainers/`.
- No live indexer integration test in CI.

## 10. Phase 5.5 — SteamGridDB Boxart Fallback

### 10.1 Strategy

New module `apps/desktop/src/main/boxart-host.ts` — given `{ name, steamAppId? }`, resolves to a boxart URL: prefers Steam CDN if `steamAppId` is set, falls back to SteamGridDB lookup by name otherwise.

Requires an API key; v1 reads `STEAMGRIDDB_API_KEY` env var at startup. If unset, fallback is skipped (boxart shows the existing neutral placeholder). User-supplied API key UI deferred.

Cache resolved URLs in `<userData>/boxart-cache.json` keyed by `name+steamAppId`.

### 10.2 IPC

```ts
resolveBoxart(req: { name: string; steamAppId?: number }): Promise<{ url: string | null }>;
```

### 10.3 UI

`GameTile`'s `<img>` already has `onError`. Extend: on error, fire `resolveBoxart()` and swap `src` if a fallback returns. Library tiles for manual entries call `resolveBoxart` proactively on first render.

### 10.4 Tests

Mock `fetch`, assert Steam-first behavior, fallback path, cache hit on second call.

## 11. Phase 5.6 — Epic / Heroic / Lutris Scanners

Replace Phase 4.5 stubs in `library-host.ts`:

- **`EpicScanner`** — Win/Mac. Reads `~/AppData/Local/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini` and `~/Library/Application Support/Epic/EpicGamesLauncher/...` for the manifests directory; iterates `Manifests/*.item` JSON; extracts `DisplayName`, `InstallLocation`, `LaunchExecutable`. `source: 'epic'`.
- **`HeroicScanner`** — Linux. Reads `~/.config/heroic/store_cache/library.json` (Epic via Heroic) and `~/.config/heroic/gog_store/library.json` (GOG via Heroic). `source: 'heroic'`.
- **`LutrisScanner`** — Linux. Opens `~/.local/share/lutris/games/lutris.db` (SQLite) read-only via `better-sqlite3`. Selects `id, name, directory, runner` from `games`. `source: 'lutris'`.

Source union widens to `'steam' | 'epic' | 'heroic' | 'lutris' | 'manual'`.

### 11.1 Native dep

`better-sqlite3` for Lutris is a new dep on `apps/desktop`. Native module — must be marked external in electron-vite (mirror the existing `frida-node` config).

### 11.2 Tests

Fixture-driven, identical pattern to `SteamScanner` — committed sample manifest/JSON/SQLite files under `apps/desktop/test/fixtures/{epic,heroic,lutris}/`, scanner pointed at the fixture root.

## 12. Phase 5.0 + 5.7 — Publish Workflow + Product Page

### 12.1 Publish workflow (lands with 5.0)

`.github/workflows/publish-pages.yml`:

```yaml
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @starlight/site build
      - name: Compose deploy directory
        run: |
          mkdir -p _deploy
          cp -r apps/site/dist/. _deploy/
          mkdir -p _deploy/catalog
          cp -r packages/catalog/index.json _deploy/catalog/
          cp -r packages/catalog/trainers _deploy/catalog/
      - uses: actions/upload-pages-artifact@v3
        with: { path: _deploy }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Result tree:

```
darkharasho.github.io/starlight/                    → product page index.html
darkharasho.github.io/starlight/catalog/index.json  → catalog index
darkharasho.github.io/starlight/catalog/trainers/*  → per-trainer files
```

In Phase 5.0, `apps/site/` exists as a minimal Astro project shipping a placeholder "Starlight — coming soon" page so the workflow's build step passes.

### 12.2 Phase 5.7 — Astro product page real content

```
apps/site/
├── astro.config.mjs              (output: 'static', site: 'https://darkharasho.github.io', base: '/starlight')
├── package.json                  (deps: astro, @astrojs/tailwind)
├── public/
│   └── favicon.svg
└── src/
    ├── layouts/Base.astro
    ├── pages/
    │   ├── index.astro
    │   ├── changelog.astro
    │   └── 404.astro
    ├── components/
    │   ├── Hero.astro
    │   ├── FeatureCard.astro
    │   └── Screenshot.astro
    └── styles/global.css
```

Content for v1:
- Hero: Starlight logo + tagline + Download button (links to GitHub Releases — placeholder until Phase 6 packaging).
- Features: three cards — "Real Steam library", "Global hotkey trainers", "Open-source community catalog".
- Screenshots: three PNGs from the desktop app (Library tab, Active Trainer, Settings).
- Footer: GitHub link, license, link to `/catalog/index.json`.

Theming: copy the Tailwind config from `apps/desktop/tailwind.config.js` so the marketing site visually matches the app.

### 12.3 Tests

Astro's build is the contract — if it builds, links resolve and pages render. CI runs `pnpm --filter @starlight/site build` and asserts `dist/index.html` exists.

## 13. Risks

- **fearlessrevolution availability.** The indexer depends on the site being reachable. Hand-curated seed list means a single failed URL is logged and skipped; a multi-day outage delays catalog updates but does not break already-shipped users (cached catalog is served).
- **VDF / `.CT` schema drift.** Cheat Engine could change its file format; the `ct-importer` would need updates. Mitigation: existing fixture-based tests catch regressions.
- **GitHub Pages quota.** Free tier limits soft-cap at 100 GB/month bandwidth, 10 builds/hour. The catalog is small (KB per file), the workflow runs on push not on every cron tick. Indexer cron is weekly. Well under quota.
- **SteamGridDB rate limits.** Free tier API allows ~25 req/s. Boxart-cache file should keep launch queries near zero after the first hit.
- **`better-sqlite3` packaging on Linux.** Native module — `electron-builder` must be configured to rebuild for the target Electron version. Mirror the existing `frida-node` rebuild step.
- **User config file growth.** With 20 recents, ~10 manual games, ~50 hotkey overrides, the file stays under 50 KB. Atomic write is fast.
- **Catalog fetch on launch latency.** ETag-based revalidation is cheap; cache fallback ensures cold-start UX is never blocked. Browse/Search degrade gracefully to "Catalog unavailable" state if both network and cache are missing.

## 14. Spec Coverage

| Goal | Section |
|------|---------|
| Real catalog replaces placeholder | §4, §5 |
| `hasTrainer` badge on Library | §5.4 |
| Browse + Search backed by real data | §5.4 |
| `processName` overrides persist | §6 |
| Recents on Home | §6.6 |
| App preferences | §6.6 |
| Settings route | §6.6 |
| Manual library entries | §7 |
| Hotkey rebinding | §8 |
| Periodic indexer | §9 |
| SteamGridDB boxart fallback | §10 |
| Epic / Heroic / Lutris scanners | §11 |
| Publish workflow + product page | §12 |

No placeholders. No TBDs. No internal contradictions.
