import { app } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STEAM_CDN = (id: number): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`;

const STEAMGRIDDB_BASE = 'https://www.steamgriddb.com/api/v2';
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  url: string | null;
  resolvedAt: string;        // ISO timestamp
}

type Cache = Record<string, CacheEntry>;

async function readCache(path: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

async function writeCache(path: string, cache: Cache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function cacheKey(req: { name: string; steamAppId?: number; forceFallback?: boolean }): string {
  if (req.forceFallback) return `fallback:${req.name.toLowerCase()}`;
  return req.steamAppId != null ? String(req.steamAppId) : `name:${req.name.toLowerCase()}`;
}

interface SgdbSearchHit { id: number; name: string }
interface SgdbGrid { id: number; url: string; width?: number; height?: number }
interface SgdbResponse<T> { success: boolean; data?: T }

async function sgdbSearch(name: string, apiKey: string, fetchFn: typeof fetch): Promise<number | null> {
  const url = `${STEAMGRIDDB_BASE}/search/autocomplete/${encodeURIComponent(name)}`;
  let res: Response;
  try { res = await fetchFn(url, { headers: { Authorization: `Bearer ${apiKey}` } }); }
  catch { return null; }
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as SgdbResponse<SgdbSearchHit[]> | null;
  if (!body?.success || !body.data || body.data.length === 0) return null;
  return body.data[0]!.id;
}

async function sgdbGrids(gameId: number, apiKey: string, fetchFn: typeof fetch): Promise<string | null> {
  const url = `${STEAMGRIDDB_BASE}/grids/game/${gameId}`;
  let res: Response;
  try { res = await fetchFn(url, { headers: { Authorization: `Bearer ${apiKey}` } }); }
  catch { return null; }
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as SgdbResponse<SgdbGrid[]> | null;
  if (!body?.success || !body.data || body.data.length === 0) return null;
  // Prefer 2:3 aspect (600x900-ish) when available; fall back to first grid.
  const portrait = body.data.find(g => g.width != null && g.height != null && Math.abs((g.width / g.height) - (2 / 3)) < 0.05);
  return (portrait ?? body.data[0]!).url;
}

export interface ResolveBoxartOpts {
  cachePath: string;
  apiKey: string | null;
  fetch: typeof fetch;
}

export async function resolveBoxartFor(
  req: { name: string; steamAppId?: number; forceFallback?: boolean },
  opts: ResolveBoxartOpts,
): Promise<{ url: string | null }> {
  const cache = await readCache(opts.cachePath);
  const key = cacheKey(req);
  const cached = cache[key];

  // Cache hit: return positive result indefinitely; null result for NEGATIVE_TTL_MS.
  if (cached) {
    if (cached.url !== null) return { url: cached.url };
    const age = Date.now() - new Date(cached.resolvedAt).getTime();
    if (age < NEGATIVE_TTL_MS) return { url: null };
  }

  let url: string | null = null;
  if (req.steamAppId != null && !req.forceFallback) {
    url = STEAM_CDN(req.steamAppId);
  } else if (opts.apiKey) {
    const gameId = await sgdbSearch(req.name, opts.apiKey, opts.fetch);
    if (gameId !== null) url = await sgdbGrids(gameId, opts.apiKey, opts.fetch);
  }

  cache[key] = { url, resolvedAt: new Date().toISOString() };
  await writeCache(opts.cachePath, cache);
  return { url };
}

// --- Production singleton wrapper ---

function defaultCachePath(): string {
  return join(app.getPath('userData'), 'boxart-cache.json');
}

export async function resolveBoxart(req: { name: string; steamAppId?: number; forceFallback?: boolean }): Promise<{ url: string | null }> {
  return resolveBoxartFor(req, {
    cachePath: defaultCachePath(),
    apiKey: process.env['STEAMGRIDDB_API_KEY'] ?? null,
    fetch: globalThis.fetch,
  });
}
