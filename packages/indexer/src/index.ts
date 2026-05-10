#!/usr/bin/env node
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogIndexEntry } from '@starlight/catalog/schema';

import { readSeeds } from './seeds.js';
import { allocateId } from './slug.js';
import { writeIndex } from './write.js';
import { discover } from './discover.js';
import { loadSteamAppList } from './steam.js';
import { Progress } from './progress.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SEEDS_PATH = join(PKG_ROOT, 'seeds.yaml');
const CATALOG_DIR = join(REPO_ROOT, 'packages', 'catalog');
const STATUS_PATH = join(PKG_ROOT, '.indexer-status.json');
const DISCOVER_RESUME_PATH = join(PKG_ROOT, '.discover-progress.json');

async function main(): Promise<number> {
  const subcommand = process.argv[2] ?? 'index';
  if (subcommand === 'discover') {
    const pageLimitEnv = process.env.STARLIGHT_DISCOVER_PAGE_LIMIT;
    const sleepMsEnv = process.env.STARLIGHT_DISCOVER_SLEEP_MS;
    await discover({
      forumBase: 'https://fearlessrevolution.com/viewforum.php',
      forums: [4],
      seedsPath: SEEDS_PATH,
      sleepMs: sleepMsEnv ? Number(sleepMsEnv) : 1000,
      ...(pageLimitEnv ? { pageLimit: Number(pageLimitEnv) } : {}),
      statusPath: STATUS_PATH,
      resumePath: DISCOVER_RESUME_PATH,
      loadSteamMap: () => loadSteamAppList({
        cachePath: join(PKG_ROOT, '.steam-applist-cache.json'),
      }),
    });
    return 0;
  }

  // Default `index` subcommand: build a manifest-only catalog from seeds.yaml.
  // Trainer JSON files are NOT pre-fetched; the desktop app fetches them live
  // on first click via the trainerSource URL and caches them per-user.
  const seeds = await readSeeds(SEEDS_PATH);
  const taken = new Set<string>();

  const progress = new Progress({
    phase: 'index',
    total: seeds.length,
    statusPath: STATUS_PATH,
    lineEvery: 100,
  });

  const generatedAt = new Date().toISOString();
  const indexEntries: CatalogIndexEntry[] = [];
  for (const seed of seeds) {
    const id = allocateId(seed.name, taken);
    taken.add(id);
    indexEntries.push({
      id,
      name: seed.name,
      steamAppId: seed.steamAppId,
      processName: seed.processName,
      platform: seed.platform,
      ...(seed.tags ? { tags: seed.tags } : {}),
      trainerSource: seed.url,
      trainerUpdatedAt: generatedAt,
    });
    progress.bump('added');
    await progress.tick(id);
  }
  await writeIndex(CATALOG_DIR, indexEntries);
  await progress.done(`${indexEntries.length} entries → packages/catalog/index.json`);
  return 0;
}

main().then(c => process.exit(c)).catch(err => {
  console.error('indexer fatal:', err);
  process.exit(1);
});
