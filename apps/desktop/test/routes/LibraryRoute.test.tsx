import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LibraryRoute } from '../../src/renderer/routes/LibraryRoute.js';
import { useLibraryStore } from '../../src/renderer/stores/library-store.js';
import { useProcessStore } from '../../src/renderer/stores/process-store.js';
import { useCatalogStore } from '../../src/renderer/stores/catalog-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';

const TWO_GAMES = [
  { source: 'steam' as const, appId: '440', name: 'Team Fortress 2', installDir: '/x/Team Fortress 2' },
  { source: 'steam' as const, appId: '730', name: 'Counter-Strike 2', installDir: '/x/CSGO' },
];

function makeScanApi(games: typeof TWO_GAMES) {
  return {
    scanLibrary: vi.fn().mockResolvedValue({ games }),
    loadTrainer: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    toggleCheat: vi.fn(),
    setCheatValue: vi.fn(),
    listProcesses: vi.fn(),
    setProcessName: vi.fn(),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
}

beforeEach(() => {
  useLibraryStore.setState({ games: [], loading: false, error: null });
  useProcessStore.setState({ processes: [], matchedPid: null });
  useCatalogStore.setState({
    index: {
      schemaVersion: 1, generatedAt: 'x',
      games: [{ id: 'tf2', name: 'Team Fortress 2', steamAppId: 440,
                processName: ['hl2.exe'], platform: ['windows'], trainerPath: 'trainers/tf2.json' }],
    },
    loading: false, error: null,
  } as never);
  setStarlightApi(makeScanApi(TWO_GAMES));
});

afterEach(() => {
  clearStarlightApi();
});

describe('LibraryRoute', () => {
  it('triggers scan on mount and renders detected games', async () => {
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Team Fortress 2')).toBeInTheDocument());
    expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
  });

  it('shows empty state when no games detected', async () => {
    setStarlightApi(makeScanApi([]));
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByText(/no installed games detected/i)).toBeInTheDocument(),
    );
  });

  it('Refresh button re-scans', async () => {
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Team Fortress 2')).toBeInTheDocument());
    const freshApi = makeScanApi([]);
    setStarlightApi(freshApi);
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(freshApi.scanLibrary).toHaveBeenCalled());
  });

  it('shows Running badge on tile when process name matches installDir basename', async () => {
    useProcessStore.setState({ processes: [{ pid: 1, name: 'team fortress 2' }], matchedPid: null });
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Team Fortress 2')).toBeInTheDocument());
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('shows Trainer badge only on tiles whose Steam ID is in the catalog', async () => {
    render(<MemoryRouter><LibraryRoute /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Team Fortress 2')).toBeInTheDocument());
    // TF2 (appId 440) is in the catalog stub — badge should appear
    expect(screen.getByText('Trainer')).toBeInTheDocument();
    // CS2 (appId 730) is NOT in the catalog stub — only one Trainer badge total
    expect(screen.getAllByText('Trainer')).toHaveLength(1);
  });
});
