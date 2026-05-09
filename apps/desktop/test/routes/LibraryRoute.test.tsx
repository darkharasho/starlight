import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibraryRoute } from '../../src/renderer/routes/LibraryRoute.js';
import { useLibraryStore } from '../../src/renderer/stores/library-store.js';
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
  setStarlightApi(makeScanApi(TWO_GAMES));
});

afterEach(() => {
  clearStarlightApi();
});

describe('LibraryRoute', () => {
  it('triggers scan on mount and renders detected games', async () => {
    render(<LibraryRoute />);
    await waitFor(() => expect(screen.getByText('Team Fortress 2')).toBeInTheDocument());
    expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
  });

  it('shows empty state when no games detected', async () => {
    setStarlightApi(makeScanApi([]));
    render(<LibraryRoute />);
    await waitFor(() =>
      expect(screen.getByText(/no installed games detected/i)).toBeInTheDocument(),
    );
  });

  it('Refresh button re-scans', async () => {
    render(<LibraryRoute />);
    await waitFor(() => expect(screen.getByText('Team Fortress 2')).toBeInTheDocument());
    const freshApi = makeScanApi([]);
    setStarlightApi(freshApi);
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(freshApi.scanLibrary).toHaveBeenCalled());
  });
});
