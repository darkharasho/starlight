import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSteamAppList } from '../src/steam.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, 'fixtures', 'steam-applist.json');

let dir: string;
let cachePath: string;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-steam-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  cachePath = join(dir, '.steam-applist-cache.json');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const fixtureBody = JSON.parse(await readFile(FIXTURE, 'utf8'));

function fakeFetchOk(): typeof fetch {
  return async () => ({ ok: true, status: 200, json: async () => fixtureBody } as Response);
}

function fakeFetchFail(): typeof fetch {
  return async () => { throw new Error('network down'); };
}

describe('loadSteamAppList', () => {
  it('builds a lowercased map from GetAppList JSON', async () => {
    const m = await loadSteamAppList({ fetch: fakeFetchOk(), cachePath });
    expect(m.get('elden ring')).toBe(1245620);
    expect(m.get('stardew valley')).toBe(413150);
    expect(m.get("baldur's gate 3")).toBe(1086940);
    expect(m.get('Elden Ring')).toBeUndefined();
  });

  it('writes the cache file after a successful fetch', async () => {
    await loadSteamAppList({ fetch: fakeFetchOk(), cachePath });
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    expect(cached.applist.apps.length).toBe(5);
  });

  it('returns from cache without refetching when within TTL', async () => {
    await writeFile(cachePath, JSON.stringify(fixtureBody));
    let calls = 0;
    const wrapped: typeof fetch = async () => { calls++; return fakeFetchOk()(); };
    const now = () => Date.now();
    const m = await loadSteamAppList({ fetch: wrapped, cachePath, now });
    expect(calls).toBe(0);
    expect(m.get('elden ring')).toBe(1245620);
  });

  it('refreshes after TTL elapses', async () => {
    await writeFile(cachePath, JSON.stringify(fixtureBody));
    let calls = 0;
    const wrapped: typeof fetch = async () => { calls++; return fakeFetchOk()(); };
    const farFuture = () => Date.now() + 48 * 60 * 60 * 1000;
    await loadSteamAppList({ fetch: wrapped, cachePath, now: farFuture });
    expect(calls).toBe(1);
  });

  it('returns empty map on fetch failure (graceful degradation)', async () => {
    const m = await loadSteamAppList({ fetch: fakeFetchFail(), cachePath });
    expect(m.size).toBe(0);
  });
});
