import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLatchState } from '../../src/renderer/stores/latch-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi } from '../../src/shared/ipc.js';

function fakeApi(overrides: Partial<StarlightApi> = {}): StarlightApi {
  return {
    loadTrainer:   vi.fn(),
    attach:        vi.fn().mockResolvedValue({ ok: true }),
    detach:        vi.fn().mockResolvedValue(undefined),
    toggleCheat:   vi.fn(),
    setCheatValue: vi.fn(),
    onEvent:       vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

beforeEach(() => {
  useLatchState.setState({ state: 'waiting', detectedGame: null, error: null, pidInput: '' });
  clearStarlightApi();
});

describe('latch-store async flow', () => {
  it('latch() calls attach and sets state to latched on success', async () => {
    setStarlightApi(fakeApi());
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    expect(useLatchState.getState().state).toBe('latched');
    expect(useLatchState.getState().error).toBeNull();
  });

  it('latch() surfaces a permission error when attach fails', async () => {
    setStarlightApi(fakeApi({
      attach: vi.fn().mockResolvedValue({ ok: false, code: 'permission', message: 'ptrace blocked' }),
    }));
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    expect(useLatchState.getState().state).toBe('waiting');
    expect(useLatchState.getState().error).toMatch(/ptrace blocked/);
  });

  it('latch() with empty PID input fails fast without calling attach', async () => {
    const attach = vi.fn();
    setStarlightApi(fakeApi({ attach }));
    await useLatchState.getState().latch();
    expect(attach).not.toHaveBeenCalled();
    expect(useLatchState.getState().error).toMatch(/pid/i);
  });

  it('detach() calls IPC and resets state', async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    setStarlightApi(fakeApi({ detach }));
    useLatchState.setState({ state: 'latched' });
    await useLatchState.getState().detach();
    expect(detach).toHaveBeenCalled();
    expect(useLatchState.getState().state).toBe('waiting');
  });
});
