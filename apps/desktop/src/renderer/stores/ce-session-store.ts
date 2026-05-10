import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CeSessionRecord } from '../../shared/ipc.js';

interface CeSessionState {
  sessionId: string | null;
  records: CeSessionRecord[];
  starting: boolean;
  startError: string | null;
  /** record id → in-flight toggle pending (renderer-side optimistic state). */
  pending: Set<number>;

  start: (req: { source: string; cacheKey: string }) => Promise<boolean>;
  setActive: (recordId: number, active: boolean) => Promise<void>;
  end: () => Promise<void>;
}

export const useCeSessionStore = create<CeSessionState>((set, get) => ({
  sessionId: null,
  records: [],
  starting: false,
  startError: null,
  pending: new Set(),
  start: async (req) => {
    set({ starting: true, startError: null });
    try {
      const r = await starlight().ceSessionStart(req);
      if (!r.ok) { set({ starting: false, startError: r.error }); return false; }
      set({ starting: false, sessionId: r.sessionId, records: r.records });
      return true;
    } catch (err) {
      set({ starting: false, startError: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
  setActive: async (recordId, active) => {
    const sid = get().sessionId;
    if (!sid) return;
    const pending = new Set(get().pending); pending.add(recordId);
    set({ pending });
    try {
      const r = await starlight().ceSessionSetActive({ sessionId: sid, recordId, active });
      if (r.ok) {
        const records = get().records.map(x => x.id === recordId ? { ...x, isActive: active } : x);
        set({ records });
      }
    } finally {
      const next = new Set(get().pending); next.delete(recordId);
      set({ pending: next });
    }
  },
  end: async () => {
    const sid = get().sessionId;
    if (!sid) return;
    set({ sessionId: null, records: [], pending: new Set() });
    await starlight().ceSessionEnd({ sessionId: sid }).catch(() => {});
  },
}));
