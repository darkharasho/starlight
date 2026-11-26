import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { SharePreview, ShareSent } from '../../shared/ipc.js';

interface Target { key: string; id: string; pid: number | null; name: string }

interface ShareState {
  target: Target | null;
  preview: SharePreview | null;
  credit: string;
  sending: boolean;
  result: ShareSent | null;
  open: (key: string, id: string, pid: number | null, name: string) => Promise<void>;
  close: () => void;
  setCredit: (credit: string) => Promise<void>;
  send: () => Promise<void>;
}

let seq = 0;
const req = (t: Target, credit: string) => ({ key: t.key, id: t.id, pid: t.pid, ...(credit.trim() ? { credit } : {}) });

export const useShareStore = create<ShareState>((set, get) => {
  async function refresh(): Promise<void> {
    const { target, credit } = get();
    if (!target) return;
    const n = ++seq;
    const p = await starlight().shareCheatPreview(req(target, credit))
      .catch((e: unknown): SharePreview => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
    if (n === seq && get().target === target) set({ preview: p });
  }
  return {
    target: null, preview: null, credit: '', sending: false, result: null,
    async open(key, id, pid, name) {
      set({ target: { key, id, pid, name }, preview: null, credit: '', sending: false, result: null });
      await refresh();
    },
    close() { seq++; set({ target: null, preview: null, credit: '', sending: false, result: null }); },
    async setCredit(credit) { set({ credit }); await refresh(); },
    async send() {
      const { target, credit, sending } = get();
      if (!target || sending) return;
      set({ sending: true });
      const r = await starlight().shareCheatSend(req(target, credit))
        .catch((e: unknown): ShareSent => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
      if (get().target === target) set({ sending: false, result: r });
    },
  };
});
