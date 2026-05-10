import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('LibraryRoute — manual entries', () => {
  it('Add manually button opens the dialog', async () => {
    setStarlightApi({
      scanLibrary: async () => ({ games: [] }),
      pickExecutable: async () => ({ ok: false, error: 'cancelled' }),
      onEvent: () => () => {},
    } as never);
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /add manually/i }));
    expect(screen.getByRole('heading', { name: /add a manual game/i })).toBeInTheDocument();
  });

  it('end-to-end happy path: pick exe → name → save → addManual called', async () => {
    const addManual = vi.fn(async () => undefined);
    useLibraryStore.setState({
      games: [], loading: false, error: null,
      scan: async () => undefined,
      addManual,
      removeManual: async () => undefined,
    } as never);
    setStarlightApi({
      scanLibrary: async () => ({ games: [] }),
      pickExecutable: async () => ({ ok: true, path: '/games/foo/foo.exe' }),
      onEvent: () => () => {},
    } as never);
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /add manually/i }));
    await userEvent.click(screen.getByRole('button', { name: /pick executable/i }));
    await waitFor(() => expect(screen.getByText('/games/foo/foo.exe')).toBeInTheDocument());
    const nameInput = screen.getByLabelText(/display name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Foo');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(addManual).toHaveBeenCalledWith('Foo', '/games/foo/foo.exe'));
  });

  it('cancelling the dialog leaves state untouched', async () => {
    setStarlightApi({
      scanLibrary: async () => ({ games: [] }),
      pickExecutable: async () => ({ ok: false, error: 'cancelled' }),
      onEvent: () => () => {},
    } as never);
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /add manually/i }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('heading', { name: /add a manual game/i })).not.toBeInTheDocument();
  });

  it('manual tiles render a × remove button that calls removeManual', async () => {
    const removeManual = vi.fn(async () => undefined);
    useLibraryStore.setState({
      games: [{ source: 'manual', appId: 'manual-foo-aaa', name: 'Foo', installDir: '/games/foo' }],
      loading: false,
      error: null,
      addManual: async () => undefined,
      removeManual,
      scan: async () => undefined,
    } as never);
    setStarlightApi({
      scanLibrary: async () => ({ games: [] }),
      pickExecutable: async () => ({ ok: false, error: 'cancelled' }),
      resolveBoxart: async () => ({ url: null }),
      onEvent: () => () => {},
    } as never);
    // window.confirm is jsdom-default false; stub it true.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /remove foo/i }));
    expect(removeManual).toHaveBeenCalledWith('manual-foo-aaa');
  });
});
