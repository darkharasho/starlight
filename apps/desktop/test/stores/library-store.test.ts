import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StarlightApi, DetectedGame } from '../../src/shared/ipc.js';

function installFakeApi(api: Partial<StarlightApi>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { starlight: api as StarlightApi },
  });
}

describe('library-store', () => {
  beforeEach(() => { vi.resetModules(); });

  it('starts with empty games and not loading', async () => {
    installFakeApi({ scanLibrary: async () => ({ games: [] }) });
    const { useLibraryStore } = await import('../../src/renderer/stores/library-store.js');
    const s = useLibraryStore.getState();
    expect(s.games).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('scan() sets loading then resolves with games', async () => {
    const games: DetectedGame[] = [{ source: 'steam', appId: '1', name: 'A', installDir: '/a' }];
    installFakeApi({ scanLibrary: async () => ({ games }) });
    const { useLibraryStore } = await import('../../src/renderer/stores/library-store.js');
    const promise = useLibraryStore.getState().scan();
    expect(useLibraryStore.getState().loading).toBe(true);
    await promise;
    expect(useLibraryStore.getState().loading).toBe(false);
    expect(useLibraryStore.getState().games).toEqual(games);
    expect(useLibraryStore.getState().error).toBeNull();
  });

  it('scan() captures error and clears loading', async () => {
    installFakeApi({ scanLibrary: async () => { throw new Error('nope'); } });
    const { useLibraryStore } = await import('../../src/renderer/stores/library-store.js');
    await useLibraryStore.getState().scan();
    expect(useLibraryStore.getState().loading).toBe(false);
    expect(useLibraryStore.getState().error).toMatch(/nope/);
  });
});
