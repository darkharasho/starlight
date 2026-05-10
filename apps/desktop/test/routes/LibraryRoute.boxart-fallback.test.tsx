import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LibraryRoute } from '../../src/renderer/routes/LibraryRoute.js';
import { useLibraryStore } from '../../src/renderer/stores/library-store.js';
import { useCatalogStore } from '../../src/renderer/stores/catalog-store.js';
import { useProcessStore } from '../../src/renderer/stores/process-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';

beforeEach(() => {
  clearStarlightApi();
  useLibraryStore.setState({ games: [], loading: false, error: null });
  useCatalogStore.setState({ index: null, loading: false, error: null });
  useProcessStore.setState({ processes: [], matchedPid: null });
});

describe('LibraryRoute boxart fallback', () => {
  it('manual tile without boxartSteamAppId fires resolveBoxart on mount', async () => {
    const resolveBoxart = vi.fn(async () => ({ url: 'https://sgdb.example/img.jpg' }));
    useLibraryStore.setState({
      games: [{ source: 'manual', appId: 'manual-foo-aaa', name: 'Foo', installDir: '/games/foo' }],
      loading: false, error: null,
      addManual: async () => undefined,
      removeManual: async () => undefined,
      scan: async () => undefined,
    } as never);
    setStarlightApi({
      scanLibrary: async () => ({ games: [] }),
      resolveBoxart,
      onEvent: () => () => {},
    } as never);
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await waitFor(() => expect(resolveBoxart).toHaveBeenCalledWith({ name: 'Foo' }));
  });

  it('Steam tile uses Steam CDN URL upfront and does not call resolveBoxart unless image errors', async () => {
    const resolveBoxart = vi.fn(async () => ({ url: null }));
    useLibraryStore.setState({
      games: [{ source: 'steam', appId: '440', name: 'Team Fortress 2', installDir: '/x/TF2' }],
      loading: false, error: null,
      addManual: async () => undefined, removeManual: async () => undefined, scan: async () => undefined,
    } as never);
    setStarlightApi({
      scanLibrary: async () => ({ games: [] }),
      resolveBoxart,
      onEvent: () => () => {},
    } as never);
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    // Render shouldn't trigger resolveBoxart for a Steam tile that has a valid URL upfront.
    await new Promise(r => setTimeout(r, 50));
    expect(resolveBoxart).not.toHaveBeenCalled();
  });
});
