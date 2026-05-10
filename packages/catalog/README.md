# @starlight/catalog

Hand-curated and indexer-generated catalog of game trainers.

- `index.json` — root index of catalog entries (one per game).
- `trainers/<id>.json` — full Starlight trainer payload, fetched lazily.
- `src/schema.ts` — Zod schemas validating both files.

Consumed by:
- `apps/desktop/src/main/catalog-host.ts` (validation of fetched data).
- `packages/indexer/` (Phase 5.4 — produces these files from fearlessrevolution seeds).
- `apps/site/` and the `publish-pages.yml` workflow (deploys these to GH Pages).
