// The catalog entry for an installed game: matched by Steam app id first, then
// by name key. The Library page and the agent's list_installed_games share it,
// so "has a trainer" means the same thing in both.
import { gameKey } from './game-key.js';
import type { DetectedGame } from './ipc.js';

export interface MatchableEntry { name: string; steamAppId?: number | null | undefined }

/** The installed game's Steam app id, from its Steam source or its boxart match. */
export function installedSteamAppId(g: DetectedGame): number | null {
  const id = g.boxartSteamAppId ?? (g.source === 'steam' ? Number(g.appId) : NaN);
  return Number.isInteger(id) ? id : null;
}

/** Indexes catalog entries once, then looks up installed games against them. */
export function catalogMatcher<E extends MatchableEntry>(entries: readonly E[]): (g: DetectedGame) => E | undefined {
  const byId = new Map<number, E>();
  const byName = new Map<string, E>();
  for (const e of entries) {
    if (e.steamAppId != null && !byId.has(e.steamAppId)) byId.set(e.steamAppId, e);
    const k = gameKey(e.name);
    if (k && !byName.has(k)) byName.set(k, e);
  }
  return (g) => {
    const id = installedSteamAppId(g);
    return (id != null ? byId.get(id) : undefined) ?? byName.get(gameKey(g.name));
  };
}
