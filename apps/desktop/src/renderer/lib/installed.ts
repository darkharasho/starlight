import type { DetectedGame, LaunchTarget } from '../../shared/ipc.js';
import { useLibraryStore } from '../stores/library-store.js';
import { gameKey } from './dedupe-games.js';

/**
 * The installed copy of a game, if the library scan found one — what Play
 * starts. Matched by Steam id when known, else by name.
 */
export function launchTargetFor(game: { name: string; steamAppId?: number | null | undefined }): LaunchTarget | undefined {
  const games = useLibraryStore.getState().games;
  const key = gameKey(game.name);
  const hit =
    (game.steamAppId != null ? games.find((g) => g.source === 'steam' && g.appId === String(game.steamAppId)) : undefined)
    ?? games.find((g) => gameKey(g.name) === key);
  return hit ? { source: hit.source, appId: hit.appId } : undefined;
}

/**
 * Game keys of everything the library scan found. The catalog is built from
 * forum threads and carries no Steam app ids, so installed games are matched
 * to catalog entries by normalized name.
 */
export function installedGameKeys(games: DetectedGame[]): Set<string> {
  const keys = new Set<string>();
  for (const g of games) {
    const k = gameKey(g.name);
    if (k) keys.add(k);
  }
  return keys;
}
