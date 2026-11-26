import { describe, it, expect, beforeEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useCatalogStore } from '../../src/renderer/stores/catalog-store.js';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TopBar } from '../../src/renderer/components/TopBar.js';
import { useCeSessionStore } from '../../src/renderer/stores/ce-session-store.js';
import { useDetectionStore } from '../../src/renderer/stores/detection-store.js';

function renderTopBar(latchState: 'waiting' | 'detected' | 'latched' = 'waiting') {
  return render(<MemoryRouter><TopBar latchState={latchState} /></MemoryRouter>);
}

beforeEach(() => {
  useCeSessionStore.setState({ attached: false, sessionId: null });
  useDetectionStore.setState({ detected: null });
});

describe('TopBar pill priority', () => {
  it('shows "Waiting for game" when idle', () => {
    renderTopBar('waiting');
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for game');
  });

  it('shows Connected when a Cheat Engine session is attached, even if latchState is waiting', () => {
    useCeSessionStore.setState({ attached: true, sessionId: 'abc' });
    renderTopBar('waiting');
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
  });

  it('does not show Connected when a session exists but is not yet attached', () => {
    useCeSessionStore.setState({ attached: false, sessionId: 'abc' });
    renderTopBar('waiting');
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for game');
  });

  it('an attached session outranks a pending detection', () => {
    useCeSessionStore.setState({ attached: true, sessionId: 'abc' });
    useDetectionStore.setState({ detected: { game: { id: 'g', name: 'G' }, pid: 1, name: 'g.exe', confidence: 'name' } });
    renderTopBar('waiting');
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
  });
});

describe('TopBar Latch', () => {
  it('latches onto a community-only game, tools-only with its Steam id', async () => {
    const start = vi.fn(async () => true);
    useCeSessionStore.setState({ start } as never);
    useCatalogStore.setState({ index: { schemaVersion: 1, generatedAt: 'x', games: [
      { id: 'new-game', name: 'New Game', steamAppId: 1234, processName: [], platform: ['windows'], communityOnly: true },
    ] } } as never);
    useDetectionStore.setState({ detected: { game: { id: 'new-game', name: 'New Game', steamAppId: 1234 }, pid: 7, name: 'NewGame.exe', confidence: 'exact' } });
    renderTopBar('waiting');
    await userEvent.click(screen.getByRole('button', { name: /New Game detected/ }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sources: [], pid: 7, game: expect.objectContaining({ steamAppId: 1234 }) }));
  });
});
