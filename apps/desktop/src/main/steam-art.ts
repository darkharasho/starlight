import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

/**
 * Steam cover art for an app id, the way Steam itself has it now:
 *
 * 1. the copy Steam's client cached in `appcache/librarycache` (every game the
 *    player owns or has looked at — no network),
 * 2. the store's `library_capsule` from IStoreBrowseService/GetItems (newer
 *    games only publish art at a hashed path, so the fixed CDN URL 404s),
 * 3. the old fixed CDN portrait, then its wide hero banner.
 *
 * The renderer asks for `starlight-art://steam/<appid>`; main answers with the
 * first of these that exists, or 404 so the tile can fall back to a name
 * search.
 */

export const ART_SCHEME = 'starlight-art';
export const steamArtUrl = (appId: number): string => `${ART_SCHEME}://steam/${appId}`;

const STORE_API = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1';
const STORE_ASSETS = 'https://shared.steamstatic.com/store_item_assets/';
const CDN_COVER = (id: number): string => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`;
const CDN_HERO = (id: number): string => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_hero.jpg`;

/** A found capsule is asked for again after a week; an app with none, after a day. */
const FOUND_MAX_AGE_MS = 7 * 86_400_000;
const MISSING_MAX_AGE_MS = 86_400_000;
/** After a failed store request the store isn't asked again for this long. */
const FAILED_RETRY_MS = 60_000;
const STORE_TIMEOUT_MS = 5_000;
const STORE_BATCH = 100;
/** Tiles mount in a burst; their ids are collected this long into one request. */
const BATCH_WINDOW_MS = 30;

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export function parseArtUrl(raw: string): { kind: 'steam'; appId: number } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== `${ART_SCHEME}:` || u.hostname !== 'steam') return null;
  const m = /^\/(\d{1,10})\/?$/.exec(u.pathname);
  return m ? { kind: 'steam', appId: Number(m[1]) } : null;
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

/**
 * The portrait Steam's client cached for an app: `<id>/library_600x900.jpg`,
 * else the newest `<id>/<hash>/library_capsule.jpg` (the current layout), else
 * the legacy flat `<id>_library_600x900.jpg`.
 */
export async function findLibraryCover(steamRoot: string, appId: number): Promise<string | null> {
  const cache = join(steamRoot, 'appcache', 'librarycache');
  const appDir = join(cache, String(appId));
  const direct = join(appDir, 'library_600x900.jpg');
  if (await isFile(direct)) return direct;
  const entries = await readdir(appDir, { withFileTypes: true }).catch(() => []);
  let best: { file: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = join(appDir, e.name, 'library_capsule.jpg');
    const s = await stat(file).catch(() => null);
    if (s?.isFile() && (!best || s.mtimeMs > best.mtime)) best = { file, mtime: s.mtimeMs };
  }
  if (best) return best.file;
  const legacy = join(cache, `${appId}_library_600x900.jpg`);
  return (await isFile(legacy)) ? legacy : null;
}

/** One GetItems request for many apps, asking for their store assets. */
export function storeItemsUrl(appIds: number[]): string {
  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: { language: 'english', country_code: 'US' },
    data_request: { include_assets: true },
  };
  return `${STORE_API}?input_json=${encodeURIComponent(JSON.stringify(input))}`;
}

/** appid → portrait capsule URL, or null for an item the store returned without one. */
export function parseStoreCovers(json: unknown): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const items = (json as { response?: { store_items?: unknown } } | null)?.response?.store_items;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const { appid, assets } = item as { appid?: unknown; assets?: unknown };
    if (typeof appid !== 'number' || !Number.isInteger(appid)) continue;
    const a = (assets ?? {}) as { asset_url_format?: unknown; library_capsule?: unknown };
    const ok = typeof a.asset_url_format === 'string' && a.asset_url_format.includes('${FILENAME}')
      && typeof a.library_capsule === 'string' && a.library_capsule !== '';
    out.set(appid, ok ? STORE_ASSETS + (a.asset_url_format as string).replace('${FILENAME}', a.library_capsule as string) : null);
  }
  return out;
}

interface CachedUrl { url: string | null; at: number }

export interface SteamArtOpts {
  fetch: typeof fetch;
  getSteamRoot: () => Promise<string | null>;
  /** JSON file the store lookups are kept in between runs. */
  cacheFile: string;
  now?: () => number;
}

export interface SteamArt {
  /** The protocol handler's answer for a `starlight-art://` URL. Never throws. */
  serve(rawUrl: string): Promise<Response>;
  /** The best remote cover for an app (store capsule, CDN portrait, CDN hero), or null. */
  remoteCover(appId: number): Promise<string | null>;
}

export function createSteamArt(opts: SteamArtOpts): SteamArt {
  const now = opts.now ?? Date.now;
  let cache: Map<number, CachedUrl> | null = null;
  let failedAt = -Infinity;
  let saving: Promise<void> = Promise.resolve();
  /** Remote URL each app resolved to this run, so a tile re-mounting doesn't probe again. */
  const resolved = new Map<number, Promise<string | null>>();
  let pending: { ids: Set<number>; flush: Promise<void> } | null = null;

  async function load(): Promise<Map<number, CachedUrl>> {
    if (cache) return cache;
    cache = new Map();
    try {
      const raw = JSON.parse(await readFile(opts.cacheFile, 'utf8')) as Record<string, CachedUrl>;
      for (const [k, v] of Object.entries(raw)) {
        if (/^\d+$/.test(k) && v && typeof v.at === 'number' && (v.url === null || typeof v.url === 'string')) cache.set(Number(k), v);
      }
    } catch { /* first run */ }
    return cache;
  }

  function save(): Promise<void> {
    saving = saving.then(async () => {
      if (!cache) return;
      await mkdir(dirname(opts.cacheFile), { recursive: true });
      const tmp = `${opts.cacheFile}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(cache)), 'utf8');
      await rename(tmp, opts.cacheFile);
    }).catch(() => { /* best effort */ });
    return saving;
  }

  const fresh = (c: CachedUrl | undefined): boolean =>
    !!c && now() - c.at < (c.url ? FOUND_MAX_AGE_MS : MISSING_MAX_AGE_MS);

  async function fetchBatch(ids: number[]): Promise<void> {
    const c = await load();
    if (now() - failedAt < FAILED_RETRY_MS) return;
    for (let i = 0; i < ids.length; i += STORE_BATCH) {
      const batch = ids.slice(i, i + STORE_BATCH);
      try {
        const res = await opts.fetch(storeItemsUrl(batch), { signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const found = parseStoreCovers(await res.json());
        const at = now();
        for (const id of batch) c.set(id, { url: found.get(id) ?? null, at });
      } catch {
        failedAt = now();
        return;
      }
    }
    await save();
  }

  /** The store's capsule for an app, asked for together with every other id requested in the same burst. */
  async function storeCapsule(appId: number): Promise<string | null> {
    const c = await load();
    if (!fresh(c.get(appId))) {
      if (!pending) {
        const ids = new Set<number>();
        const flush = new Promise<void>((r) => setTimeout(r, BATCH_WINDOW_MS)).then(() => {
          pending = null;
          return fetchBatch([...ids]);
        });
        pending = { ids, flush };
      }
      pending.ids.add(appId);
      await pending.flush;
    }
    return c.get(appId)?.url ?? null;
  }

  async function exists(url: string): Promise<boolean> {
    try {
      const res = await opts.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
      return res.ok;
    } catch { return false; }
  }

  function remoteCover(appId: number): Promise<string | null> {
    let p = resolved.get(appId);
    if (!p) {
      p = (async () => {
        const capsule = await storeCapsule(appId);
        if (capsule) return capsule;
        if (await exists(CDN_COVER(appId))) return CDN_COVER(appId);
        if (await exists(CDN_HERO(appId))) return CDN_HERO(appId);
        return null;
      })();
      resolved.set(appId, p);
      // A miss may be a network blip — let the next request try again.
      void p.then((u) => { if (u === null) resolved.delete(appId); });
    }
    return p;
  }

  async function serve(rawUrl: string): Promise<Response> {
    const t = parseArtUrl(rawUrl);
    if (!t) return new Response(null, { status: 404 });
    try {
      const root = await opts.getSteamRoot().catch(() => null);
      const file = root ? await findLibraryCover(root, t.appId) : null;
      const type = file ? MIME[extname(file).toLowerCase()] : undefined;
      if (file && type) {
        const data = await readFile(file).catch(() => null);
        if (data) return new Response(new Uint8Array(data), { status: 200, headers: { 'content-type': type } });
      }
      const remote = await remoteCover(t.appId);
      if (remote) {
        const res = await opts.fetch(remote, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          return new Response(await res.arrayBuffer(), {
            status: 200,
            headers: { 'content-type': res.headers.get('content-type') ?? 'image/jpeg' },
          });
        }
      }
    } catch { /* fall through to 404 */ }
    return new Response(null, { status: 404 });
  }

  return { serve, remoteCover };
}
