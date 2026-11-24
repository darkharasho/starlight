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
 * Keys of everything the library scan found: each game's name key, plus
 * `steam:<appid>` for Steam games, so catalog entries match by id first.
 */
export function installedGameKeys(games: DetectedGame[]): Set<string> {
  const keys = new Set<string>();
  for (const g of games) {
    const k = gameKey(g.name);
    if (k) keys.add(k);
    const id = g.source === 'steam' ? g.appId : g.boxartSteamAppId != null ? String(g.boxartSteamAppId) : null;
    if (id && /^\d+$/.test(id)) keys.add(`steam:${id}`);
  }
  return keys;
}

/** Whether a catalog entry is installed, given `installedGameKeys`. */
export function isInstalled(keys: Set<string>, entry: { name: string; steamAppId?: number | null }): boolean {
  return (entry.steamAppId != null && keys.has(`steam:${entry.steamAppId}`)) || keys.has(gameKey(entry.name));
}
