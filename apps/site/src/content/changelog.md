## 2026-05-09 — Phase 5.7: product page

The first real version of starlight.darkharasho.github.io. Hero, features, mockups, MIT footer.

## 2026-05-09 — Phase 5.6: Epic / Heroic / Lutris

Library tab now picks up games from Epic Games Launcher (Win/Mac), Heroic (Linux Epic + GOG), and Lutris (Linux). Native module dep on better-sqlite3 for the Lutris path.

## 2026-05-09 — Phase 5.5: SteamGridDB fallback

Boxart for non-Steam games falls back to SteamGridDB via the STEAMGRIDDB_API_KEY env var. Cached in userData/boxart-cache.json.

## 2026-05-09 — Phase 5.4: indexer

packages/indexer crawls a curated seeds.yaml of fearlessrevolution URLs, runs each .CT through @starlight/ct-importer, and opens a weekly PR with catalog diffs.

## 2026-05-09 — Phase 5.3: hotkey rebinding

Per-cheat hotkey rebinding via the new HotkeyCapture widget. Conflict detection at the route level. Overrides persist in user-config.

## 2026-05-09 — Phase 5.2: manual library entries

Add games the auto-scanners missed via "Add manually" on the Library tab. Catalog-derived boxart on a name match; remove on hover.

## 2026-05-09 — Phase 5.1: user config

processName overrides, recents, app preferences. Settings route. Atomic writes with corrupt-file recovery.

## 2026-05-09 — Phase 5.0: catalog foundation

@starlight/catalog workspace package with Zod schemas, in-app catalog client with ETag cache, GH Pages publish workflow.

## Earlier

- Phase 4.5: auto-detection (Steam library, ps-list polling, Inc/Dec hotkeys).
- Phase 4: engine integration via IPC.
- Phase 3: desktop shell.
- Phase 2: ct-importer.
- Phase 1: engine spike.
