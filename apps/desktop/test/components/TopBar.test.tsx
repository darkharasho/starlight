import { describe, it, expect, beforeEach } from 'vitest';
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

  it('shows LATCHED when a Cheat Engine session is attached, even if latchState is waiting', () => {
    useCeSessionStore.setState({ attached: true, sessionId: 'abc' });
    renderTopBar('waiting');
    expect(screen.getByRole('status')).toHaveTextContent('LATCHED');
  });

  it('does not show LATCHED when a session exists but is not yet attached', () => {
    useCeSessionStore.setState({ attached: false, sessionId: 'abc' });
    renderTopBar('waiting');
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for game');
  });

  it('an attached session outranks a pending detection', () => {
    useCeSessionStore.setState({ attached: true, sessionId: 'abc' });
    useDetectionStore.setState({ detected: { game: { id: 'g', name: 'G' }, pid: 1, name: 'g.exe', confidence: 'name' } });
    renderTopBar('waiting');
    expect(screen.getByRole('status')).toHaveTextContent('LATCHED');
  });
});
