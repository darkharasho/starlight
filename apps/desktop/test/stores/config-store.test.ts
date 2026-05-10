import { describe, it, expect, beforeEach } from 'vitest';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi, StarlightEvent, UserConfig } from '../../src/shared/ipc.js';

const defaultsConfig: UserConfig = {
  schemaVersion: 1,
  processNameOverrides: {},
  recents: [],
  preferences: { theme: 'dark', pollIntervalMs: 2000, catalogRefreshOnLaunch: true },
  manualGames: [],
  hotkeyOverrides: {},
};

let listeners: Array<(e: StarlightEvent) => void> = [];

function fakeApi(over: Partial<StarlightApi> = {}): StarlightApi {
  listeners = [];
  return {
    loadTrainer:    async () => ({ ok: false, error: 'unused' }),
    attach:         async () => ({ ok: false, code: 'unknown', message: 'unused' }),
    detach:         async () => undefined,
    toggleCheat:    async () => ({ ok: false, error: 'unused' }),
    setCheatValue:  async () => ({ ok: false, error: 'unused' }),
    scanLibrary:    async () => ({ games: [] }),
    listProcesses:  async () => ({ processes: [] }),
    setProcessName: async () => undefined,
    fetchCatalog:   async () => ({ ok: true, index: { schemaVersion: 1, generatedAt: 'x', games: [] } }),
    fetchTrainer:   async () => ({ ok: false, error: 'unused' }),
    setTrainerFromCatalog: async () => ({ ok: false, error: 'unused' }),
    getConfig:      async () => defaultsConfig,
    updateConfig:   async () => defaultsConfig,
    onEvent:        (l) => { listeners.push(l); return () => { listeners = listeners.filter(x => x !== l); }; },
    windowMinimize: () => {},
    windowToggleMaximize: () => {},
    windowClose:    () => {},
    onWindowState:  () => () => {},
    ...over,
  } as StarlightApi;
}

function emit(e: StarlightEvent): void { for (const l of listeners) l(e); }

describe('config-store', () => {
  beforeEach(() => { clearStarlightApi(); });

  it('starts with null config', async () => {
    setStarlightApi(fakeApi());
    const { useConfigStore } = await import('../../src/renderer/stores/config-store.js');
    useConfigStore.setState({ config: null, loading: false, error: null });
    expect(useConfigStore.getState().config).toBeNull();
  });

  it('load() fetches and stores the config', async () => {
    setStarlightApi(fakeApi());
    const { useConfigStore } = await import('../../src/renderer/stores/config-store.js');
    useConfigStore.setState({ config: null, loading: false, error: null });
    await useConfigStore.getState().load();
    expect(useConfigStore.getState().config?.preferences.pollIntervalMs).toBe(2000);
  });

  it('update() calls IPC and updates state', async () => {
    let received: unknown;
    setStarlightApi(fakeApi({
      updateConfig: async (req) => {
        received = req.patch;
        return { ...defaultsConfig, preferences: { ...defaultsConfig.preferences, pollIntervalMs: 5000 } };
      },
    }));
    const { useConfigStore } = await import('../../src/renderer/stores/config-store.js');
    useConfigStore.setState({ config: null, loading: false, error: null });
    await useConfigStore.getState().update({ preferences: { pollIntervalMs: 5000 } });
    expect(received).toEqual({ preferences: { pollIntervalMs: 5000 } });
    expect(useConfigStore.getState().config?.preferences.pollIntervalMs).toBe(5000);
  });

  it('config:changed event updates state', async () => {
    setStarlightApi(fakeApi());
    const { useConfigStore, attachConfigEvents } = await import('../../src/renderer/stores/config-store.js');
    useConfigStore.setState({ config: null, loading: false, error: null });
    attachConfigEvents();
    const next = { ...defaultsConfig, preferences: { ...defaultsConfig.preferences, pollIntervalMs: 7777 } };
    emit({ type: 'config:changed', config: next });
    expect(useConfigStore.getState().config?.preferences.pollIntervalMs).toBe(7777);
  });
});
