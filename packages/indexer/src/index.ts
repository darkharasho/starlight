#!/usr/bin/env node
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogIndexEntry } from '@starlight/catalog/schema';

import { readSeeds } from './seeds.js';
import { allocateId } from './slug.js';
import { writeIndex } from './write.js';
import { discover } from './discover.js';
import { resolveSteamIds } from './steam-match.js';
import { searchTitle } from './search-title.js';
import { Progress } from './progress.js';
import { cleanTitle } from './title.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SEEDS_PATH = join(PKG_ROOT, 'seeds.yaml');
const CATALOG_DIR = join(REPO_ROOT, 'packages', 'catalog');
const STATUS_PATH = join(PKG_ROOT, '.indexer-status.json');
const DISCOVER_RESUME_PATH = join(PKG_ROOT, '.discover-progress.json');
/** Title → Steam app match, checked in so each run only searches new titles. */
const STEAM_IDS_PATH = join(PKG_ROOT, 'steam-ids.json');

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
      // Steam ids are matched by the index step (steam-ids.json).
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

  // Re-apply the cleaners from rawTitle when present, so changes to them
  // propagate without needing a fresh discover run.
  const titles = seeds.map((seed) => searchTitle(seed.rawTitle ? cleanTitle(seed.rawTitle) : seed.name));

  // STARLIGHT_STEAM_OFFLINE=1 uses only already-matched titles; STARLIGHT_STEAM_LIMIT caps new searches.
  const offline = process.env.STARLIGHT_STEAM_OFFLINE === '1';
  const limitEnv = process.env.STARLIGHT_STEAM_LIMIT;
  const steam = await resolveSteamIds(titles, {
    cachePath: STEAM_IDS_PATH,
    ...(offline ? { limit: 0 } : limitEnv ? { limit: Number(limitEnv) } : {}),
    onProgress: (done, total, title) => {
      if (done % 50 === 0) console.log(`[steam] ${new Date().toISOString().slice(11, 19)} ${done}/${total} ${title}`);
    },
    onRateLimit: (wait, pace) => console.log(`[steam] rate limited: waiting ${wait / 1000}s, then one search every ${pace / 1000}s`),
  });

  const generatedAt = new Date().toISOString();
  const indexEntries: CatalogIndexEntry[] = [];
  for (const [i, seed] of seeds.entries()) {
    const hit = steam.get(titles[i]!);
    // A matched thread shows under Steam's name, so variants of one game agree.
    const name = hit?.name ?? titles[i]!;
    const id = allocateId(name, taken);
    taken.add(id);
    indexEntries.push({
      id,
      name,
      steamAppId: seed.steamAppId ?? hit?.id ?? null,
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
  const withId = indexEntries.filter((e) => e.steamAppId != null).length;
  await progress.done(`${indexEntries.length} entries (${withId} with Steam ids) → packages/catalog/index.json`);
  return 0;
}

main().then(c => process.exit(c)).catch(err => {
  console.error('indexer fatal:', err);
  process.exit(1);
});
