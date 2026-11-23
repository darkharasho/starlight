import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLatchState } from '../../src/renderer/stores/latch-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi } from '../../src/shared/ipc.js';
import { PTRACE_MESSAGE } from '../../src/shared/ptrace.js';

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
  useLatchState.setState({ state: 'waiting', detectedGame: null, error: null, pidInput: '', needsPermission: false, allowing: false });
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

  it('latch() asks for permission (friendly copy) when attach is not permitted', async () => {
    setStarlightApi(fakeApi({
      attach: vi.fn().mockResolvedValue({ ok: false, code: 'permission', message: 'not permitted to access pid 12345 (os error 13)' }),
    }));
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    expect(useLatchState.getState().state).toBe('waiting');
    expect(useLatchState.getState().needsPermission).toBe(true);
    expect(useLatchState.getState().error).toBe(PTRACE_MESSAGE);
  });

  it('allowAccess() grants permission, then attaches again', async () => {
    const attach = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'permission', message: 'os error 13' })
      .mockResolvedValueOnce({ ok: true });
    const allowMemoryAccess = vi.fn().mockResolvedValue({ ok: true });
    setStarlightApi(fakeApi({ attach, allowMemoryAccess }));
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    await useLatchState.getState().allowAccess();
    expect(allowMemoryAccess).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(useLatchState.getState()).toMatchObject({ state: 'latched', error: null, needsPermission: false, allowing: false });
  });

  it('allowAccess() keeps the prompt up when the password dialog is dismissed', async () => {
    const attach = vi.fn().mockResolvedValue({ ok: false, code: 'permission', message: 'os error 13' });
    const allowMemoryAccess = vi.fn().mockResolvedValue({ ok: false, cancelled: true, error: "Permission wasn't granted." });
    setStarlightApi(fakeApi({ attach, allowMemoryAccess }));
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    await useLatchState.getState().allowAccess();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(useLatchState.getState()).toMatchObject({ needsPermission: true, error: PTRACE_MESSAGE, allowing: false });
  });

  it('allowAccess() shows a failed grant instead of the prompt', async () => {
    const attach = vi.fn().mockResolvedValue({ ok: false, code: 'permission', message: 'os error 13' });
    const allowMemoryAccess = vi.fn().mockResolvedValue({ ok: false, error: 'setcap failed: boom' });
    setStarlightApi(fakeApi({ attach, allowMemoryAccess }));
    useLatchState.setState({ pidInput: '12345' });
    await useLatchState.getState().latch();
    await useLatchState.getState().allowAccess();
    expect(useLatchState.getState()).toMatchObject({ needsPermission: false, error: 'setcap failed: boom' });
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
