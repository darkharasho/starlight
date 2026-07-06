// apps/desktop/test/main/game-matcher.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeName, matchGameToProcess, identifyProcess, buildCatalogIndex } from '../../src/main/game-matcher.js';

const g = (over = {}) => ({ id: '9-kings', name: '9 Kings', steamAppId: null, ...over });
const proc = (pid: number, name: string) => ({ pid, name });
const lib = (over = {}) => ({ source: 'steam' as const, appId: '2784470', name: '9 Kings', installDir: '/games/9 Kings', ...over });

describe('normalizeName', () => {
  it('strips case, spaces, punctuation and .exe', () => {
    expect(normalizeName('9 Kings')).toBe('9kings');
    expect(normalizeName('9Kings.exe')).toBe('9kings');
    expect(normalizeName('Elden Ring™')).toBe('eldenring');
  });
});

describe('matchGameToProcess', () => {
  const readExeNames = async () => ['9Kings.exe', 'crashhandler.exe'];
  const noAppId = async () => null;

  it('layer 1: matches by install-dir exe name (exact even if title differs)', async () => {
    const r = await matchGameToProcess(g({ name: 'Nine Kings' }), {
      processes: [proc(10, 'other.exe'), proc(20, '9Kings.exe')],
      detectedGames: [lib({ name: 'Nine Kings' })],
      readExeNames, readProtonAppId: noAppId,
    });
    expect(r).toEqual({ pid: 20, name: '9Kings.exe' });
  });

  it('layer 2: matches by Proton compatdata appid when name/exe do not', async () => {
    const r = await matchGameToProcess(g({ steamAppId: 2784470 }), {
      processes: [proc(10, 'launcher.exe'), proc(30, 'Game.exe')],
      detectedGames: [],
      readExeNames, readProtonAppId: async (pid) => (pid === 30 ? 2784470 : null),
    });
    expect(r).toEqual({ pid: 30, name: 'Game.exe' });
  });

  it('appid via linked install: matches a Proton game whose catalog steamAppId is null and whose process name is comm-truncated, ignoring wrapper processes sharing the compatdata', async () => {
    const r = await matchGameToProcess(
      { id: 'runescape-dragonwilds', name: 'RuneScape Dragonwilds', steamAppId: null },
      {
        processes: [proc(1, 'reaper'), proc(2, 'RSDragonwilds.e'), proc(3, 'pv-adverb')],
        detectedGames: [{ source: 'steam', appId: '1374490', name: 'RuneScape: Dragonwilds', installDir: '/g' }],
        readExeNames: async () => ['RSDragonwilds.exe'],
        // reaper + pv-adverb share the same compatdata appid but are not exes.
        readProtonAppId: async () => 1374490,
      },
    );
    expect(r).toEqual({ pid: 2, name: 'RSDragonwilds.e' });
  });

  it('layer 3: matches by normalized name', async () => {
    const r = await matchGameToProcess(g(), {
      processes: [proc(40, '9Kings.exe')],
      detectedGames: [],
      readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toEqual({ pid: 40, name: '9Kings.exe' });
  });

  it('returns "ambiguous" when a layer yields >1 process', async () => {
    const r = await matchGameToProcess(g(), {
      processes: [proc(1, '9Kings.exe'), proc(2, '9Kings.exe')],
      detectedGames: [], readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toBe('ambiguous');
  });

  it('returns null when nothing matches', async () => {
    const r = await matchGameToProcess(g(), {
      processes: [proc(1, 'unrelated.exe')],
      detectedGames: [], readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toBeNull();
  });

  it('does not name-match titles under 3 normalized chars', async () => {
    const r = await matchGameToProcess(g({ name: 'Go' }), {
      processes: [proc(1, 'Go.exe')],
      detectedGames: [], readExeNames: async () => [], readProtonAppId: noAppId,
    });
    expect(r).toBeNull();
  });
});

describe('identifyProcess', () => {
  const entry = (over = {}) => ({ id: '9-kings', name: '9 Kings', steamAppId: null, trainerSource: 'http://x', ...over });
  const index = new Map([['9kings', entry()]]);

  it('identifies a process by normalized name against the catalog index', async () => {
    const r = await identifyProcess({ pid: 5, name: '9Kings.exe' }, {
      catalogIndex: index, detectedGames: [], readProtonAppId: async () => null,
    });
    expect(r?.id).toBe('9-kings');
  });

  it('identifies by Proton appid -> Steam game -> catalog name', async () => {
    const r = await identifyProcess({ pid: 5, name: 'Game.exe' }, {
      catalogIndex: index,
      detectedGames: [{ source: 'steam', appId: '2784470', name: '9 Kings', installDir: '/g' }],
      readProtonAppId: async () => 2784470,
    });
    expect(r?.id).toBe('9-kings');
  });

  it('returns null when the process maps to no trainer-bearing entry', async () => {
    const r = await identifyProcess({ pid: 5, name: 'random.exe' }, {
      catalogIndex: index, detectedGames: [], readProtonAppId: async () => null,
    });
    expect(r).toBeNull();
  });
});

describe('buildCatalogIndex', () => {
  it('indexes only trainer-bearing entries by normalized name', () => {
    const idx = buildCatalogIndex([
      { id: 'a', name: '9 Kings', steamAppId: null, trainerSource: 'http://x' },
      { id: 'b', name: 'No Trainer', steamAppId: null },            // excluded
      { id: 'c', name: 'Go', steamAppId: null, trainerSource: 'http://y' }, // excluded: <3
    ]);
    expect(idx.get('9kings')?.id).toBe('a');
    expect(idx.has('notrainer')).toBe(false);
    expect(idx.has('go')).toBe(false);
  });

  it('keeps the first entry on a normalized-name collision', () => {
    const idx = buildCatalogIndex([
      { id: 'first', name: 'Game X', steamAppId: null, trainerSource: 'http://x' },
      { id: 'second', name: 'gamex', steamAppId: null, trainerSource: 'http://y' },
    ]);
    expect(idx.get('gamex')?.id).toBe('first');
  });
});
