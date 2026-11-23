import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { ScanValueType } from '../../shared/ipc.js';
import { useCeSessionStore } from './ce-session-store.js';

export type FirstScanOp = 'exact' | 'unknown' | 'bigger' | 'smaller';
export type NextScanOp = 'exact' | 'increased' | 'decreased' | 'changed' | 'unchanged' | 'bigger' | 'smaller';

export interface ScanResult { address: string; value: string }

/** An address the user kept from a scan, to edit or hold at a value. */
export interface SavedAddress {
  address: string;
  valueType: ScanValueType;
  label: string;
  value: string;
  frozen: boolean;
}

interface ScannerState {
  valueType: ScanValueType;
  /** True once a first scan exists that "next scan" can narrow. */
  started: boolean;
  busy: boolean;
  count: number;
  results: ScanResult[];
  saved: SavedAddress[];
  error: string | null;

  setValueType: (t: ScanValueType) => void;
  firstScan: (op: FirstScanOp, value: string) => Promise<void>;
  nextScan: (op: NextScanOp, value: string) => Promise<void>;
  newScan: () => Promise<void>;
  /** Re-read the live values of the shown results and saved addresses. */
  refreshValues: () => Promise<void>;
  save: (r: ScanResult) => void;
  rename: (address: string, label: string) => void;
  write: (address: string, value: string) => Promise<void>;
  setFrozen: (address: string, frozen: boolean) => Promise<void>;
  remove: (address: string) => Promise<void>;
  /** Forget everything (the session ended; Cheat Engine already dropped it). */
  clear: () => void;
}

const RESULT_LIMIT = 100;
const POLL_MS = 300;
const SCAN_TIMEOUT_MS = 5 * 60_000;

type Reply = Record<string, unknown>;

async function call(method: string, params?: unknown): Promise<Reply> {
  const sessionId = useCeSessionStore.getState().sessionId;
  if (!sessionId) return { ok: false, error: 'no active session' };
  try {
    return await starlight().ceSessionCall({ sessionId, method, params });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const useScannerStore = create<ScannerState>((set, get) => {
  /** Waits for the running scan to finish, then loads the first page of results. */
  async function settle(): Promise<void> {
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const st = await call('scan_status');
      if (st['ok'] === false) { set({ busy: false, error: String(st['error'] ?? 'scan failed') }); return; }
      if (st['busy'] !== true) break;
      if (Date.now() > deadline) { set({ busy: false, error: 'The scan is taking too long. Try an exact value to narrow it.' }); return; }
    }
    const res = await call('scan_results', { limit: RESULT_LIMIT });
    set({
      busy: false,
      started: true,
      count: typeof res['count'] === 'number' ? res['count'] : 0,
      results: Array.isArray(res['items']) ? (res['items'] as ScanResult[]) : [],
    });
  }

  return {
    valueType: 'i32',
    started: false,
    busy: false,
    count: 0,
    results: [],
    saved: [],
    error: null,

    setValueType: (valueType) => set({ valueType }),

    firstScan: async (op, value) => {
      if (get().busy) return;
      set({ busy: true, error: null, results: [], count: 0 });
      const r = await call('scan_first', { valueType: get().valueType, op, value });
      if (r['ok'] !== true) { set({ busy: false, error: String(r['error'] ?? 'scan failed') }); return; }
      await settle();
    },

    nextScan: async (op, value) => {
      if (get().busy || !get().started) return;
      set({ busy: true, error: null });
      const r = await call('scan_next', { op, value });
      if (r['ok'] !== true) { set({ busy: false, error: String(r['error'] ?? 'scan failed') }); return; }
      await settle();
    },

    newScan: async () => {
      if (get().busy) return;
      await call('scan_reset');
      set({ started: false, count: 0, results: [], error: null });
    },

    refreshValues: async () => {
      const { results, saved, valueType, busy } = get();
      if (busy || (results.length === 0 && saved.length === 0)) return;
      const items = [
        ...results.map((r) => ({ address: r.address, valueType })),
        ...saved.map((s) => ({ address: s.address, valueType: s.valueType })),
      ];
      const r = await call('mem_read', { items });
      const values = r['values'];
      if (!Array.isArray(values)) return;
      // The lists may have changed while we waited; only apply if they still line up.
      const now = get();
      if (now.results !== results || now.saved !== saved) return;
      set({
        results: results.map((x, i) => ({ ...x, value: String(values[i] ?? '') })),
        saved: saved.map((x, i) => (x.frozen ? x : { ...x, value: String(values[results.length + i] ?? '') })),
      });
    },

    save: (r) => {
      if (get().saved.some((s) => s.address === r.address)) return;
      set({ saved: [...get().saved, { address: r.address, valueType: get().valueType, label: '', value: r.value, frozen: false }] });
    },

    rename: (address, label) => set({ saved: get().saved.map((s) => (s.address === address ? { ...s, label } : s)) }),

    write: async (address, value) => {
      const entry = get().saved.find((s) => s.address === address);
      if (!entry) return;
      const r = await call('mem_write', { address, valueType: entry.valueType, value });
      if (r['ok'] !== true) { set({ error: String(r['error'] ?? 'could not write that address') }); return; }
      set({ error: null, saved: get().saved.map((s) => (s.address === address ? { ...s, value } : s)) });
    },

    setFrozen: async (address, frozen) => {
      const entry = get().saved.find((s) => s.address === address);
      if (!entry) return;
      const r = frozen
        ? await call('freeze_set', { address, valueType: entry.valueType, value: entry.value })
        : await call('freeze_clear', { address });
      if (r['ok'] !== true) { set({ error: String(r['error'] ?? 'could not change freeze') }); return; }
      set({ error: null, saved: get().saved.map((s) => (s.address === address ? { ...s, frozen } : s)) });
    },

    remove: async (address) => {
      const entry = get().saved.find((s) => s.address === address);
      if (entry?.frozen) await call('freeze_clear', { address });
      set({ saved: get().saved.filter((s) => s.address !== address) });
    },

    clear: () => set({ started: false, busy: false, count: 0, results: [], saved: [], error: null }),
  };
});

// A new or ended session means a fresh Cheat Engine: nothing here survives it.
let lastSessionId: string | null = useCeSessionStore.getState().sessionId;
useCeSessionStore.subscribe((s) => {
  if (s.sessionId !== lastSessionId) {
    lastSessionId = s.sessionId;
    useScannerStore.getState().clear();
  }
});
