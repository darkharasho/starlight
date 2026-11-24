import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, utimes, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSteamArt, findLibraryCover, parseArtUrl, parseStoreArt, storeItemsUrl, steamArtUrl, steamHeroArtUrl, findLibraryHero } from '../../src/main/steam-art.js';

let dir: string;
let root: string;
beforeEach(async () => {
  dir = join(tmpdir(), `starlight-steam-art-${Date.now()}-${Math.random()}`);
  root = join(dir, 'steam');
  await mkdir(join(root, 'appcache', 'librarycache'), { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const lib = (...p: string[]): string => join(root, 'appcache', 'librarycache', ...p);

describe('parseArtUrl', () => {
  it('accepts a numeric steam id and rejects anything else', () => {
    expect(parseArtUrl(steamArtUrl(570))).toEqual({ kind: 'cover', appId: 570 });
    expect(parseArtUrl(steamHeroArtUrl(570))).toEqual({ kind: 'hero', appId: 570 });
    expect(parseArtUrl('starlight-art://steam/abc')).toBeNull();
    expect(parseArtUrl('starlight-art://steam/../etc')).toBeNull();
    expect(parseArtUrl('starlight-art://other/570')).toBeNull();
    expect(parseArtUrl('https://steam/570')).toBeNull();
  });
});

describe('findLibraryCover', () => {
  it('prefers the flat file, then the newest hashed capsule, then the legacy name', async () => {
    expect(await findLibraryCover(root, 10)).toBeNull();

    await writeFile(lib('10_library_600x900.jpg'), 'legacy');
    expect(await findLibraryCover(root, 10)).toBe(lib('10_library_600x900.jpg'));

    await mkdir(lib('10', 'aaa'), { recursive: true });
    await mkdir(lib('10', 'bbb'), { recursive: true });
    await writeFile(lib('10', 'aaa', 'library_capsule.jpg'), 'old');
    await writeFile(lib('10', 'bbb', 'library_capsule.jpg'), 'new');
    await utimes(lib('10', 'aaa', 'library_capsule.jpg'), 1000, 1000);
    expect(await findLibraryCover(root, 10)).toBe(lib('10', 'bbb', 'library_capsule.jpg'));

    await writeFile(lib('10', 'library_600x900.jpg'), 'flat');
    expect(await findLibraryCover(root, 10)).toBe(lib('10', 'library_600x900.jpg'));
  });
});

describe('findLibraryHero', () => {
  it('finds the hashed banner', async () => {
    await mkdir(lib('11', 'h1'), { recursive: true });
    await writeFile(lib('11', 'h1', 'library_hero.jpg'), 'HERO');
    expect(await findLibraryHero(root, 11)).toBe(lib('11', 'h1', 'library_hero.jpg'));
    expect(await findLibraryCover(root, 11)).toBeNull();
  });
});

describe('store covers', () => {
  it('builds one GetItems request and parses capsules', () => {
    const url = decodeURIComponent(storeItemsUrl([1, 2]));
    expect(url).toContain('IStoreBrowseService/GetItems');
    expect(url).toContain('"ids":[{"appid":1},{"appid":2}]');
    const m = parseStoreArt({ response: { store_items: [
      { appid: 1, assets: { asset_url_format: 'steam/apps/1/abc/${FILENAME}', library_capsule: 'cap.jpg', library_hero: 'hero.jpg' } },
      { appid: 2, assets: {} },
      { appid: 'x' },
    ] } });
    expect(m.get(1)).toEqual({
      cover: 'https://shared.steamstatic.com/store_item_assets/steam/apps/1/abc/cap.jpg',
      hero: 'https://shared.steamstatic.com/store_item_assets/steam/apps/1/abc/hero.jpg',
    });
    expect(m.get(2)).toEqual({ cover: null, hero: null });
    expect(m.size).toBe(2);
  });
});

function storeBody(ids: number[]): unknown {
  return { response: { store_items: ids.map((appid) => ({ appid, assets: { asset_url_format: `steam/apps/${appid}/h/\${FILENAME}`, library_capsule: 'c.jpg', library_hero: 'hero.jpg' } })) } };
}

describe('createSteamArt', () => {
  it('serves the local cover without touching the network', async () => {
    await writeFile(lib('20_library_600x900.jpg'), 'LOCAL');
    const calls: string[] = [];
    const art = createSteamArt({
      fetch: (async (u: string) => { calls.push(u); throw new Error('no network'); }) as unknown as typeof fetch,
      getSteamRoot: async () => root,
      cacheFile: join(dir, 'cache.json'),
    });
    const res = await art.serve(steamArtUrl(20));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('LOCAL');
    expect(calls).toEqual([]);
  });

  it('batches store lookups made together, caches them, and proxies the capsule', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: string) => {
      calls.push(u);
      if (u.includes('GetItems')) {
        const ids = [...decodeURIComponent(u).matchAll(/"appid":(\d+)/g)].map((m) => Number(m[1]));
        return new Response(JSON.stringify(storeBody(ids)), { status: 200 });
      }
      return new Response('IMG', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
    const cacheFile = join(dir, 'cache.json');
    const art = createSteamArt({ fetch: fetchFn, getSteamRoot: async () => root, cacheFile });
    const [a, b] = await Promise.all([art.remoteCover(31), art.remoteCover(32)]);
    expect(a).toBe('https://shared.steamstatic.com/store_item_assets/steam/apps/31/h/c.jpg');
    expect(b).toContain('/apps/32/');
    expect(calls.filter((u) => u.includes('GetItems'))).toHaveLength(1);
    const saved = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, { url: string }>;
    expect(saved['31']!.url).toBe(a);

    const res = await art.serve(steamArtUrl(31));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('IMG');
    expect(await art.remoteHero(31)).toBe('https://shared.steamstatic.com/store_item_assets/steam/apps/31/h/hero.jpg');
    expect(calls.filter((u) => u.includes('GetItems'))).toHaveLength(1);

    // A fresh instance reads the saved lookup instead of asking the store again.
    const again: string[] = [];
    const art2 = createSteamArt({
      fetch: (async (u: string) => { again.push(u); return new Response('IMG', { status: 200 }); }) as unknown as typeof fetch,
      getSteamRoot: async () => null,
      cacheFile,
    });
    expect(await art2.remoteCover(32)).toBe(b);
    expect(again).toEqual([]);
  });

  it('falls back to the CDN portrait, then the hero, then 404', async () => {
    const ok = new Set<string>(['https://cdn.cloudflare.steamstatic.com/steam/apps/41/library_hero.jpg']);
    const fetchFn = (async (u: string) => {
      if (u.includes('GetItems')) return new Response(JSON.stringify({ response: { store_items: [{ appid: 41 }, { appid: 42 }] } }), { status: 200 });
      return new Response(null, { status: ok.has(u) ? 200 : 404 });
    }) as unknown as typeof fetch;
    const art = createSteamArt({ fetch: fetchFn, getSteamRoot: async () => root, cacheFile: join(dir, 'c.json') });
    expect(await art.remoteCover(41)).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/41/library_hero.jpg');
    expect(await art.remoteCover(42)).toBeNull();
    expect((await art.serve(steamArtUrl(42))).status).toBe(404);
    expect((await art.serve('starlight-art://steam/nope')).status).toBe(404);
  });
});
