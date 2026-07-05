# Auto-Attach — Design Spec

**Status:** Approved design
**Date:** 2026-07-05

Replace the unusable "pick from a list of every running process" attach step with
automatic game↔process matching, in two flows: **reactive** (you open a game in
Starlight and it attaches to the running process) and **proactive** (the app
notices a known game launch and arms/latches it).

---

## 1. Problem

Today, starting a Cheat Engine session lands the user in a manual attach picker.
Even after filtering to `.exe` candidates, choosing the right process is friction,
and the proactive "latch pill" never fires because it relies on catalog
`processName`, which is empty for essentially every entry.

The catalog (trainer index) can't help directly: its `steamAppId` and
`processName` are mostly `null`/empty. The link between a catalog game and a
running process must be **derived at runtime** from signals we can actually read.

## 2. Goals & Non-Goals

### Goals
- **Reactive auto-attach:** clicking a game whose process is running attaches with
  no picker.
- **Proactive detect:** the latch pill lights up with the right process
  pre-resolved when a known, trainer-bearing game launches.
- **Configurable aggressiveness:** default is "arm, one action to fire" (B); an
  opt-in setting makes proactive detect fully automatic (A).
- **Never worse than today:** any ambiguous/unmatched case falls back to the
  existing filtered `.exe` picker.

### Non-Goals (v1)
- Enriching the catalog with Steam appids (indexer change).
- Fuzzy / edit-distance name matching (exact normalized-name only).
- Multi-session, or cycling through several simultaneously-detected games.

## 3. Architecture

One new main-process module, `apps/desktop/src/main/game-matcher.ts`, plus wiring
into two existing flows. Matching lives in main because that is where the three
inputs already exist and where `fs`/`/proc` access is available:

- running processes — `process-host`
- Steam library — `library-host` → `DetectedGame { appId, name, installDir, source }`
- trainer catalog — `catalog-host` (fetched + cached on launch)

```
game-matcher.ts  (pure logic + injectable signal readers)
   ├─ normalizeName(s)          "9 Kings" / "9Kings.exe" → "9kings"
   ├─ matchGameToProcess(...)   forward: game → {pid,name} | null | 'ambiguous'
   └─ identifyProcess(...)      reverse: running proc → catalog game (w/ trainer) | null
        ▲                            ▲
   reactive (on-open)          proactive (latch)
   ceSessionStart handler      latch-detector (consumes process poll) → 'game:detected'
```

`process-host` stays as-is (a clean poller). Proactive detection is a separate
`latch-detector` module that consumes the process list and calls the matcher, so
the matcher, the poller, and the detector each stay independently testable.

## 4. The Matcher

`normalizeName(s)` = lowercase, keep `[a-z0-9]` only, drop everything else
(spaces, punctuation, and a trailing `.exe`). `"9 Kings"` and `"9Kings.exe"` both
→ `"9kings"`.

### 4.1 Forward — `matchGameToProcess`

```ts
matchGameToProcess({
  game: { id: string; name: string; steamAppId: number | null },
  processes: DetectedProcess[],          // pid + name, already noise-filtered elsewhere
  detectedGames: DetectedGame[],         // Steam library (appId, name, installDir)
  readExeNames: (installDir: string) => Promise<string[]>,   // injectable
  readProtonAppId: (pid: number) => Promise<number | null>,  // injectable
}): Promise<{ pid: number; name: string } | null | 'ambiguous'>
```

Cascade, most-precise first; the first layer that yields exactly one process wins:

1. **Install-dir exe.** Link `game` to an installed `DetectedGame` — by
   `steamAppId` when set, else by `normalizeName`. Read `.exe` basenames from that
   `installDir` (top level + one subdirectory deep) and match a process by exact
   (case-insensitive) exe name. Exact even when the exe name isn't the title.
2. **Proton appid.** If `game.steamAppId` is known, match the process whose
   `readProtonAppId(pid)` equals it.
3. **Normalized name.** Match a process whose `normalizeName(name)` equals
   `normalizeName(game.name)`. Requires normalized length ≥ 3 to avoid
   false positives on very short titles.

Return the single match, `null` (none running), or `'ambiguous'` (the winning
layer produced more than one distinct pid).

### 4.2 Reverse — `identifyProcess`

```ts
identifyProcess({
  proc: DetectedProcess,
  catalogIndex: Map<string, CatalogEntry>,   // normalizedName → entry (trainer-bearing only)
  detectedGames: DetectedGame[],
  readProtonAppId: (pid: number) => Promise<number | null>,
}): Promise<CatalogEntry | null>
```

Given a running `.exe` process, resolve it to a catalog game **that has a
trainer**:

- **appid path:** `readProtonAppId(proc.pid)` → find the `DetectedGame` with that
  appId → look up its normalized name in `catalogIndex`.
- **name path:** `normalizeName(proc.name)` → `catalogIndex`.

Return the entry, or `null`. Conservative by construction: `catalogIndex` only
contains entries with a `trainerSource`, and callers pass only non-noise `.exe`
processes.

### 4.3 Catalog index

`catalogIndex: Map<normalizedName, CatalogEntry>` is built once when the catalog
loads and rebuilt on refresh. ~7,700 entries; building the map is trivial. On a
normalized-name collision, first entry wins (documented, acceptable for v1).

## 5. Reactive Flow (on-open)

`onSelect(game)` in Browse/Search/Library/Home currently calls
`startCeSession({ source, cacheKey })`. Change it to also pass game identity:

```ts
ceSessionStart({ source, cacheKey, game: { id, name, steamAppId } })
```

In the `ceSessionStart` main handler, when no explicit `pid` is supplied:

- Run `matchGameToProcess`.
- **Single match** → attach via the existing Windows-CE-in-prefix path. Returns
  `{ ok:true, records, attached:true, proton }`.
- **Not running** (`null`) → `{ ok:false, reason:'not-running' }`. UI: "Start
  **&lt;game&gt;**, then it attaches automatically" — not an empty picker.
- **Ambiguous** → start the session for record listing and return
  `{ ok:true, records, attached:false, needsPicker:true }`; the renderer shows the
  existing attach bar, pre-highlighting the best-guess process.

The manual picker (`CeSessionView` attach bar) remains, used only for the
ambiguous/unusual case.

## 6. Proactive Flow (latch) + Setting

A new `latch-detector` module subscribes to `process-host`'s existing ~2s poll
(`process:list`). Each tick it runs `identifyProcess` over the running,
noise-filtered `.exe` processes; on a **new** confident match, it emits:

```ts
{ type: 'game:detected', game: {...}, pid, name, confidence: 'exact' | 'name' }
```

Guards: don't re-fire for a pid already reported; don't fire while a CE session is
active. `confidence` is `'exact'` for install-dir/appid matches, `'name'` for
normalized-name matches.

Renderer on `game:detected`:

- **Default (B):** latch pill shows "**&lt;game&gt;** detected — Latch" with the pid
  pre-resolved. Latch (click or hotkey) starts the session and attaches instantly
  — no picker, no re-scan.
- **Setting A** (`preferences.autoAttachOnDetect`, default `false`; added to
  user-config and the Settings route): auto-starts the session on detect. To avoid
  surprises, A auto-fires only on `confidence === 'exact'`; `'name'`-only matches
  still merely arm the pill.

## 7. Error & Edge Handling

- **Game not running** (on-open) → actionable "start the game" message.
- **Ambiguous / weird exe with no signal** → filtered `.exe` picker (today's UX,
  retained as the safety net).
- **Detected game has no trainer** → never latch (`catalogIndex` excludes them).
- **Multiple games running** → latch the first confident match; ignore further
  detections while a session is active.
- **Short/generic normalized names** → name-only matches require normalized
  length ≥ 3; exact signals bypass the length rule.

## 8. Data Model / IPC Changes

- `CeSessionStartRequest` gains `game?: { id: string; name: string; steamAppId?: number | null }`.
- `CeSessionStartResult` (ok) gains `needsPicker?: boolean`; add `reason:'not-running'`
  to the error variant.
- New `StarlightEvent`: `{ type:'game:detected', game, pid, name, confidence }`.
- `preferences.autoAttachOnDetect: boolean` (default `false`) in user-config.

## 9. Testing

- `game-matcher.test.ts` — `normalizeName` cases; forward cascade with injected
  readers exercising each layer (install-dir exe, appid, normalized name,
  ambiguous, none, sub-3-length rejection); reverse `identifyProcess`
  (appid path, name path, no-trainer rejected).
- `latch-detector` — emits `game:detected` on a confident match; silent on noise
  and while a session is active; no double-fire per pid.
- `ce-session` — auto-resolves pid from game identity; `not-running` and
  `needsPicker` outcomes.

## 10. Rollout

Reactive flow and the matcher are the core value and land first. Proactive
detect + the setting build on the same matcher and the existing `process-host`
poll. Both reuse the already-shipped Windows-CE-in-prefix attach path unchanged.
