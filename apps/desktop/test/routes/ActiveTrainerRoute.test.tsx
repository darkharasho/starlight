import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ActiveTrainerRoute } from '../../src/renderer/routes/ActiveTrainerRoute.js';
import { useLatchState } from '../../src/renderer/stores/latch-store.js';
import { setStarlightApi } from '../../src/renderer/ipc-client.js';
import { useTrainerStore } from '../../src/renderer/stores/trainer-store.js';

beforeEach(() => {
  setStarlightApi({
    loadTrainer:   vi.fn(),
    attach:        vi.fn().mockResolvedValue({ ok: true }),
    detach:        vi.fn().mockResolvedValue(undefined),
    toggleCheat:   vi.fn().mockResolvedValue({ ok: true }),
    setCheatValue: vi.fn().mockResolvedValue({ ok: true }),
    onEvent:       vi.fn().mockReturnValue(() => {}),
  });
  useLatchState.setState({
    state: 'latched',
    detectedGame: { name: 'Elden Ring', coverUrl: 'https://example.com/x.jpg', processName: 'eldenring.exe' },
    error: null,
    pidInput: '12345',
  });
  useTrainerStore.setState({
    trainer: {
      schemaVersion: 1,
      id: 't',
      game: { name: 'Elden Ring', processName: ['eldenring.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [
        {
          name: 'Player',
          cheats: [
            { id: 'infinite-hp', name: 'Infinite HP', type: 'freeze', valueType: 'int32', value: 999, address: { kind: 'absolute', address: '0x1000' } },
            { id: 'speed',       name: 'Movement Speed Multiplier', type: 'set',  valueType: 'float', default: 1.5, step: 0.1, address: { kind: 'absolute', address: '0x2000' } },
            { id: 'auto-block',  name: 'Auto-Block Script', unsupported: true, unsupportedReason: 'Lua' },
          ],
        },
        { name: 'Stats', cheats: [] },
      ],
    },
    activeCheats: {},
    values: { speed: 1.5 },
    error: null,
  });
});

describe('ActiveTrainerRoute', () => {
  it('renders the latched game name and category list', () => {
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
    expect(screen.getByText('Player')).toBeInTheDocument();
    expect(screen.getByText('Stats')).toBeInTheDocument();
  });

  it('shows toggle, value, and unsupported variants in the Player category', () => {
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText('Infinite HP')).toBeInTheDocument();          // toggle
    expect(screen.getByText('Movement Speed Multiplier')).toBeInTheDocument(); // value
    expect(screen.getByText('Auto-Block Script')).toBeInTheDocument();    // unsupported
  });

  it('toggling a cheat updates the active count', async () => {
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText(/0 active/)).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    await userEvent.click(switches[0]!);
    expect(screen.getByText(/1 active/)).toBeInTheDocument();
  });

  it('shows a placeholder when no trainer is loaded', () => {
    useTrainerStore.setState({ trainer: null });
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText(/no trainer loaded/i)).toBeInTheDocument();
  });
});
