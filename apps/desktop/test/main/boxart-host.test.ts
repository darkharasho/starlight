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
  return async (): Promise<Response> => {
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

describe('resolveBoxartFor — SteamGridDB fallback', () => {
  it('returns null when no steamAppId and no API key', async () => {
    const r = await resolveBoxartFor(
      { name: 'My Game' },
      { cachePath, apiKey: null, fetch: fakeFetch() },
    );
    expect(r.url).toBeNull();
  });

  it('queries SteamGridDB search → grids when no steamAppId', async () => {
    const r = await resolveBoxartFor(
      { name: 'My Game' },
      {
        cachePath, apiKey: 'TESTKEY',
        fetch: fakeFetch(
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
        fetch: fakeFetch({ ok: true, json: { success: true, data: [] } }),
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
        fetch: fakeFetch({ ok: false, status: 503 }),
      },
    );
    expect(r.url).toBeNull();
  });
});

describe('resolveBoxartFor — cache hits', () => {
  it('returns cached URL on second call without re-fetching', async () => {
    let calls = 0;
    const fetch = fakeFetch(
      { ok: true, json: { success: true, data: [{ id: 1, name: 'X' }] } },
      { ok: true, json: { success: true, data: [{ id: 1, url: 'https://cdn.example/x.jpg' }] } },
    );
    const wrapped = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      calls++;
      return fetch(...args);
    };
    await resolveBoxartFor({ name: 'X' }, { cachePath, apiKey: 'KEY', fetch: wrapped });
    const r2 = await resolveBoxartFor({ name: 'X' }, { cachePath, apiKey: 'KEY', fetch: wrapped });
    expect(r2.url).toBe('https://cdn.example/x.jpg');
    expect(calls).toBe(2);   // first call: 2 (search + grids); second: 0 (cache hit)
  });

  it('negatively caches null results for 24h', async () => {
    const apiKey = 'KEY';
    let searchCalls = 0;
    const wrapped = async (): Promise<Response> => {
      searchCalls++;
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) } as Response;
    };
    const r1 = await resolveBoxartFor({ name: 'Empty' }, { cachePath, apiKey, fetch: wrapped });
    const r2 = await resolveBoxartFor({ name: 'Empty' }, { cachePath, apiKey, fetch: wrapped });
    expect(r1.url).toBeNull();
    expect(r2.url).toBeNull();
    expect(searchCalls).toBe(1);    // second call hits the negative cache
  });

  it('refreshes negative cache after 24h', async () => {
    const stale = JSON.stringify({
      'OldEmpty': { url: null, resolvedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
    });
    await writeFile(cachePath, stale);
    let searchCalls = 0;
    const wrapped = async (): Promise<Response> => {
      searchCalls++;
      return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 1, name: 'OldEmpty' }] }) } as Response;
    };
    const r = await resolveBoxartFor({ name: 'OldEmpty' }, {
      cachePath,
      apiKey: 'KEY',
      fetch: wrapped,
    });
    expect(searchCalls).toBeGreaterThan(0);   // cache was stale, re-fetched
  });
});
