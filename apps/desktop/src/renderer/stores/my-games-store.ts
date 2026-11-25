import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { UserCheatGame } from '../../shared/ipc.js';
import { useCatalogStore } from './catalog-store.js';

/**
 * Games the player has their own cheats for. Kept in step with the catalog
 * store's index, which lists them alongside the catalog's games.
 */
interface MyGamesState {
  games: UserCheatGame[];
  load: () => Promise<void>;
}

export const useMyGamesStore = create<MyGamesState>((set) => ({
  games: [],
  load: async () => {
    try {
      const games = await starlight().userCheatsGames();
      set({ games });
      useCatalogStore.getState().mergeMine(games);
    } catch { /* keep what is shown */ }
  },
}));
