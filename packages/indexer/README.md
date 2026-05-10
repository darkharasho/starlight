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
