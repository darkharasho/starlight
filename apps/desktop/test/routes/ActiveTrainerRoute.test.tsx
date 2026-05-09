import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ActiveTrainerRoute } from '../../src/renderer/routes/ActiveTrainerRoute.js';
import { useLatchState } from '../../src/renderer/stores/latch-store.js';

beforeEach(() => {
  useLatchState.setState({
    state: 'latched',
    detectedGame: { name: 'Elden Ring', coverUrl: 'https://example.com/x.jpg', processName: 'eldenring.exe' },
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

  it('shows a placeholder when not latched', () => {
    useLatchState.setState({ state: 'waiting', detectedGame: null });
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText(/no game latched/i)).toBeInTheDocument();
  });
});
