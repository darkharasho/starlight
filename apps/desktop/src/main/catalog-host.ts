import { app } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogIndexSchema, StarlightTrainerSchema, type CatalogIndex, type StarlightTrainer } from '@starlight/catalog/schema';

const PROD_CATALOG_URL = 'https://darkharasho.github.io/starlight/catalog/index.json';
const PROD_CATALOG_BASE = 'https://darkharasho.github.io/starlight/catalog/';

/**
 * In dev (electron-vite), read the catalog from the local monorepo so changes
 * to `pnpm --filter @starlight/indexer build && node dist/index.js` show up
 * immediately without waiting for a Pages deploy. Returns null in packaged
 * builds or when the local file is missing.
 */
async function readLocalCatalog(): Promise<CatalogIndex | null> {
  if (app.isPackaged) return null;
  try {
    const here = dirname(fileURLToPath(import.meta.url));            // out/main
    const repoCatalog = resolve(here, '..', '..', '..', '..', 'packages', 'catalog', 'index.json');
    const text = await readFile(repoCatalog, 'utf8');
    return CatalogIndexSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

interface CacheMeta {
  etag?: string;
  lastFetchedAt: string;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch { return null; }
}

/**
 * Fetch the catalog index from `url`, validating against the Zod schema.
 * Caches body + ETag under `cacheDir`. Falls back to cache on network failure.
 *
 * Exported separately from `fetchCatalog()` so tests can drive a custom URL/cacheDir.
 */
export async function fetchCatalogFrom(url: string, cacheDir: string): Promise<CatalogIndex> {
  await mkdir(cacheDir, { recursive: true });
  const bodyPath = join(cacheDir, 'index.json');
  const metaPath = join(cacheDir, 'meta.json');
  const meta = await readJsonIfExists<CacheMeta>(metaPath);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (meta?.etag) headers['If-None-Match'] = meta.etag;

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    // Network failure — fall back to cache if available.
    const cached = await readJsonIfExists<unknown>(bodyPath);
    if (cached !== null) {
      return CatalogIndexSchema.parse(cached);
    }
    throw new Error('catalog unavailable: network failed and no cache present');
  }

  if (res.status === 304) {
    const cached = await readJsonIfExists<unknown>(bodyPath);
    if (cached !== null) return CatalogIndexSchema.parse(cached);
    throw new Error('catalog 304 but cache missing');
  }

  if (!res.ok) {
    const cached = await readJsonIfExists<unknown>(bodyPath);
    if (cached !== null) return CatalogIndexSchema.parse(cached);
    throw new Error(`catalog unavailable: HTTP ${res.status}`);
  }

  const text = await res.text();
  const json = JSON.parse(text);
  const parsed = CatalogIndexSchema.parse(json);     // throws on schema mismatch

  const newEtag = res.headers.get('etag') ?? undefined;
  await atomicWrite(bodyPath, text);
  const newMeta: CacheMeta = { lastFetchedAt: new Date().toISOString() };
  if (newEtag !== undefined) newMeta.etag = newEtag;
  await atomicWrite(metaPath, JSON.stringify(newMeta));

  return parsed;
}

export async function fetchTrainerFrom(
  baseUrl: string,
  trainerPath: string,
  cacheDir: string,
): Promise<StarlightTrainer> {
  const trainerCacheDir = join(cacheDir, 'trainers');
  await mkdir(trainerCacheDir, { recursive: true });
  const id = trainerPath.replace(/^trainers\//, '').replace(/\.json$/, '');
  const bodyPath = join(trainerCacheDir, `${id}.json`);
  const url = baseUrl.endsWith('/') ? `${baseUrl}${trainerPath}` : `${baseUrl}/${trainerPath}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    const cached = await readJsonIfExists<unknown>(bodyPath);
    if (cached !== null) return StarlightTrainerSchema.parse(cached);
    throw new Error('trainer unavailable: network failed and no cache present');
  }

  if (!res.ok) {
    const cached = await readJsonIfExists<unknown>(bodyPath);
    if (cached !== null) return StarlightTrainerSchema.parse(cached);
    throw new Error(`trainer unavailable: HTTP ${res.status}`);
  }

  const text = await res.text();
  const parsed = StarlightTrainerSchema.parse(JSON.parse(text));
  await atomicWrite(bodyPath, text);
  return parsed;
}

let lastFetched: CatalogIndex | null = null;

export function getCachedIndex(): CatalogIndex | null { return lastFetched; }

export async function fetchCatalog(): Promise<CatalogIndex> {
  const local = await readLocalCatalog();
  if (local) {
    lastFetched = local;
    return local;
  }
  const cacheDir = join(app.getPath('userData'), 'catalog-cache');
  const idx = await fetchCatalogFrom(PROD_CATALOG_URL, cacheDir);
  lastFetched = idx;
  return idx;
}

export async function fetchTrainer(trainerPath: string): Promise<StarlightTrainer> {
  const cacheDir = join(app.getPath('userData'), 'catalog-cache');
  return fetchTrainerFrom(PROD_CATALOG_BASE, trainerPath, cacheDir);
}
