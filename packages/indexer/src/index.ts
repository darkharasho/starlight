#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCt } from '@starlight/ct-importer';
import type { CatalogIndexEntry, StarlightTrainer } from '@starlight/catalog/schema';

import { readSeeds, type SeedEntry } from './seeds.js';
import { allocateId } from './slug.js';
import { fetchTrainer } from './fetch.js';
import { writeTrainer, writeIndex } from './write.js';
import { discover } from './discover.js';
import { loadSteamAppList } from './steam.js';
import { Progress } from './progress.js';

interface CacheEntry { sha256: string; lastFetchedAt: string; }
type Cache = Record<string, CacheEntry>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SEEDS_PATH = join(PKG_ROOT, 'seeds.yaml');
const CACHE_PATH = join(PKG_ROOT, '.indexer-cache.json');
const CATALOG_DIR = join(REPO_ROOT, 'packages', 'catalog');
const STATUS_PATH = join(PKG_ROOT, '.indexer-status.json');

async function readCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

async function writeCache(cache: Cache): Promise<void> {
  const tmp = `${CACHE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  await rename(tmp, CACHE_PATH);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface ProcessedEntry {
  seed: SeedEntry;
  id: string;
  trainerUpdatedAt: string;
  status: 'added' | 'updated' | 'unchanged';
}

async function processSeed(
  seed: SeedEntry,
  taken: Set<string>,
  cache: Cache,
): Promise<ProcessedEntry> {
  const id = allocateId(seed.name, taken);
  taken.add(id);
  const buf = await fetchTrainer(seed.url);
  const sha = sha256(buf);
  const cached = cache[seed.url];
  if (cached && cached.sha256 === sha) {
    return { seed, id, trainerUpdatedAt: cached.lastFetchedAt, status: 'unchanged' };
  }
  const xml = buf.toString('utf8');
  const out = importCt(xml, {
    gameName: seed.name,
    processName: seed.processName,
    platform: seed.platform,
  });
  const trainer: StarlightTrainer = { ...out.trainer, id };
  await writeTrainer(CATALOG_DIR, id, trainer);
  const trainerUpdatedAt = new Date().toISOString();
  cache[seed.url] = { sha256: sha, lastFetchedAt: trainerUpdatedAt };
  return { seed, id, trainerUpdatedAt, status: cached ? 'updated' : 'added' };
}

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
      loadSteamMap: () => loadSteamAppList({
        cachePath: join(PKG_ROOT, '.steam-applist-cache.json'),
      }),
    });
    return 0;
  }
  const seeds = await readSeeds(SEEDS_PATH);
  const cache = await readCache();
  const taken = new Set<string>();
  const processed: ProcessedEntry[] = [];
  let failures = 0;

  const progress = new Progress({
    phase: 'index',
    total: seeds.length,
    statusPath: STATUS_PATH,
    lineEvery: 10,
  });

  for (const seed of seeds) {
    try {
      const r = await processSeed(seed, taken, cache);
      processed.push(r);
      progress.bump(r.status);
      await progress.tick(`[${r.status}] ${r.id}`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      progress.bump('failed');
      progress.noteError(`${seed.name}: ${msg}`);
      await progress.tick(`[failed] ${seed.name} — ${msg.slice(0, 80)}`);
    }
  }

  await writeCache(cache);
  await progress.done(`${processed.length} processed · ${failures} failed`);

  // Load the existing index so failed seeds fall back to their previous entry.
  const existingIndexPath = join(CATALOG_DIR, 'index.json');
  let existingIndex: { games: CatalogIndexEntry[] } = { games: [] };
  try {
    const text = await readFile(existingIndexPath, 'utf8');
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.games)) existingIndex = parsed;
  } catch { /* no existing index — fine */ }

  const processedById = new Map(processed.map(p => [p.seed.url, p]));
  const indexEntries: CatalogIndexEntry[] = [];
  for (const seed of seeds) {
    const p = processedById.get(seed.url);
    if (p) {
      // Successful or unchanged — use fresh data.
      indexEntries.push({
        id: p.id,
        name: p.seed.name,
        steamAppId: p.seed.steamAppId,
        processName: p.seed.processName,
        platform: p.seed.platform,
        ...(p.seed.tags ? { tags: p.seed.tags } : {}),
        trainerPath: `trainers/${p.id}.json`,
        trainerUpdatedAt: p.trainerUpdatedAt,
        trainerSource: seed.url,
      });
    } else {
      // Failed this run — try to preserve the existing index entry.
      const fallback = existingIndex.games.find(g => g.trainerSource === seed.url);
      if (fallback) {
        indexEntries.push(fallback);
      }
      // If no existing entry either, the seed is dropped (genuinely missing).
    }
  }
  await writeIndex(CATALOG_DIR, indexEntries);

  const summary = {
    total: seeds.length,
    added: processed.filter(p => p.status === 'added').length,
    updated: processed.filter(p => p.status === 'updated').length,
    unchanged: processed.filter(p => p.status === 'unchanged').length,
    failed: failures,
  };
  console.log(`\n${JSON.stringify(summary)}`);
  return failures > 0 ? 1 : 0;
}

main().then(c => process.exit(c)).catch(err => {
  console.error('indexer fatal:', err);
  process.exit(1);
});
