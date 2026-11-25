import { describe, it, expect } from 'vitest';
import { isMyGameEntry, myGameMatcher, withMyGames } from '../../src/shared/my-games.js';
import type { CatalogIndexEntry, UserCheatGame } from '../../src/shared/ipc.js';

const cat = (id: string, name: string, steamAppId: number | null): CatalogIndexEntry => ({
  id, name, steamAppId, processName: [], platform: ['windows'], trainerSource: `https://example.com/${id}`,
});
const mine = (key: string, name: string, steamAppId: number | null, proton = true): UserCheatGame => ({
  key, name, steamAppId, processName: [`${name}.exe`], proton, cheats: 1,
});

describe('withMyGames', () => {
  it('adds games only the player has cheats for, first, and skips ones the catalog has', () => {
    const catalog = [cat('9-kings', '9 Kings', 2162800), cat('hades', 'Hades', null)];
    const out = withMyGames(catalog, [
      mine('bambooroninthelastcut', 'Bamboo Ronin: The Last Cut', 5399320),
      mine('ninekings', 'Nine Kings', 2162800), // same Steam id as a catalog game
      mine('hades', 'HADES', null), // same name key
      mine('native', 'Native', null, false),
    ]);
    expect(out.map((e) => e.id)).toEqual(['mine-bambooroninthelastcut', 'mine-native', '9-kings', 'hades']);
    expect(out[0]).toEqual({
      id: 'mine-bambooroninthelastcut', name: 'Bamboo Ronin: The Last Cut', steamAppId: 5399320,
      processName: ['Bamboo Ronin: The Last Cut.exe'], platform: ['windows'],
    });
    expect(out[1]!.platform).toEqual(['linux']);
    expect(isMyGameEntry(out[0]!)).toBe(true);
    expect(isMyGameEntry(out[2]!)).toBe(false);
  });

  it('returns the catalog as is when the player has no cheats', () => {
    const catalog = [cat('a', 'A', 1)];
    expect(withMyGames(catalog, [])).toBe(catalog);
  });
});

describe('myGameMatcher', () => {
  it('matches by Steam id, then by name', () => {
    const find = myGameMatcher([mine('k', 'Bamboo Ronin: The Last Cut', 5399320)]);
    expect(find({ name: 'Bamboo Ronin', steamAppId: 5399320 })?.key).toBe('k');
    expect(find({ name: 'bamboo ronin the last cut' })?.key).toBe('k');
    expect(find({ name: 'Other', steamAppId: 1 })).toBeUndefined();
  });
});
