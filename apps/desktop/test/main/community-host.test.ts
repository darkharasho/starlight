import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareHash, type CommunityCheatFile } from '@starlight/ct-importer';
import type { CommunityIndex } from '@starlight/catalog/community';
import {
  createCommunityHost, pickCommunityCheats, communityKey, isCommunityKey, saveCommunityCheat,
} from '../../src/main/community-host.js';
import { trainerForEntry } from '../../src/main/catalog-host.js';
import { buildCatalogIndex, identifyProcess } from '../../src/main/game-matcher.js';
import { createUserCheatsHost } from '../../src/main/user-cheats-host.js';
import { loadUserTrainer } from '../../src/main/user-cheats.js';

let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); dirs = []; });
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'ch-')); dirs.push(d); return d; };

type Meta = CommunityIndex['games'][number]['cheats'][number];
const meta = (over: Partial<Meta>): Meta => ({
  file: '1/x.json', hash: 'aaaaaaaaaaaa', name: 'Gold', platform: 'windows', bits: 64, submittedAt: '2026-01-01', ...over,
});

describe('pickCommunityCheats', () => {
  const v100 = meta({ hash: '100100100100', buildId: '100', submittedAt: '2026-01-01' });
  const v200 = meta({ hash: '200200200200', buildId: '200', submittedAt: '2026-02-01' });
  const v300 = meta({ hash: '300300300300', buildId: '300', submittedAt: '2026-03-01' });

  it('pick_prefers_matching_build_then_newest', () => {
    const r = pickCommunityCheats([v100, v300, v200], { platform: null, bits: null, buildId: '200' });
    expect(r.current.map((c) => c.buildId)).toEqual(['200']);
    expect(r.older.map((c) => c.buildId)).toEqual(['300', '100']);
    const none = pickCommunityCheats([v100, v300, v200], { platform: null, bits: null, buildId: '999' });
    expect(none.current.map((c) => c.buildId)).toEqual(['300']);
    expect(none.older.map((c) => c.buildId)).toEqual(['200', '100']);
  });

  it('pick_filters_platform_and_bits', () => {
    const lin = meta({ hash: 'bbbbbbbbbbbb', platform: 'linux' });
    const b32 = meta({ hash: 'cccccccccccc', bits: 32 });
    const win64 = meta({ hash: 'dddddddddddd' });
    const r = pickCommunityCheats([lin, b32, win64], { platform: 'windows', bits: 64, buildId: null });
    expect(r.current.map((c) => c.hash)).toEqual(['dddddddddddd']);
    expect(r.older).toEqual([]);
    const all = pickCommunityCheats([lin, b32, win64], { platform: null, bits: null, buildId: null });
    expect(all.current.map((c) => c.hash).sort()).toEqual(['bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd']);
  });

  it('different cheat names are separate groups', () => {
    const r = pickCommunityCheats([meta({ name: 'Gold' }), meta({ name: 'Health', hash: 'eeeeeeeeeeee' })], { platform: null, bits: null, buildId: null });
    expect(r.current).toHaveLength(2);
  });
});

describe('community keys', () => {
  it('round-trip', () => {
    expect(communityKey(1234)).toBe('community-1234');
    expect(isCommunityKey('community-1234')).toBe(true);
    expect(isCommunityKey('eldenring')).toBe(false);
  });
});

describe('catalog entries', () => {
  it('community_only_entry_loads_no_trainer', async () => {
    const fetchTrainer = vi.fn();
    const fetchTrainerLive = vi.fn();
    const entry = { id: 'new-game', name: 'New Game', steamAppId: 1234, processName: [], platform: ['windows' as const], communityOnly: true };
    expect(await trainerForEntry(entry, { fetchTrainer, fetchTrainerLive })).toBeNull();
    expect(fetchTrainer).not.toHaveBeenCalled();
    expect(fetchTrainerLive).not.toHaveBeenCalled();
  });

  it('matcher_indexes_community_only', async () => {
    const idx = buildCatalogIndex([{ id: 'new-game', name: 'New Game', steamAppId: 1234, communityOnly: true }]);
    const hit = await identifyProcess({ pid: 1, name: 'NewGame.exe' } as never, { catalogIndex: idx, detectedGames: [], readProtonAppId: async () => null });
    expect(hit?.id).toBe('new-game');
  });
});

async function communityFixture() {
  const file: CommunityCheatFile = {
    schemaVersion: 1,
    cheat: {
      name: 'Infinite gold', type: 'freeze', valueType: 'int32', value: 9999,
      address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x10', offsets: ['0x8'] },
      verify: { range: { min: 0, max: 9999 } },
    },
    game: { steamAppId: 1234, name: 'New Game', platform: 'windows', bits: 64, buildId: '555' },
    credit: 'Mika',
    submittedAt: '2026-11-25',
  } as CommunityCheatFile;
  const hash = (await shareHash(file)).slice(0, 12);
  const index: CommunityIndex = {
    schemaVersion: 1, generatedAt: '2026-11-26T00:00:00.000Z',
    games: [{ steamAppId: 1234, name: 'New Game', cheats: [meta({ file: `1234/${hash}.json`, hash, name: 'Infinite gold', buildId: '555', submittedAt: '2026-11-25', credit: 'Mika' })] }],
  };
  let offline = false;
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    if (offline) throw new TypeError('fetch failed');
    const u = String(url);
    if (u.endsWith('community/index.json')) return new Response(JSON.stringify(index));
    if (u.endsWith(`community/1234/${hash}.json`)) return new Response(JSON.stringify(file));
    return new Response('', { status: 404 });
  });
  const cacheDir = await tmp();
  const host = createCommunityHost({ cacheDir, baseUrl: 'https://cat.test/catalog/', fetch: fetchFn as unknown as typeof fetch, minRefreshMs: 0 });
  return { file, hash, index, host, fetchFn, cacheDir, goOffline: () => { offline = true; } };
}

describe('community host', () => {
  it('builds a trainer of community cheats with meta', async () => {
    const c = await communityFixture();
    const r = await c.host.trainer(1234, { platform: 'windows', bits: 64, buildId: '555' });
    const cheat = r!.trainer.categories[0]!.cheats[0]!;
    expect(r!.trainer.categories[0]!.name).toBe('Community');
    expect(cheat.id).toBe(`c-${c.hash}`);
    expect((cheat as { provenance?: { derivedFrom?: string; bits?: number } }).provenance).toMatchObject({ derivedFrom: c.hash, bits: 64, kind: 'manual' });
    expect(r!.meta.get(`c-${c.hash}`)).toEqual({ credit: 'Mika', buildId: '555', platform: 'windows', bits: 64, older: false });
    expect(await c.host.trainer(999, { platform: null, bits: null, buildId: null })).toBeNull();
  });

  it('index_is_cached_offline', async () => {
    const c = await communityFixture();
    expect((await c.host.index()).games).toHaveLength(1);
    await c.host.trainer(1234, { platform: null, bits: null, buildId: null }); // seen once online
    c.goOffline();
    const again = createCommunityHost({ cacheDir: c.cacheDir, baseUrl: 'https://cat.test/catalog/', fetch: c.fetchFn as unknown as typeof fetch, minRefreshMs: 0 });
    expect((await again.index()).games).toHaveLength(1);
    expect((await again.trainer(1234, { platform: null, bits: null, buildId: null }))!.trainer.categories[0]!.cheats).toHaveLength(1);
  });

  it('host_lists_and_refuses_remove', async () => {
    const c = await communityFixture();
    const dir = await tmp();
    const host = createUserCheatsHost({
      dir, getClient: async () => { throw new Error('no engine'); },
      owner: { ownerOf: () => null, hold: () => () => undefined } as never,
      loadTrainer: async (key, pid) => (isCommunityKey(key) ? c.host.trainer(Number(key.slice('community-'.length)), { platform: null, bits: null, buildId: null }) : null),
    });
    const views = await host.list(communityKey(1234), null);
    expect(views).toHaveLength(1);
    expect(views[0]!.cheat.id).toBe(`c-${c.hash}`);
    expect(views[0]!.community).toEqual({ credit: 'Mika', buildId: '555', platform: 'windows', bits: 64, older: false });
    expect(await host.remove(communityKey(1234), `c-${c.hash}`)).toEqual({ ok: false, error: "Community cheats can't be deleted here." });
  });

  it('save_to_my_cheats_marks_derived', async () => {
    const c = await communityFixture();
    const dir = await tmp();
    const r = await saveCommunityCheat({ dir, community: c.host }, { key: communityKey(1234), id: `c-${c.hash}`, userKey: 'newgame', exeName: 'NewGame.exe' });
    expect(r).toEqual({ ok: true });
    const t = await loadUserTrainer(dir, 'newgame');
    const saved = t!.categories[0]!.cheats[0]! as { name: string; provenance: { kind: string; derivedFrom: string } };
    expect(saved.name).toBe('Infinite gold');
    expect(saved.provenance.kind).toBe('manual');
    expect(saved.provenance.derivedFrom).toBe(c.hash);
    expect(t!.game.platform).toEqual(['linux-proton']);
    expect(await saveCommunityCheat({ dir, community: c.host }, { key: communityKey(1234), id: 'c-nope', userKey: 'newgame' })).toEqual({ ok: false, error: 'That community cheat is no longer available.' });
  });
});
