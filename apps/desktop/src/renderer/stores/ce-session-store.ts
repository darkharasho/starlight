import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CeSessionRecord } from '../../shared/ipc.js';

interface StartReq {
  source: string;
  cacheKey: string;
  pid?: number | undefined;
  processName?: string | undefined;
  game?: { id: string; name: string; steamAppId?: number | null } | undefined;
}

interface CeSessionState {
  sessionId: string | null;
  records: CeSessionRecord[];
  starting: boolean;
  startError: string | null;
  /** True once the session is attached to a running game process. */
  attached: boolean;
  /** True when the attached game runs under Proton (Windows CE in the prefix). */
  proton: boolean;
  /** The process the session is attached to, for display. */
  attachedTo: { pid: number; name?: string | undefined } | null;
  /** Retained so "attach" can re-launch the session against a chosen process. */
  lastReq: StartReq | null;
  /** record id → in-flight toggle pending (renderer-side optimistic state). */
  pending: Set<number>;
  /** True when the IPC result indicates the game isn't currently running. */
  notRunning: boolean;
  /**
   * True when the session found multiple candidate processes (picker needed).
   * Reserved for a future attach-bar pre-highlight of the best-guess process; the manual picker
   * currently covers the ambiguous case (attached:false already renders the manual attach bar).
   * DEFERRED — no component consumes this yet.
   */
  needsPicker: boolean;

  start: (req: StartReq) => Promise<boolean>;
  /** Re-launch the current session targeting a running process (boots Windows CE if Proton). */
  attach: (pid: number, processName?: string) => Promise<boolean>;
  setActive: (recordId: number, active: boolean) => Promise<void>;
  end: () => Promise<void>;
}

export const useCeSessionStore = create<CeSessionState>((set, get) => ({
  sessionId: null,
  records: [],
  starting: false,
  startError: null,
  attached: false,
  proton: false,
  attachedTo: null,
  lastReq: null,
  pending: new Set(),
  notRunning: false,
  needsPicker: false,
  start: async (req) => {
    set({ starting: true, startError: null, lastReq: req, notRunning: false, needsPicker: false });
    try {
      const r = await starlight().ceSessionStart(req);
      if (!r.ok) { set({ starting: false, startError: r.error, notRunning: r.reason === 'not-running' }); return false; }
      set({
        starting: false,
        sessionId: r.sessionId,
        records: r.records,
        attached: r.attached,
        proton: r.proton,
        attachedTo: req.pid !== undefined ? { pid: req.pid, name: req.processName } : null,
        needsPicker: r.needsPicker ?? false,
      });
      return true;
    } catch (err) {
      set({ starting: false, startError: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
  attach: async (pid, processName) => {
    const base = get().lastReq;
    if (!base) return false;
    // End the current (list-only) session and re-launch targeting the process,
    // so the main process boots the right CE (Windows-in-Proton or native Linux).
    await get().end();
    return get().start({ ...base, pid, processName });
  },
  setActive: async (recordId, active) => {
    const sid = get().sessionId;
    if (!sid) return;
    const pending = new Set(get().pending); pending.add(recordId);
    set({ pending, startError: null });
    try {
      const r = await starlight().ceSessionSetActive({ sessionId: sid, recordId, active });
      if (r.ok) {
        const records = get().records.map(x => x.id === recordId ? { ...x, isActive: active } : x);
        set({ records });
      } else {
        set({ startError: r.error ?? 'toggle failed' });
      }
    } finally {
      const next = new Set(get().pending); next.delete(recordId);
      set({ pending: next });
    }
  },
  end: async () => {
    const sid = get().sessionId;
    if (!sid) { set({ attached: false, proton: false, attachedTo: null, notRunning: false, needsPicker: false }); return; }
    set({ sessionId: null, records: [], pending: new Set(), attached: false, proton: false, attachedTo: null, notRunning: false, needsPicker: false });
    await starlight().ceSessionEnd({ sessionId: sid }).catch(() => {});
  },
}));
