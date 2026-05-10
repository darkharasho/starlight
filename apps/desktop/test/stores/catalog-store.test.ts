import { describe, it, expect, beforeEach } from 'vitest';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi } from '../../src/shared/ipc.js';

const sampleIndex = {
  schemaVersion: 1 as const,
  generatedAt: '2026-05-09T00:00:00Z',
  games: [
    { id: 'a', name: 'A', steamAppId: 1, processName: ['a.exe'], platform: ['windows' as const],
      trainerPath: 'trainers/a.json' },
  ],
};

const sampleTrainer = {
  schemaVersion: 1, id: 'a',
  game: { name: 'A', processName: ['a.exe'], platform: ['windows'] },
  metadata: { author: 't', createdAt: '2026-05-09T00:00:00Z' },
  categories: [{ name: 'X', cheats: [] }],
};

function fakeApi(over: Partial<StarlightApi> = {}): StarlightApi {
  return {
    loadTrainer:    async () => ({ ok: false, error: 'unused' }),
    attach:         async () => ({ ok: false, code: 'unknown', message: 'unused' }),
    detach:         async () => undefined,
    toggleCheat:    async () => ({ ok: false, error: 'unused' }),
    setCheatValue:  async () => ({ ok: false, error: 'unused' }),
    scanLibrary:    async () => ({ games: [] }),
    listProcesses:  async () => ({ processes: [] }),
    setProcessName: async () => undefined,
    fetchCatalog:   async () => ({ ok: true, index: sampleIndex }),
    fetchTrainer:   async () => ({ ok: true, trainer: sampleTrainer }),
    onEvent:        () => () => {},
    windowMinimize: () => {},
    windowToggleMaximize: () => {},
    windowClose:    () => {},
    onWindowState:  () => () => {},
    ...over,
  } as StarlightApi;
}

describe('catalog-store', () => {
  beforeEach(() => { clearStarlightApi(); });

  it('starts empty and not loading', async () => {
    setStarlightApi(fakeApi());
    const { useCatalogStore } = await import('../../src/renderer/stores/catalog-store.js');
    useCatalogStore.setState({ index: null, loading: false, error: null });
    const s = useCatalogStore.getState();
    expect(s.index).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('load() sets loading then resolves with index', async () => {
    setStarlightApi(fakeApi());
    const { useCatalogStore } = await import('../../src/renderer/stores/catalog-store.js');
    useCatalogStore.setState({ index: null, loading: false, error: null });
    const promise = useCatalogStore.getState().load();
    expect(useCatalogStore.getState().loading).toBe(true);
    await promise;
    expect(useCatalogStore.getState().loading).toBe(false);
    expect(useCatalogStore.getState().index?.games).toHaveLength(1);
  });

  it('load() captures error', async () => {
    setStarlightApi(fakeApi({ fetchCatalog: async () => ({ ok: false, error: 'boom' }) }));
    const { useCatalogStore } = await import('../../src/renderer/stores/catalog-store.js');
    useCatalogStore.setState({ index: null, loading: false, error: null });
    await useCatalogStore.getState().load();
    expect(useCatalogStore.getState().error).toMatch(/boom/);
  });

  const sampleEntry = {
    id: 'a',
    name: 'A',
    steamAppId: null,
    processName: ['a.exe'],
    platform: ['windows' as const],
    trainerPath: 'trainers/a.json',
  };

  it('trainer() returns null on error', async () => {
    setStarlightApi(fakeApi({ fetchTrainer: async () => ({ ok: false, error: 'nope' }) }));
    const { useCatalogStore } = await import('../../src/renderer/stores/catalog-store.js');
    useCatalogStore.setState({ index: null, loading: false, error: null });
    const t = await useCatalogStore.getState().trainer(sampleEntry);
    expect(t).toBeNull();
  });

  it('trainer() memoizes per entry id', async () => {
    let calls = 0;
    setStarlightApi(fakeApi({ fetchTrainer: async () => { calls++; return { ok: true, trainer: sampleTrainer }; } }));
    const { useCatalogStore } = await import('../../src/renderer/stores/catalog-store.js');
    useCatalogStore.setState({ index: null, loading: false, error: null });
    await useCatalogStore.getState().trainer(sampleEntry);
    await useCatalogStore.getState().trainer(sampleEntry);
    expect(calls).toBe(1);
  });

  it('trainer() returns null when entry has neither trainerPath nor trainerSource', async () => {
    setStarlightApi(fakeApi({ fetchTrainer: async () => ({ ok: true, trainer: sampleTrainer }) }));
    const { useCatalogStore } = await import('../../src/renderer/stores/catalog-store.js');
    useCatalogStore.setState({ index: null, loading: false, error: null });
    const t = await useCatalogStore.getState().trainer({ ...sampleEntry, id: 'no-source', trainerPath: undefined });
    expect(t).toBeNull();
  });

  it('trainer() routes trainerSource entries through fetchTrainer', async () => {
    let receivedReq: { trainerSource?: string } | null = null;
    setStarlightApi(fakeApi({
      fetchTrainer: async (req) => { receivedReq = req as { trainerSource?: string }; return { ok: true, trainer: sampleTrainer }; },
    }));
    const { useCatalogStore } = await import('../../src/renderer/stores/catalog-store.js');
    useCatalogStore.setState({ index: null, loading: false, error: null });
    const liveEntry = {
      id: 'live',
      name: 'Live',
      steamAppId: null,
      processName: [],
      platform: ['windows' as const],
      trainerSource: 'https://fearlessrevolution.com/viewtopic.php?f=4&t=1',
    };
    await useCatalogStore.getState().trainer(liveEntry);
    expect(receivedReq?.trainerSource).toBe('https://fearlessrevolution.com/viewtopic.php?f=4&t=1');
  });
});
