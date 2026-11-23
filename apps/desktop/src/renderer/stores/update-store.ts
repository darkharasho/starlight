import { create } from 'zustand';
import { api } from '../ipc-client.js';
import type { UpdateCheckResult, UpdateState } from '../../shared/ipc.js';

interface UpdateStore {
  state: UpdateState;
  version: string | null;
  /** The user pressed "Check for updates" (Settings shows the outcome only then). */
  asked: boolean;
  /** What that check answered; null while it runs. */
  result: UpdateCheckResult | null;
  check: () => Promise<void>;
  restart: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  state: { status: 'idle' },
  version: null,
  asked: false,
  result: null,
  check: async () => {
    set({ asked: true, result: null });
    let result: UpdateCheckResult;
    try {
      result = await api().updateCheck();
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    set({ result });
  },
  restart: async () => {
    await api().updateRestart();
  },
}));

/** Follows main's update state and loads the version. Returns the unsubscribe. */
export function attachUpdateEvents(): () => void {
  const off = api().onUpdateState((state) => useUpdateStore.setState({ state }));
  void api().updateGetState().then((state) => useUpdateStore.setState({ state }));
  void api().updateGetVersion().then((version) => useUpdateStore.setState({ version }));
  return off;
}
