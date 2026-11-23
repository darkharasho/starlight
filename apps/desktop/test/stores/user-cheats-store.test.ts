import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUserCheatsStore } from '../../src/renderer/stores/user-cheats-store.js';
import { setStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi } from '../../src/shared/ipc.js';

const list = vi.fn();
const setActive = vi.fn();
const setValue = vi.fn();
const remove = vi.fn();
const cheat = { id: 'c1', name: 'Gold', type: 'set', valueType: 'int32', address: {} } as never;

beforeEach(() => {
  list.mockReset(); setActive.mockReset(); setValue.mockReset(); remove.mockReset();
  list.mockResolvedValue([{ cheat, active: false, verify: null }]);
  setStarlightApi({ userCheatsList: list, userCheatsSetActive: setActive, userCheatsSetValue: setValue, userCheatsRemove: remove } as unknown as StarlightApi);
  useUserCheatsStore.setState({ key: null, pid: null, items: [], pending: new Set(), errors: {}, confirm: null });
});

describe('user cheats store', () => {
  it('loads the list for a game', async () => {
    await useUserCheatsStore.getState().load('game', 7);
    expect(list).toHaveBeenCalledWith({ key: 'game', pid: 7 });
    expect(useUserCheatsStore.getState().items).toHaveLength(1);
  });

  it('a close-ce reply stores the confirm and does not retry; confirming retries with closeCe', async () => {
    await useUserCheatsStore.getState().load('game', 7);
    setActive.mockResolvedValueOnce({ ok: false, error: 'x', confirm: 'close-ce' });
    await useUserCheatsStore.getState().setActive('c1', true, 5);
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(useUserCheatsStore.getState().confirm).toEqual({ id: 'c1', on: true, value: 5 });
    setActive.mockResolvedValueOnce({ ok: true });
    await useUserCheatsStore.getState().confirmCloseCe();
    expect(setActive).toHaveBeenLastCalledWith({ key: 'game', pid: 7, id: 'c1', on: true, value: 5, closeCe: true });
    expect(useUserCheatsStore.getState().confirm).toBeNull();
  });

  it('cancelConfirm drops the held request', async () => {
    useUserCheatsStore.setState({ confirm: { id: 'c1', on: true } });
    useUserCheatsStore.getState().cancelConfirm();
    expect(useUserCheatsStore.getState().confirm).toBeNull();
    expect(setActive).not.toHaveBeenCalled();
  });

  it('keeps the error for a failed toggle', async () => {
    await useUserCheatsStore.getState().load('game', 7);
    setActive.mockResolvedValueOnce({ ok: false, error: 'nope' });
    await useUserCheatsStore.getState().setActive('c1', true);
    expect(useUserCheatsStore.getState().errors['c1']).toBe('nope');
  });

  it('reloads when userCheats:changed names its key, and only then', async () => {
    await useUserCheatsStore.getState().load('game', 7);
    list.mockClear();
    useUserCheatsStore.getState().changed('other');
    expect(list).not.toHaveBeenCalled();
    useUserCheatsStore.getState().changed('game');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('setValue and remove call through', async () => {
    await useUserCheatsStore.getState().load('game', 7);
    setValue.mockResolvedValue({ ok: true }); remove.mockResolvedValue({ ok: true });
    await useUserCheatsStore.getState().setValue('c1', 9);
    expect(setValue).toHaveBeenCalledWith({ key: 'game', pid: 7, id: 'c1', value: 9 });
    await useUserCheatsStore.getState().remove('c1');
    expect(remove).toHaveBeenCalledWith({ key: 'game', id: 'c1' });
  });
});
