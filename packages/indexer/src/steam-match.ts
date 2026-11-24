import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sameGame } from './search-title.js';

/**
 * Steam app ids for catalog titles, from the store's public search (no key).
 * Steam's keyless full app list (ISteamApps/GetAppList) is gone, so each
 * title is searched once and the answer kept in a cache file that's checked
 * in — a weekly run only searches titles it hasn't seen.
 */

const SEARCH_URL = (term: string): string =>
  `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=us`;
const USER_AGENT = 'starlight-indexer/0.0 (+https://github.com/darkharasho/starlight)';
/** A title Steam had no match for is searched again after this long. */
const MISS_RETRY_MS = 30 * 86_400_000;

export interface SteamHit { id: number; name: string }
export interface CachedMatch { hit: SteamHit | null; at: string }
export type MatchCache = Record<string, CachedMatch>;

interface SearchItem { type?: unknown; id?: unknown; name?: unknown }

/** The search result that is this title's game, or null. Never guesses: the names have to agree. */
export function pickMatch(title: string, items: SearchItem[]): SteamHit | null {
  for (const it of items) {
    if (it.type !== 'app' || typeof it.id !== 'number' || typeof it.name !== 'string') continue;
    if (sameGame(title, it.name)) return { id: it.id, name: it.name };
  }
  return null;
}

export async function readMatchCache(path: string): Promise<MatchCache> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as MatchCache;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export async function writeMatchCache(path: string, cache: MatchCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(sorted, null, 1) + '\n', 'utf8');
  await rename(tmp, path);
}

export interface ResolveOpts {
  cachePath: string;
  fetch?: typeof fetch;
  sleepMs?: number;
  now?: () => number;
  /** Most titles to search this run (the rest wait for the next one). */
  limit?: number;
  onProgress?: (done: number, total: number, title: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Looks up each title (already cleaned with `searchTitle`) and returns
 * title → hit for every title with a match, cached or new. Searches that fail
 * are left out of the cache so the next run tries them again.
 */
export async function resolveSteamIds(titles: string[], opts: ResolveOpts): Promise<Map<string, SteamHit>> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleepMs = opts.sleepMs ?? 1500;
  const cache = await readMatchCache(opts.cachePath);
  const unique = [...new Set(titles.filter((t) => t.trim() !== ''))];
  const keyOf = (t: string): string => t.toLowerCase();

  const todo = unique.filter((t) => {
    const c = cache[keyOf(t)];
    if (!c) return true;
    return c.hit === null && now() - Date.parse(c.at) > MISS_RETRY_MS;
  }).slice(0, opts.limit ?? Number.POSITIVE_INFINITY);

  let backoff = 0;
  for (let i = 0; i < todo.length; i++) {
    const title = todo[i]!;
    opts.onProgress?.(i, todo.length, title);
    let items: SearchItem[] | null = null;
    try {
      const res = await fetchFn(SEARCH_URL(title), { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        // Rate limited: wait it out and try this title again.
        backoff = Math.min(backoff ? backoff * 2 : 60_000, 600_000);
        if (sleepMs > 0) await sleep(backoff);
        i--;
        continue;
      }
      if (res.ok) {
        const body = await res.json().catch(() => null) as { items?: SearchItem[] } | null;
        items = Array.isArray(body?.items) ? body.items : [];
      }
    } catch { /* network error: leave uncached */ }
    backoff = 0;
    if (items) cache[keyOf(title)] = { hit: pickMatch(title, items), at: new Date(now()).toISOString() };
    if (i % 25 === 24) await writeMatchCache(opts.cachePath, cache);
    if (sleepMs > 0 && i < todo.length - 1) await sleep(sleepMs);
  }
  if (todo.length > 0) await writeMatchCache(opts.cachePath, cache);

  const out = new Map<string, SteamHit>();
  for (const t of unique) {
    const hit = cache[keyOf(t)]?.hit;
    if (hit) out.set(t, hit);
  }
  return out;
}
