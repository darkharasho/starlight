import { describe, it, expect, beforeEach } from 'vitest';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi, UserConfig } from '../../src/shared/ipc.js';

const baseConfig: UserConfig = {
  schemaVersion: 1,
  processNameOverrides: {},
  recents: [],
  preferences: { theme: 'dark', pollIntervalMs: 2000, catalogRefreshOnLaunch: true },
  manualGames: [],
  hotkeyOverrides: {},
};

function fakeApi(over: Partial<StarlightApi> = {}): StarlightApi {
  return {
    loadTrainer: async () => ({ ok: false, error: 'unused' }),
    attach: async () => ({ ok: false, code: 'unknown', message: 'unused' }),
    detach: async () => undefined,
    toggleCheat: async () => ({ ok: false, error: 'unused' }),
    setCheatValue: async () => ({ ok: false, error: 'unused' }),
    scanLibrary: async () => ({ games: [] }),
    listProcesses: async () => ({ processes: [] }),
    setProcessName: async () => undefined,
    fetchCatalog: async () => ({ ok: true, index: { schemaVersion: 1, generatedAt: 'x', games: [] } }),
    fetchTrainer: async () => ({ ok: false, error: 'unused' }),
    setTrainerFromCatalog: async () => ({ ok: false, error: 'unused' }),
    getConfig: async () => baseConfig,
    updateConfig: async () => baseConfig,
    pickExecutable: async () => ({ ok: false, error: 'cancelled' }),
    onEvent: () => () => {},
    windowMinimize: () => {},
    windowToggleMaximize: () => {},
    windowClose: () => {},
    onWindowState: () => () => {},
    ...over,
  } as StarlightApi;
}

describe('library-store manual entries', () => {
  beforeEach(() => { clearStarlightApi(); });

  it('addManual generates manual-<slug>-<hash> id and persists via updateConfig', async () => {
    let receivedPatch: unknown;
    setStarlightApi(fakeApi({
      updateConfig: async (req) => { receivedPatch = req.patch; return baseConfig; },
    }));
    const { useLibraryStore } = await import('../../src/renderer/stores/library-store.js');
    useLibraryStore.setState({ games: [], loading: false, error: null });
    await useLibraryStore.getState().addManual('My Game', '/games/my-game/game.exe');
    const patch = receivedPatch as { manualGames: Array<{ id: string; name: string; exePath: string; addedAt: string }> };
    expect(patch.manualGames).toHaveLength(1);
    expect(patch.manualGames[0]!.id).toMatch(/^manual-my-game-[a-z0-9]+$/);
    expect(patch.manualGames[0]!.name).toBe('My Game');
    expect(patch.manualGames[0]!.exePath).toBe('/games/my-game/game.exe');
  });

  it('addManual is idempotent for the same name+exePath (same generated id)', async () => {
    const captured: Array<Array<{ id: string }>> = [];
    setStarlightApi(fakeApi({
      getConfig: async () => ({ ...baseConfig, manualGames: captured.length > 0 ? captured[captured.length - 1]! as never : [] }),
      updateConfig: async (req) => {
        const patch = req.patch as { manualGames?: Array<{ id: string; name: string; exePath: string; addedAt: string }> };
        if (patch.manualGames) captured.push(patch.manualGames);
        return baseConfig;
      },
    }));
    const { useLibraryStore } = await import('../../src/renderer/stores/library-store.js');
    useLibraryStore.setState({ games: [], loading: false, error: null });
    await useLibraryStore.getState().addManual('My Game', '/games/my-game/game.exe');
    await useLibraryStore.getState().addManual('My Game', '/games/my-game/game.exe');
    // Second call sees the first's persisted entry; produces the same id.
    expect(captured).toHaveLength(2);
    expect(captured[1]).toHaveLength(1);                            // dedupe: still 1 entry
    expect(captured[0]![0]!.id).toBe(captured[1]![0]!.id);
  });

  it('removeManual filters by id and persists', async () => {
    const existing = [
      { id: 'manual-a-111', name: 'A', exePath: '/a.exe', addedAt: '2026-05-09T00:00:00Z' },
      { id: 'manual-b-222', name: 'B', exePath: '/b.exe', addedAt: '2026-05-09T00:00:00Z' },
    ];
    let receivedPatch: unknown;
    setStarlightApi(fakeApi({
      getConfig: async () => ({ ...baseConfig, manualGames: existing }),
      updateConfig: async (req) => { receivedPatch = req.patch; return baseConfig; },
    }));
    const { useLibraryStore } = await import('../../src/renderer/stores/library-store.js');
    useLibraryStore.setState({ games: [], loading: false, error: null });
    await useLibraryStore.getState().removeManual('manual-a-111');
    const patch = receivedPatch as { manualGames: Array<{ id: string }> };
    expect(patch.manualGames.map(g => g.id)).toEqual(['manual-b-222']);
  });
});
