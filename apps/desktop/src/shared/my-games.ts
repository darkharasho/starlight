import type { CatalogIndexEntry, UserCheatGame } from './ipc.js';
import { gameKey } from './game-key.js';

/** The id prefix of a catalog-shaped entry made for a game only the player's library has. */
export const MY_GAME_PREFIX = 'mine-';

export function isMyGameEntry(entry: { id?: string | undefined }): boolean {
  return typeof entry.id === 'string' && entry.id.startsWith(MY_GAME_PREFIX);
}

/** Finds the player's own-cheats game for a game, by Steam id first, then by name. */
export function myGameMatcher(mine: UserCheatGame[]): (g: { name: string; steamAppId?: number | null }) => UserCheatGame | undefined {
  const bySteam = new Map<number, UserCheatGame>();
  const byKey = new Map<string, UserCheatGame>();
  for (const m of mine) {
    if (m.steamAppId != null) bySteam.set(m.steamAppId, m);
    byKey.set(gameKey(m.name), m);
  }
  return (g) => (g.steamAppId != null ? bySteam.get(g.steamAppId) : undefined) ?? byKey.get(gameKey(g.name));
}

/**
 * The catalog plus a catalog-shaped entry for every game the player made cheats
 * for that the catalog doesn't have, so it can be found and opened like any other.
 * Those entries have no table source; opening one shows the game page with "My cheats".
 */
export function withMyGames(catalog: CatalogIndexEntry[], mine: UserCheatGame[]): CatalogIndexEntry[] {
  if (mine.length === 0) return catalog;
  const steam = new Set<number>();
  const keys = new Set<string>();
  for (const e of catalog) {
    if (e.steamAppId != null) steam.add(e.steamAppId);
    keys.add(gameKey(e.name));
  }
  const extra: CatalogIndexEntry[] = mine
    .filter((m) => !(m.steamAppId != null && steam.has(m.steamAppId)) && !keys.has(gameKey(m.name)))
    .map((m) => ({
      id: `${MY_GAME_PREFIX}${m.key}`,
      name: m.name,
      steamAppId: m.steamAppId,
      processName: m.processName,
      platform: [m.proton ? 'windows' : 'linux'],
    }));
  return extra.length === 0 ? catalog : [...extra, ...catalog];
}
