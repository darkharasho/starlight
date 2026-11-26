import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { UserCheatView } from '../../shared/ipc.js';

interface Confirm { id: string; on: boolean; value?: number | undefined }

interface UserCheatsState {
  key: string | null;
  pid: number | null;
  items: UserCheatView[];
  pending: Set<string>;
  errors: Record<string, string>;
  /** Turning this on needs the Cheat Engine table closed first. */
  confirm: Confirm | null;

  load: (key: string, pid: number | null) => Promise<void>;
  setActive: (id: string, on: boolean, value?: number) => Promise<void>;
  /** Retries the held request with the Cheat Engine table allowed to close. */
  confirmCloseCe: () => Promise<void>;
  cancelConfirm: () => void;
  setValue: (id: string, value: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** `userCheats:changed` arrived. */
  changed: (key: string) => void;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const makeStore = () => create<UserCheatsState>((set, get) => {
  const reload = async (): Promise<void> => {
    const { key, pid } = get();
    if (key === null) return;
    try {
      const items = await starlight().userCheatsList({ key, pid });
      if (get().key === key && get().pid === pid) set({ items });
    } catch { /* keep what is shown */ }
  };
  const mark = (id: string, on: boolean): void => {
    const pending = new Set(get().pending);
    if (on) pending.add(id); else pending.delete(id);
    set({ pending });
  };
  const fail = (id: string, error: string): void => set({ errors: { ...get().errors, [id]: error } });
  const clearError = (id: string): void => {
    const errors = { ...get().errors }; delete errors[id];
    set({ errors });
  };

  const apply = async (id: string, on: boolean, value: number | undefined, closeCe: boolean): Promise<void> => {
    const { key, pid } = get();
    if (key === null || pid === null) { fail(id, 'Start the game first.'); return; }
    clearError(id);
    mark(id, true);
    try {
      const r = await starlight().userCheatsSetActive({
        key, pid, id, on, ...(value !== undefined ? { value } : {}), ...(closeCe ? { closeCe: true } : {}),
      });
      if (get().key !== key) return;
      if (r.ok) set({ confirm: null });
      else if (r.confirm === 'close-ce') set({ confirm: { id, on, value } });
      else fail(id, r.error);
    } catch (err) {
      fail(id, msg(err));
    } finally {
      mark(id, false);
    }
    await reload();
  };

  let inflight: { key: string; pid: number | null; p: Promise<void> } | null = null;
  const doLoad = async (key: string, pid: number | null): Promise<void> => {
    const moved = get().key !== key;
    set(moved ? { key, pid, items: [], pending: new Set(), errors: {}, confirm: null } : { key, pid });
    await reload();
  };

  return {
    key: null, pid: null, items: [], pending: new Set(), errors: {}, confirm: null,

    load: (key, pid) => {
      if (inflight && inflight.key === key && inflight.pid === pid) return inflight.p;
      const p = doLoad(key, pid).finally(() => { if (inflight?.p === p) inflight = null; });
      inflight = { key, pid, p };
      return p;
    },

    setActive: (id, on, value) => apply(id, on, value, false),

    confirmCloseCe: async () => {
      const c = get().confirm;
      if (!c) return;
      set({ confirm: null });
      await apply(c.id, c.on, c.value, true);
    },

    cancelConfirm: () => set({ confirm: null }),

    setValue: async (id, value) => {
      const { key, pid } = get();
      if (key === null || pid === null) return;
      clearError(id);
      try {
        const r = await starlight().userCheatsSetValue({ key, pid, id, value });
        if (!r.ok) fail(id, r.error);
      } catch (err) {
        fail(id, msg(err));
      }
      await reload();
    },

    remove: async (id) => {
      const { key } = get();
      if (key === null) return;
      try {
        const r = await starlight().userCheatsRemove({ key, id });
        if (!r.ok) fail(id, r.error);
      } catch (err) {
        fail(id, msg(err));
      }
      await reload();
    },

    changed: (key) => { if (get().key === key) void reload(); },
  };
});

/** The player's own cheats for the open game. */
export const useUserCheatsStore = makeStore();
/** Community cheats for the open game (a `community-<steamAppId>` key). */
export const useCommunityCheatsStore = makeStore();
export type UserCheatsStore = typeof useUserCheatsStore;
