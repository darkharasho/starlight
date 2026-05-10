# @starlight/indexer

Periodic indexer that downloads trainer files from a curated seed list (fearlessrevolution URLs)
and regenerates `packages/catalog/`.

## Run locally

    pnpm --filter @starlight/indexer build
    node packages/indexer/dist/index.js

The indexer:
1. Reads `seeds.yaml`.
2. For each entry: fetches the URL (handles direct `.CT` and `.zip` containing one `.CT`).
3. Compares SHA-256 against `.indexer-cache.json`. If unchanged, skip.
4. Otherwise: runs the bytes through `@starlight/ct-importer`, writes
   `packages/catalog/trainers/<id>.json`, updates the cache.
5. Regenerates `packages/catalog/index.json` from all seeds + their write timestamps.

A URL that fails (404, network error, parse error) is logged and skipped. The whole run never
fails for a single bad seed.

## Discover seeds from fearlessrevolution

    pnpm --filter @starlight/indexer build
    node packages/indexer/dist/index.js discover

This walks the public phpBB forum at https://fearlessrevolution.com/viewforum.php?f=4
paginating by 50, extracts each topic's id and title, filters stickies/requests, applies
aggressive title cleanup, looks up Steam App IDs via Steam's GetAppList (no auth, 24h
cache at `.steam-applist-cache.json`), and writes the result to `seeds.yaml`.

The discover step takes ~80 minutes for the full forum (~5,000 threads at 1 req/sec).
After it finishes, run the index step (no arg) to download trainers and regenerate
the catalog:

    node packages/indexer/dist/index.js

The full bootstrap (discover + index) takes a few hours on first run. Subsequent runs
are SHA-deltas via the Phase 5.4 cache.

### Resume after Ctrl-C

`discover` writes `.discover-progress.json` after every page, so an interrupted walk
picks up where it left off on the next run. The file is deleted on successful
completion. Delete it manually to force a fresh walk.

`index` flushes `.indexer-cache.json` every 5 seeds (override with
`STARLIGHT_INDEX_FLUSH_EVERY=N`), so a Ctrl-C still preserves cache progress. Set
`STARLIGHT_INDEX_SKIP_RECENT_HOURS=24` to short-circuit the network entirely for any
seed last fetched within that window — the resumed run will fly through already-done
seeds in seconds.

Useful env vars:

    STARLIGHT_DISCOVER_PAGE_LIMIT=10        # cap discover walk (default: full forum)
    STARLIGHT_DISCOVER_SLEEP_MS=500         # sleep between forum pages (default 1000)
    STARLIGHT_INDEX_SKIP_RECENT_HOURS=24    # skip refetch if cache is younger than this
    STARLIGHT_INDEX_FLUSH_EVERY=5           # flush cache file every N seeds

## Cron

A GitHub Actions workflow runs the indexer weekly and opens a PR with any diffs (see
`.github/workflows/indexer.yml`).

## seeds.yaml

Each entry carries everything `index.json` needs except the trainer payload itself:

    games:
      - url: https://fearlessrevolution.com/path/to/trainer.zip
        name: Elden Ring
        steamAppId: 1245620
        processName: [eldenring.exe]
        platform: [windows]
        tags: [souls, rpg]
