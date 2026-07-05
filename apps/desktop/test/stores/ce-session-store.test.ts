import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStart = vi.fn();
vi.mock('../../src/renderer/ipc-client.js', () => ({
  starlight: () => ({ ceSessionStart: mockStart, ceSessionEnd: vi.fn(), ceSessionSetActive: vi.fn() }),
}));
import { useCeSessionStore } from '../../src/renderer/stores/ce-session-store.js';

beforeEach(() => { mockStart.mockReset(); useCeSessionStore.setState({ sessionId: null, notRunning: false, needsPicker: false }); });

describe('ce-session-store auto-attach', () => {
  it('sets notRunning when the game is not running', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'game not running', reason: 'not-running' });
    const ok = await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' } });
    expect(ok).toBe(false);
    expect(useCeSessionStore.getState().notRunning).toBe(true);
  });

  it('sets needsPicker when the match is ambiguous', async () => {
    mockStart.mockResolvedValue({ ok: true, sessionId: 's', records: [], proton: true, attached: false, needsPicker: true });
    await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' } });
    expect(useCeSessionStore.getState().needsPicker).toBe(true);
  });
});
