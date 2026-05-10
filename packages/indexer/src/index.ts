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

interface CacheEntry { sha256: string; lastFetchedAt: string; }
type Cache = Record<string, CacheEntry>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SEEDS_PATH = join(PKG_ROOT, 'seeds.yaml');
const CACHE_PATH = join(PKG_ROOT, '.indexer-cache.json');
const CATALOG_DIR = join(REPO_ROOT, 'packages', 'catalog');

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
  const seeds = await readSeeds(SEEDS_PATH);
  const cache = await readCache();
  const taken = new Set<string>();
  const processed: ProcessedEntry[] = [];
  let failures = 0;

  for (const seed of seeds) {
    try {
      const r = await processSeed(seed, taken, cache);
      processed.push(r);
      console.log(`  [${r.status}] ${r.id} ← ${seed.url}`);
    } catch (err) {
      failures++;
      console.error(`  [failed] ${seed.name} ← ${seed.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await writeCache(cache);

  const indexEntries: CatalogIndexEntry[] = processed.map(p => ({
    id: p.id,
    name: p.seed.name,
    steamAppId: p.seed.steamAppId,
    processName: p.seed.processName,
    platform: p.seed.platform,
    ...(p.seed.tags ? { tags: p.seed.tags } : {}),
    trainerPath: `trainers/${p.id}.json`,
    trainerUpdatedAt: p.trainerUpdatedAt,
    trainerSource: p.seed.url,
  }));
  await writeIndex(CATALOG_DIR, indexEntries);

  const summary = {
    total: seeds.length,
    added: processed.filter(p => p.status === 'added').length,
    updated: processed.filter(p => p.status === 'updated').length,
    unchanged: processed.filter(p => p.status === 'unchanged').length,
    failed: failures,
  };
  console.log(`\n${JSON.stringify(summary)}`);
  return 0;
}

main().then(c => process.exit(c)).catch(err => {
  console.error('indexer fatal:', err);
  process.exit(1);
});
