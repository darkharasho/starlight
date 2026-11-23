import type { NavigateFunction } from 'react-router-dom';
import type { CatalogIndexEntry } from '../../shared/ipc.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useCeSessionStore, type StartReq } from '../stores/ce-session-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import type { LaunchTarget } from '../../shared/ipc.js';
import { gameKey } from './dedupe-games.js';
import { launchTargetFor } from './installed.js';

/**
 * Shows the game screen. Replaces the history entry instead of pushing when
 * it's already showing (a session start also opens it), so one Back click
 * always leaves it. The app uses HashRouter, so the hash is the route.
 */
export function showGameScreen(navigate: NavigateFunction): void {
  const here = window.location.hash.replace(/^#/, '').split('?')[0];
  navigate('/active', here === '/active' ? { replace: true } : undefined);
}

type GameIdentity = { id: string; name: string; steamAppId?: number | null };

/**
 * Builds the session request for a catalog game: every thread known for it
 * (the entry's own first), keyed by the game — not the catalog row — so the
 * remembered table choice follows the game whichever screen it's opened from.
 */
export function sessionRequestFor(
  entry: Pick<CatalogIndexEntry, 'id' | 'name' | 'steamAppId' | 'trainerSource'>,
  target?: { pid: number; processName?: string | undefined },
  launch?: LaunchTarget,
): StartReq {
  const key = gameKey(entry.name) || entry.id;
  const known = useCatalogStore.getState().tableSources.get(key) ?? [];
  const sources = [...new Set([...(entry.trainerSource ? [entry.trainerSource] : []), ...known])];
  const game: GameIdentity = { id: entry.id, name: entry.name, steamAppId: entry.steamAppId ?? null };
  return {
    sources,
    cacheKey: key,
    title: entry.name,
    game,
    launch: launch ?? launchTargetFor(entry),
    ...(target ? { pid: target.pid, processName: target.processName } : {}),
  };
}

/**
 * Finds the display-catalog entry for a game the main process identified. The
 * display catalog keeps one entry per game, which may be a different title
 * variant (and id) than the one main matched — so fall back to the game key.
 */
export function findCatalogEntry(game: { id: string; name: string }): CatalogIndexEntry | undefined {
  const games = useCatalogStore.getState().index?.games ?? [];
  const key = gameKey(game.name);
  return games.find((g) => g.id === game.id) ?? games.find((g) => gameKey(g.name) === key);
}

/** Opens a catalog game's trainer and shows the session. */
export async function openCatalogGame(entry: CatalogIndexEntry, navigate: NavigateFunction, launch?: LaunchTarget): Promise<void> {
  if (entry.trainerSource) {
    // Show the Active Trainer page straight away — finding a table that
    // matches can take several seconds and it reports progress (and, on
    // failure, why). Attaches if the game is running; otherwise it lists the
    // game's cheats with a Play button.
    const starting = useCeSessionStore.getState().start(sessionRequestFor(entry, undefined, launch));
    showGameScreen(navigate);
    await starting;
    return;
  }
  // Legacy pre-built trainers (static JSON, Frida engine).
  const trainer = await useCatalogStore.getState().trainer(entry);
  if (!trainer) return;
  await useTrainerStore.getState().setActiveTrainerFromCatalog(trainer);
  showGameScreen(navigate);
}

/**
 * Opens the table-free tools (game speed, memory scanner) for a game the
 * catalog has no table for. Works on any running game.
 */
export async function openToolsOnly(
  game: { name: string; steamAppId?: number | null },
  navigate: NavigateFunction,
  target?: { pid: number; processName?: string | undefined },
  launch?: LaunchTarget,
): Promise<void> {
  const key = gameKey(game.name) || game.name;
  const starting = useCeSessionStore.getState().start({
    sources: [],
    cacheKey: `tools-${key}`,
    title: game.name,
    game: { id: `tools-${key}`, name: game.name, steamAppId: game.steamAppId ?? null },
    launch: launch ?? launchTargetFor(game),
    ...(target ? { pid: target.pid, processName: target.processName } : {}),
  });
  showGameScreen(navigate);
  await starting;
}
