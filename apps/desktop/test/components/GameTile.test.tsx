import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameTile } from '../../src/renderer/components/GameTile.js';

const game = {
  steamAppId: 1245620,
  name: 'Elden Ring',
  processName: ['eldenring.exe'],
  coverUrl: 'https://example.com/eldenring.jpg',
  hasTrainer: true,
  installed: true,
};

describe('GameTile', () => {
  it('renders an accessible label with the game name', () => {
    render(<GameTile game={game} />);
    expect(screen.getByRole('button', { name: /Elden Ring/i })).toBeInTheDocument();
  });

  it('shows INSTALLED badge when installed', () => {
    render(<GameTile game={game} />);
    expect(screen.getByText(/installed/i)).toBeInTheDocument();
  });

  it('shows TRAINER badge when hasTrainer', () => {
    render(<GameTile game={game} />);
    expect(screen.getByText(/^trainer$/i)).toBeInTheDocument();
  });

  it('omits TRAINER badge when hasTrainer is false', () => {
    render(<GameTile game={{ ...game, hasTrainer: false }} />);
    expect(screen.queryByText(/^trainer$/i)).not.toBeInTheDocument();
  });

  it('calls onClick with the game when clicked', async () => {
    const handler = vi.fn();
    render(<GameTile game={game} onClick={handler} />);
    await userEvent.click(screen.getByRole('button'));
    expect(handler).toHaveBeenCalledWith(game);
  });
});
