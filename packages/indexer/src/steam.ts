import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const APPLIST_URL = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface AppEntry { appid: number; name: string }
interface AppList { applist: { apps: AppEntry[] } }

export interface LoadOpts {
  fetch?: typeof fetch;
  cachePath?: string;
  now?: () => number;
}

async function readCacheIfFresh(path: string, now: () => number): Promise<AppList | null> {
  try {
    const s = await stat(path);
    if (now() - s.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(await readFile(path, 'utf8')) as AppList;
  } catch {
    return null;
  }
}

async function writeCache(path: string, body: AppList): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(body), 'utf8');
  await rename(tmp, path);
}

function buildMap(body: AppList): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of body.applist?.apps ?? []) {
    if (typeof a?.name === 'string' && typeof a.appid === 'number') {
      m.set(a.name.toLowerCase(), a.appid);
    }
  }
  return m;
}

export async function loadSteamAppList(opts: LoadOpts = {}): Promise<Map<string, number>> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const cachePath = opts.cachePath ?? '.steam-applist-cache.json';
  const now = opts.now ?? Date.now;

  const cached = await readCacheIfFresh(cachePath, now);
  if (cached) return buildMap(cached);

  let res: Response;
  try {
    res = await fetchFn(APPLIST_URL);
  } catch {
    return new Map();
  }
  if (!res.ok) return new Map();
  const body = await res.json().catch(() => null) as AppList | null;
  if (!body?.applist?.apps) return new Map();

  await writeCache(cachePath, body).catch(() => {});
  return buildMap(body);
}
