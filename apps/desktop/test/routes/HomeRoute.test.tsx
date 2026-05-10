import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomeRoute } from '../../src/renderer/routes/HomeRoute.js';
import { useCatalogStore } from '../../src/renderer/stores/catalog-store.js';
import { useTrainerStore } from '../../src/renderer/stores/trainer-store.js';
import { useLibraryStore } from '../../src/renderer/stores/library-store.js';
import { useConfigStore } from '../../src/renderer/stores/config-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { UserConfig } from '../../src/shared/ipc.js';

const defaultsConfig: UserConfig = {
  schemaVersion: 1,
  processNameOverrides: {},
  recents: [],
  preferences: { theme: 'dark', pollIntervalMs: 2000, catalogRefreshOnLaunch: true },
  manualGames: [],
  hotkeyOverrides: {},
};

function makeFakeApi() {
  return {
    loadTrainer:           vi.fn().mockResolvedValue({ ok: false, error: 'unused' }),
    attach:                vi.fn().mockResolvedValue({ ok: false, code: 'unknown', message: 'unused' }),
    detach:                vi.fn().mockResolvedValue(undefined),
    toggleCheat:           vi.fn().mockResolvedValue({ ok: false, error: 'unused' }),
    setCheatValue:         vi.fn().mockResolvedValue({ ok: false, error: 'unused' }),
    scanLibrary:           vi.fn().mockResolvedValue({ games: [] }),
    listProcesses:         vi.fn().mockResolvedValue({ processes: [] }),
    setProcessName:        vi.fn().mockResolvedValue(undefined),
    fetchCatalog:          vi.fn().mockResolvedValue({ ok: true, index: { schemaVersion: 1, generatedAt: 'x', games: [] } }),
    fetchTrainer:          vi.fn().mockResolvedValue({ ok: false, error: 'unused' }),
    setTrainerFromCatalog: vi.fn().mockResolvedValue({ ok: false, error: 'unused' }),
    getConfig:             vi.fn().mockResolvedValue(defaultsConfig),
    updateConfig:          vi.fn().mockResolvedValue(defaultsConfig),
    onEvent:               vi.fn().mockReturnValue(() => {}),
    windowMinimize:        vi.fn(),
    windowToggleMaximize:  vi.fn(),
    windowClose:           vi.fn(),
    onWindowState:         vi.fn().mockReturnValue(() => {}),
  };
}

beforeEach(() => {
  setStarlightApi(makeFakeApi());
  useCatalogStore.setState({
    index: { schemaVersion: 1, generatedAt: 'x', games: [] },
    loading: false,
    error: null,
  } as never);
  useTrainerStore.setState({ trainer: null, activeCheats: {}, values: {}, error: null } as never);
  useLibraryStore.setState({ games: [], loading: false, error: null });
  useConfigStore.setState({ config: defaultsConfig, loading: false, error: null });
});

afterEach(() => {
  clearStarlightApi();
});

describe('HomeRoute', () => {
  it('renders the Home page header', () => {
    render(<MemoryRouter><HomeRoute /></MemoryRouter>);
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('renders the Load Trainer button', () => {
    render(<MemoryRouter><HomeRoute /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /Load Trainer/i })).toBeInTheDocument();
  });

  it('renders Featured Trainers section', () => {
    render(<MemoryRouter><HomeRoute /></MemoryRouter>);
    expect(screen.getByText(/Featured Trainers/i)).toBeInTheDocument();
  });

  it('does not render Recently Played when recents is empty', () => {
    render(<MemoryRouter><HomeRoute /></MemoryRouter>);
    expect(screen.queryByText(/Recently Played/i)).not.toBeInTheDocument();
  });

  it('renders Recently Played when recents is non-empty', async () => {
    useConfigStore.setState({
      config: {
        schemaVersion: 1,
        processNameOverrides: {},
        recents: [{ id: 'a', name: 'Alpha', openedAt: new Date().toISOString(), source: 'catalog' }],
        preferences: { theme: 'dark', pollIntervalMs: 2000, catalogRefreshOnLaunch: true },
        manualGames: [],
        hotkeyOverrides: {},
      },
      loading: false,
      error: null,
    });
    render(<MemoryRouter><HomeRoute /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Recently Played/i)).toBeInTheDocument());
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});
