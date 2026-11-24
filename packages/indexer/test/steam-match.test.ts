import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pickMatch, resolveSteamIds, readMatchCache } from '../src/steam-match.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sl-steam-match-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('pickMatch', () => {
  it('takes the app whose name agrees, skipping soundtracks and DLC', () => {
    const items = [
      { type: 'app', id: 2, name: '7 Days to Die - Soundtrack' },
      { type: 'app', id: 1, name: '7 Days to Die' },
    ];
    expect(pickMatch('7 Days To Die', items)).toEqual({ id: 1, name: '7 Days to Die' });
  });
  it('does not fall back to the first result', () => {
    expect(pickMatch('Some Homebrew Thing', [{ type: 'app', id: 9, name: 'Something Else' }])).toBeNull();
  });
});

function fakeFetch(db: Record<string, Array<{ id: number; name: string }>>, calls: string[]): typeof fetch {
  return (async (u: string) => {
    const term = new URL(u).searchParams.get('term')!;
    calls.push(term);
    const items = (db[term] ?? []).map((x) => ({ type: 'app', ...x }));
    return new Response(JSON.stringify({ total: items.length, items }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('resolveSteamIds', () => {
  it('searches each title once, caches hits and misses, and reuses the cache', async () => {
    const cachePath = join(dir, 'steam-ids.json');
    const calls: string[] = [];
    const db = { 'Cyberpunk 2077': [{ id: 1091500, name: 'Cyberpunk 2077' }] };
    const out = await resolveSteamIds(['Cyberpunk 2077', 'Cyberpunk 2077', 'Homebrew'], { cachePath, fetch: fakeFetch(db, calls), sleepMs: 0 });
    expect(out.get('Cyberpunk 2077')).toEqual({ id: 1091500, name: 'Cyberpunk 2077' });
    expect(out.has('Homebrew')).toBe(false);
    expect(calls).toEqual(['Cyberpunk 2077', 'Homebrew']);
    const cache = await readMatchCache(cachePath);
    expect(cache['homebrew']!.hit).toBeNull();

    const again: string[] = [];
    const out2 = await resolveSteamIds(['Cyberpunk 2077', 'Homebrew'], { cachePath, fetch: fakeFetch(db, again), sleepMs: 0 });
    expect(again).toEqual([]);
    expect(out2.size).toBe(1);

    // A title gone from the catalog drops out of the file.
    await resolveSteamIds(['Cyberpunk 2077'], { cachePath, fetch: fakeFetch(db, again), sleepMs: 0 });
    expect(Object.keys(await readMatchCache(cachePath))).toEqual(['cyberpunk 2077']);
  });

  it('retries a miss after 30 days and leaves failed searches uncached', async () => {
    const cachePath = join(dir, 'steam-ids.json');
    const calls: string[] = [];
    let t = Date.parse('2026-01-01');
    await resolveSteamIds(['Homebrew'], { cachePath, fetch: fakeFetch({}, calls), sleepMs: 0, now: () => t });
    t += 31 * 86_400_000;
    await resolveSteamIds(['Homebrew'], { cachePath, fetch: fakeFetch({}, calls), sleepMs: 0, now: () => t });
    expect(calls).toEqual(['Homebrew', 'Homebrew']);

    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await resolveSteamIds(['Other'], { cachePath, fetch: failing, sleepMs: 0 });
    expect(JSON.parse(await readFile(cachePath, 'utf8'))['other']).toBeUndefined();
  });
});
