import { describe, it, expect } from 'vitest';
import { shareHash, shareSummary, shareFlags, type CommunityCheatFile } from '@starlight/ct-importer';
import { buildCommunity, checkCommunityPr } from '../src/community.js';
import type { CatalogIndex } from '../src/schema.js';

function file(appId: number, name: string, over: Partial<CommunityCheatFile> = {}): CommunityCheatFile {
  return {
    schemaVersion: 1,
    cheat: {
      name, type: 'freeze', valueType: 'int32', value: 9999,
      address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x10', offsets: ['0x8'] },
      verify: { range: { min: 0, max: 9999 } },
    },
    game: { steamAppId: appId, name: appId === 99 ? 'Old Game' : 'New Game', platform: 'windows', bits: 64, buildId: '555' },
    submittedAt: '2026-11-25',
    ...over,
  } as CommunityCheatFile;
}
async function entry(f: CommunityCheatFile, o: { folder?: number; name?: string } = {}) {
  const h = (await shareHash(f)).slice(0, 12);
  return { path: `${o.folder ?? f.game.steamAppId}/${o.name ?? h}.json`, text: JSON.stringify(f, null, 2), hash: h };
}
const CATALOG: CatalogIndex = {
  schemaVersion: 1, generatedAt: '2026-11-01T00:00:00.000Z',
  games: [
    { id: 'old-game', name: 'Old Game', steamAppId: 99, processName: [], platform: ['windows'], trainerSource: 'https://fearlessrevolution.com/viewtopic.php?t=1' },
    { id: 'new-game', name: 'Another game that took the slug', steamAppId: 5, processName: [], platform: ['windows'] },
  ],
};
const NOW = new Date('2026-11-26T00:00:00.000Z');

describe('buildCommunity', () => {
  it('builds_index_and_adds_new_games', async () => {
    const a = await entry(file(1234, 'Gold'));
    const b = await entry(file(1234, 'Health', { credit: 'Mika' }));
    const c = await entry(file(99, 'Ammo', { game: { steamAppId: 99, name: 'Old Game', platform: 'linux', bits: 32 } }));
    const r = await buildCommunity([a, b, c], CATALOG, NOW);
    expect(r.errors).toEqual([]);
    expect(r.index.schemaVersion).toBe(1);
    expect(r.index.games.map((g) => g.steamAppId)).toEqual([99, 1234]);
    const g1234 = r.index.games.find((g) => g.steamAppId === 1234)!;
    expect(g1234.name).toBe('New Game');
    expect(g1234.cheats).toHaveLength(2);
    expect(g1234.cheats.find((x) => x.name === 'Health')).toEqual({
      file: `1234/${b.hash}.json`, hash: b.hash, name: 'Health', platform: 'windows', bits: 64, buildId: '555', submittedAt: '2026-11-25', credit: 'Mika',
    });
    const added = r.catalog.games.filter((g) => g.communityOnly);
    expect(added).toEqual([{ id: 'new-game-2', name: 'New Game', steamAppId: 1234, processName: [], platform: ['windows'], communityOnly: true }]);
    expect(r.catalog.games.find((g) => g.steamAppId === 99)).toEqual(CATALOG.games[0]);
    expect(r.catalog.games).toHaveLength(3);
  });

  it('platforms of a new game cover all its cheats', async () => {
    const a = await entry(file(7, 'A'));
    const b = await entry(file(7, 'B', { game: { steamAppId: 7, name: 'N', platform: 'linux', bits: 64 } }));
    const r = await buildCommunity([a, b], { ...CATALOG, games: [] }, NOW);
    expect(r.catalog.games[0]!.platform).toEqual(['windows', 'linux']);
  });

  it('skips_bad_files', async () => {
    const good = await entry(file(1234, 'Gold'));
    const wrongHash = await entry(file(1234, 'Other'), { name: 'aaaaaaaaaaaa' });
    const wrongFolder = await entry(file(1234, 'Third'), { folder: 4321 });
    const bad = file(1234, 'Bad');
    (bad.cheat as any).address = { kind: 'absolute', address: '0x1' }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const badRule = { path: '1234/bbbbbbbbbbbb.json', text: JSON.stringify(bad) };
    const notJson = { path: '1234/cccccccccccc.json', text: '{' };
    const r = await buildCommunity([good, wrongHash, wrongFolder, badRule, notJson], CATALOG, NOW);
    expect(r.index.games.flatMap((g) => g.cheats).map((c) => c.name)).toEqual(['Gold']);
    expect(r.errors).toHaveLength(4);
    for (const p of [wrongHash.path, wrongFolder.path, badRule.path, notJson.path]) {
      expect(r.errors.some((e) => e.startsWith(p))).toBe(true);
    }
  });
});

describe('checkCommunityPr', () => {
  async function pr(f: CommunityCheatFile) {
    const e = await entry(f);
    const path = `packages/catalog/community/${e.path}`;
    const body = `<!-- starlight-summary -->\n${shareSummary(f, shareFlags(f))}\n<!-- /starlight-summary -->`;
    return { path, text: e.text, body };
  }

  it('pr_check_rules', async () => {
    const p = await pr(file(1234, 'Gold'));
    const files = new Map([[p.path, p.text]]);
    expect(await checkCommunityPr([{ status: 'A', path: p.path }], files, p.body)).toEqual([]);
    expect((await checkCommunityPr([{ status: 'A', path: p.path }, { status: 'A', path: 'packages/catalog/community/1/x.json' }], files, p.body)).length).toBeGreaterThan(0);
    expect((await checkCommunityPr([{ status: 'M', path: p.path }], files, p.body)).length).toBeGreaterThan(0);
    expect((await checkCommunityPr([{ status: 'A', path: 'packages/catalog/index.json' }], new Map([['packages/catalog/index.json', '{}']]), p.body)).length).toBeGreaterThan(0);
    const changed = await checkCommunityPr([{ status: 'A', path: p.path }], files, p.body.replace('Gold', 'Silver'));
    expect(changed.some((e) => /summary/.test(e))).toBe(true);
    expect((await checkCommunityPr([{ status: 'A', path: p.path }], files, 'no markers')).some((e) => /summary/.test(e))).toBe(true);
  });

  it('a pull request that also touches a file outside the folder fails', async () => {
    const p = await pr(file(1234, 'Gold'));
    const files = new Map([[p.path, p.text]]);
    const r = await checkCommunityPr([{ status: 'A', path: p.path }, { status: 'M', path: '.github/workflows/ci.yml' }], files, p.body);
    expect(r.length).toBeGreaterThan(0);
  });
});
