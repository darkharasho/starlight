import { describe, it, expect, beforeEach } from 'vitest';
import { sessionRequestFor, findCatalogEntry, attachRequestFor } from '../../src/renderer/lib/open-game.js';
import { installedGameKeys, launchTargetFor } from '../../src/renderer/lib/installed.js';
import { useLibraryStore } from '../../src/renderer/stores/library-store.js';
import { gameKey } from '../../src/renderer/lib/dedupe-games.js';
import { useCatalogStore } from '../../src/renderer/stores/catalog-store.js';

const entry = (id: string, name: string, t: number) => ({
  id, name, steamAppId: null, processName: [], platform: ['windows' as const],
  trainerSource: `https://fearlessrevolution.com/viewtopic.php?f=4&t=${t}`,
});

beforeEach(() => {
  useCatalogStore.setState({
    index: { schemaVersion: 1, generatedAt: 'x', games: [entry('9-kings', '9 Kings', 1)] },
    tableSources: new Map([['9kings', [entry('', '', 1).trainerSource, entry('', '', 2).trainerSource]]]),
  });
  useLibraryStore.setState({ games: [
    { source: 'steam', appId: '2784470', name: '9 Kings', installDir: '/x' },
    { source: 'heroic', appId: 'Quail', name: 'Other: Game', installDir: '/y' },
  ] });
});

describe('launchTargetFor', () => {
  it('finds the installed copy by name, or by Steam id when the titles differ', () => {
    expect(launchTargetFor({ name: '9 kings' })).toEqual({ source: 'steam', appId: '2784470' });
    expect(launchTargetFor({ name: 'Nine Kings (Early Access)', steamAppId: 2784470 })).toEqual({ source: 'steam', appId: '2784470' });
    expect(launchTargetFor({ name: 'Other Game' })).toEqual({ source: 'heroic', appId: 'Quail' });
    expect(launchTargetFor({ name: 'Not Installed' })).toBeUndefined();
  });
});

describe('sessionRequestFor', () => {
  it('offers every thread the catalog has for the game, keyed by the game', () => {
    const req = sessionRequestFor(entry('9-kings', '9 Kings', 1));
    expect(req.sources).toEqual([entry('', '', 1).trainerSource, entry('', '', 2).trainerSource]);
    expect(req.cacheKey).toBe('9kings');
    expect(req.title).toBe('9 Kings');
    expect(req.pid).toBeUndefined();
    expect(req.launch).toEqual({ source: 'steam', appId: '2784470' });   // what Play starts
    expect(req.tableId).toBeUndefined();                                 // Starlight picks the table
  });
  it('the same game opened via a different title variant shares the key (so the table choice sticks)', () => {
    expect(sessionRequestFor(entry('9kings', '9kings', 2)).cacheKey).toBe('9kings');
  });
  it('carries an explicit process target', () => {
    expect(sessionRequestFor(entry('9-kings', '9 Kings', 1), { pid: 5, processName: '9Kings.exe' })).toMatchObject({ pid: 5, processName: '9Kings.exe' });
  });
});

describe('findCatalogEntry', () => {
  it('falls back to the game key when main matched a different title variant', () => {
    expect(findCatalogEntry({ id: '9kings', name: '9kings' })?.id).toBe('9-kings');
    expect(findCatalogEntry({ id: 'nope', name: 'Unknown Game' })).toBeUndefined();
  });
});

describe('installedGameKeys', () => {
  it('matches installed games to catalog titles by normalized name', () => {
    const keys = installedGameKeys([
      { source: 'steam', appId: '1', name: "Baldur's Gate 3", installDir: '/x' },
      { source: 'steam', appId: '2', name: 'PEAK', installDir: '/y' },
    ]);
    expect(keys.has(gameKey('Baldurs Gate 3'))).toBe(true);
    expect(keys.has(gameKey('Peak'))).toBe(true);
    expect(keys.has(gameKey('Palworld'))).toBe(false);
  });
});

describe('attachRequestFor', () => {
  const target = { pid: 7, processName: 'NewGame.exe' };
  it('a community-only game attaches tools-only, with its Steam id so the Community group shows', () => {
    const community = { id: 'new-game', name: 'New Game', steamAppId: 1234, processName: [], platform: ['windows' as const], communityOnly: true };
    const req = attachRequestFor(community, target)!;
    expect(req.sources).toEqual([]);
    expect(req.game).toMatchObject({ name: 'New Game', steamAppId: 1234 });
    expect(req).toMatchObject({ pid: 7, processName: 'NewGame.exe' });
  });
  it('a game with tables uses its tables', () => {
    const e = entry('9-kings', '9 Kings', 1);
    expect(attachRequestFor(e, target)).toEqual(sessionRequestFor(e, target));
  });
  it('an entry with neither has nothing to attach', () => {
    expect(attachRequestFor({ id: 'x', name: 'X', steamAppId: null, processName: [], platform: ['windows'] }, target)).toBeNull();
  });
});
