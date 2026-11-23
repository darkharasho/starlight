import { describe, it, expect, beforeEach } from 'vitest';
import { useUpdateStore, attachUpdateEvents } from '../../src/renderer/stores/update-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { UpdateState } from '../../src/shared/ipc.js';

const initial = useUpdateStore.getState();

beforeEach(() => {
  clearStarlightApi();
  useUpdateStore.setState(initial, true);
});

describe('update store', () => {
  it('follows main\'s state and loads the version', async () => {
    let push: (s: UpdateState) => void = () => {};
    let unsubscribed = false;
    setStarlightApi({
      onUpdateState: (l: (s: UpdateState) => void) => { push = l; return () => { unsubscribed = true; }; },
      updateGetState: async () => ({ status: 'none' }),
      updateGetVersion: async () => '0.1.0',
    } as never);
    const off = attachUpdateEvents();
    await Promise.resolve();
    expect(useUpdateStore.getState().state).toEqual({ status: 'none' });
    expect(useUpdateStore.getState().version).toBe('0.1.0');
    push({ status: 'downloaded', version: '0.2.0' });
    expect(useUpdateStore.getState().state).toEqual({ status: 'downloaded', version: '0.2.0' });
    off();
    expect(unsubscribed).toBe(true);
  });

  it('records a manual check and its answer', async () => {
    let resolve: (r: { ok: true }) => void = () => {};
    setStarlightApi({ updateCheck: () => new Promise((r) => { resolve = r; }) } as never);
    const done = useUpdateStore.getState().check();
    expect(useUpdateStore.getState()).toMatchObject({ asked: true, result: null });
    resolve({ ok: true });
    await done;
    expect(useUpdateStore.getState().result).toEqual({ ok: true });
  });

  it('turns a failed IPC call into an error result', async () => {
    setStarlightApi({ updateCheck: async () => { throw new Error('boom'); } } as never);
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().result).toEqual({ ok: false, error: 'boom' });
  });
});
