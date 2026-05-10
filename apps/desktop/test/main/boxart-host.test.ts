import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBoxartFor } from '../../src/main/boxart-host.js';

let cacheDir: string;
let cachePath: string;

beforeEach(async () => {
  cacheDir = join(tmpdir(), `starlight-boxart-${Date.now()}-${Math.random()}`);
  await mkdir(cacheDir, { recursive: true });
  cachePath = join(cacheDir, 'boxart-cache.json');
});
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

function fakeFetch(...responses: Array<{ ok: boolean; json?: unknown; status?: number }>) {
  let i = 0;
  return async (_url: unknown, init?: { method?: string }): Promise<Response> => {
    // HEAD requests (used to validate Steam library covers exist) are stubbed
    // to "ok" without consuming a queued response — keeps existing tests
    // focused on the GET responses they care about.
    if (init?.method === 'HEAD') {
      return { ok: true, status: 200, json: async () => null } as Response;
    }
    const r = responses[i++];
    if (!r) throw new Error('fake fetch ran out of responses');
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json,
    } as Response;
  };
}

describe('resolveBoxartFor — steamAppId path', () => {
  it('returns Steam CDN URL when steamAppId provided', async () => {
    const r = await resolveBoxartFor(
      { name: 'Elden Ring', steamAppId: 1245620 },
      { cachePath, apiKey: null, fetch: fakeFetch() },
    );
    expect(r.url).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg');
  });

  it('caches the Steam CDN URL', async () => {
    await resolveBoxartFor(
      { name: 'Elden Ring', steamAppId: 1245620 },
      { cachePath, apiKey: null, fetch: fakeFetch() },
    );
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    const key = '1245620';
    expect(cache[key]?.url).toContain('1245620');
  });
});

describe('resolveBoxartFor — Steam Store search (free name → appid)', () => {
  it('uses Steam Store search to resolve appid → Steam CDN url', async () => {
    const r = await resolveBoxartFor(
      { name: 'Crusader Kings III' },
      {
        cachePath, apiKey: null,
        fetch: fakeFetch(
          { ok: true, json: { items: [{ type: 'app', id: 1158310, name: 'Crusader Kings III' }] } },
        ),
      },
    );
    expect(r.url).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/1158310/library_600x900.jpg');
  });

  it('falls back to first app result when no exact match found', async () => {
    const r = await resolveBoxartFor(
      { name: 'Some Variant' },
      {
        cachePath, apiKey: null,
        fetch: fakeFetch(
          { ok: true, json: { items: [{ type: 'bundle', id: 1, name: 'b' }, { type: 'app', id: 42, name: 'Different Title' }] } },
        ),
      },
    );
    expect(r.url).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/42/library_600x900.jpg');
  });
});

describe('resolveBoxartFor — SteamGridDB fallback', () => {
  it('returns null when no steamAppId, Steam Store empty, and no API key', async () => {
    const r = await resolveBoxartFor(
      { name: 'My Game' },
      {
        cachePath, apiKey: null,
        fetch: fakeFetch({ ok: true, json: { items: [] } }),
      },
    );
    expect(r.url).toBeNull();
  });

  it('queries SteamGridDB search → grids when Steam Store has no match', async () => {
    const r = await resolveBoxartFor(
      { name: 'My Game' },
      {
        cachePath, apiKey: 'TESTKEY',
        fetch: fakeFetch(
          { ok: true, json: { items: [] } },                     // Steam Store: no match
          { ok: true, json: { success: true, data: [{ id: 99, name: 'My Game' }] } },
          { ok: true, json: { success: true, data: [{ id: 1, url: 'https://cdn.example/grid.jpg', width: 600, height: 900 }] } },
        ),
      },
    );
    expect(r.url).toBe('https://cdn.example/grid.jpg');
  });

  it('returns null when SteamGridDB search returns no games', async () => {
    const r = await resolveBoxartFor(
      { name: 'Unknown Game' },
      {
        cachePath, apiKey: 'TESTKEY',
        fetch: fakeFetch(
          { ok: true, json: { items: [] } },                     // Steam Store empty
          { ok: true, json: { success: true, data: [] } },
        ),
      },
    );
    expect(r.url).toBeNull();
  });

  it('returns null when SteamGridDB grids endpoint returns empty', async () => {
    const r = await resolveBoxartFor(
      { name: 'Game With No Art' },
      {
        cachePath, apiKey: 'TESTKEY',
        fetch: fakeFetch(
          { ok: true, json: { items: [] } },                     // Steam Store empty
          { ok: true, json: { success: true, data: [{ id: 99, name: 'Game With No Art' }] } },
          { ok: true, json: { success: true, data: [] } },
        ),
      },
    );
    expect(r.url).toBeNull();
  });

  it('returns null and tolerates SteamGridDB API errors', async () => {
    const r = await resolveBoxartFor(
      { name: 'Crashy Game' },
      {
        cachePath, apiKey: 'TESTKEY',
        fetch: fakeFetch(
          { ok: true, json: { items: [] } },                     // Steam Store empty
          { ok: false, status: 503 },
        ),
      },
    );
    expect(r.url).toBeNull();
  });
});

describe('resolveBoxartFor — forceFallback', () => {
  it('forceFallback skips Steam CDN and Steam Store, goes straight to SGDB', async () => {
    const r = await resolveBoxartFor(
      { name: 'Elden Ring', steamAppId: 1245620, forceFallback: true },
      {
        cachePath, apiKey: 'KEY',
        fetch: fakeFetch(
          { ok: true, json: { success: true, data: [{ id: 99, name: 'Elden Ring' }] } },
          { ok: true, json: { success: true, data: [{ id: 1, url: 'https://sgdb.example/elden.jpg', width: 600, height: 900 }] } },
        ),
      },
    );
    expect(r.url).toBe('https://sgdb.example/elden.jpg');
  });

  it('forceFallback caches under a different key than the Steam-positive cache', async () => {
    // First, populate the steamAppId cache with the Steam URL.
    await resolveBoxartFor(
      { name: 'Elden Ring', steamAppId: 1245620 },
      { cachePath, apiKey: null, fetch: fakeFetch() },
    );
    // Now request with forceFallback. Should hit SGDB (different cache key), not return the Steam URL.
    const r = await resolveBoxartFor(
      { name: 'Elden Ring', steamAppId: 1245620, forceFallback: true },
      {
        cachePath, apiKey: 'KEY',
        fetch: fakeFetch(
          { ok: true, json: { success: true, data: [{ id: 99, name: 'Elden Ring' }] } },
          { ok: true, json: { success: true, data: [{ id: 1, url: 'https://sgdb.example/elden.jpg' }] } },
        ),
      },
    );
    expect(r.url).toBe('https://sgdb.example/elden.jpg');
  });
});

describe('resolveBoxartFor — cache hits', () => {
  it('returns cached URL on second call without re-fetching', async () => {
    let getCalls = 0;
    const fetch = fakeFetch(
      { ok: true, json: { items: [{ type: 'app', id: 555, name: 'X' }] } },     // Steam Store hit
    );
    const wrapped = async (url: unknown, init?: { method?: string }): Promise<Response> => {
      if (init?.method !== 'HEAD') getCalls++;
      return fetch(url, init);
    };
    await resolveBoxartFor({ name: 'X' }, { cachePath, apiKey: 'KEY', fetch: wrapped });
    const r2 = await resolveBoxartFor({ name: 'X' }, { cachePath, apiKey: 'KEY', fetch: wrapped });
    expect(r2.url).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/555/library_600x900.jpg');
    expect(getCalls).toBe(1);   // first call: 1 GET (Steam Store search); second: 0 (cache hit)
  });

  it('negatively caches null results for 24h', async () => {
    const apiKey = 'KEY';
    let searchCalls = 0;
    const wrapped = async (url: unknown): Promise<Response> => {
      searchCalls++;
      const u = String(url);
      // Steam Store returns no items; SGDB search returns no data.
      if (u.includes('store.steampowered.com')) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) } as Response;
    };
    const r1 = await resolveBoxartFor({ name: 'Empty' }, { cachePath, apiKey, fetch: wrapped });
    const r2 = await resolveBoxartFor({ name: 'Empty' }, { cachePath, apiKey, fetch: wrapped });
    expect(r1.url).toBeNull();
    expect(r2.url).toBeNull();
    // First call: Steam Store + SGDB search = 2 fetches. Second call: cache hit = 0 fetches.
    expect(searchCalls).toBe(2);
  });

  it('refreshes negative cache after 24h', async () => {
    const stale = JSON.stringify({
      'name:oldempty': { url: null, resolvedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
    });
    await writeFile(cachePath, stale);
    let searchCalls = 0;
    const wrapped = async (url: unknown): Promise<Response> => {
      searchCalls++;
      const u = String(url);
      if (u.includes('store.steampowered.com')) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) } as Response;
    };
    const r = await resolveBoxartFor({ name: 'OldEmpty' }, {
      cachePath,
      apiKey: 'KEY',
      fetch: wrapped,
    });
    expect(r.url).toBeNull();
    // Stale cache → re-fetch path runs Steam Store + SGDB = 2 calls.
    expect(searchCalls).toBe(2);
  });

  it('does NOT refresh negative cache before 24h', async () => {
    const fresh = JSON.stringify({
      'name:freshempty': { url: null, resolvedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    });
    await writeFile(cachePath, fresh);
    let searchCalls = 0;
    const wrapped = async (): Promise<Response> => {
      searchCalls++;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
    };
    const r = await resolveBoxartFor({ name: 'FreshEmpty' }, {
      cachePath, apiKey: 'KEY', fetch: wrapped,
    });
    expect(r.url).toBeNull();
    expect(searchCalls).toBe(0);
  });
});
