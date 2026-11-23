import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CePickStep, CeSessionRecord, CeSessionTableState, CeTable, CeTableAttempt, CeTableVerdict, LaunchTarget } from '../../shared/ipc.js';
import { buildCheatList } from '../../shared/cheat-list.js';
import { hotkeyPayload } from '../lib/hotkeys.js';
import { playToggleTone } from '../lib/tone.js';
import { launchTargetFor } from '../lib/installed.js';
import { useConfigStore } from './config-store.js';

export interface StartReq {
  /** Single thread/.CT URL (legacy callers). Prefer `sources`. */
  source?: string | undefined;
  /** Every thread/.CT URL known for the game. Empty = tools-only session. */
  sources?: string[] | undefined;
  /** A table the user explicitly picked. Omit to let Starlight find one that matches the game. */
  tableId?: number | undefined;
  /** The installed game to start when the user presses Play. Absent = not in the library. */
  launch?: LaunchTarget | undefined;
  cacheKey: string;
  /** Game name shown at the top of the session. */
  title?: string | undefined;
  pid?: number | undefined;
  processName?: string | undefined;
  game?: { id: string; name: string; steamAppId?: number | null } | undefined;
}

interface CeSessionState {
  sessionId: string | null;
  /** Game name for the session header. */
  title: string | null;
  records: CeSessionRecord[];
  starting: boolean;
  startError: string | null;
  /** Why the last start failed ('ptrace' gets an Allow button). */
  startReason: string | null;
  /** The permission prompt for native games is open. */
  allowingAccess: boolean;
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
  /** record id → why its last toggle/edit failed (the table's own message). */
  recordErrors: Record<number, string>;
  /** True when the IPC result indicates the game isn't currently running. */
  notRunning: boolean;
  /** True when the session needs the user to pick the game process. */
  needsPicker: boolean;
  /** Every table available for this game, newest first. */
  tables: CeTable[];
  /** The loaded table (attachment id), or null. */
  tableId: number | null;
  /** Set when the table file itself failed to load. */
  tableError: string | null;
  /** Current game speed multiplier (1 = normal). */
  speed: number;
  speedError: string | null;
  /** Prerequisite scripts switched on automatically; hidden from the cheat list. */
  hiddenIds: number[];
  /** How the loaded table fared against the running game. */
  verdict: CeTableVerdict;
  /** Every table tried to get here, in order. */
  attempts: CeTableAttempt[];
  /** False when the game was looked for and isn't running. */
  running: boolean;
  /** Set while Play is starting the game and waiting for it. */
  launch: { phase: 'launching' | 'waiting'; title: string } | null;
  /** What the session is doing right now, for the starting screen. */
  progress: string | null;
  /** The tables being checked against the game right now, and how each fared. */
  pickSteps: CePickStep[];
  /** True while looking again for a table that matches. */
  retrying: boolean;
  /** Automatic retries made so far for this session. */
  retries: number;

  start: (req: StartReq) => Promise<boolean>;
  /** Re-launch the current session targeting a running process (boots Windows CE if Proton). */
  attach: (pid: number, processName?: string) => Promise<boolean>;
  /** Re-launch the session with a different table, staying on the same process. */
  switchTable: (tableId: number) => Promise<boolean>;
  setActive: (recordId: number, active: boolean) => Promise<void>;
  setValue: (recordId: number, value: string) => Promise<void>;
  /** Re-read which cheats are on and the current values. */
  refresh: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  end: () => Promise<void>;
  /** The game closed (main already shut Cheat Engine): show its cheat list with Play again. */
  gameExited: (sessionId: string) => Promise<void>;
  /** Start the game (if it isn't running), wait for it, then attach. */
  play: (req?: StartReq) => Promise<boolean>;
  /** Grants Starlight access to native games' memory (password prompt), then attaches again. */
  allowMemoryAccess: () => Promise<void>;
  cancelPlay: () => void;
  /** Look again for a table that matches the game. */
  retry: (opts?: { auto?: boolean }) => Promise<void>;
  /** A cheat was toggled by its in-game hotkey. */
  applyHotkey: (e: { recordId: number; ok: boolean; active: boolean; error?: string | undefined }) => void;
  /** Bind (or with null, remove) the hotkey for a cheat; remembered per game. */
  setHotkey: (recordName: string, accelerator: string | null) => Promise<void>;
  /** Clear a cheat's custom hotkey so it goes back to the default. */
  resetHotkey: (recordName: string) => Promise<void>;
  /** Push the current hotkey set to Cheat Engine. */
  syncHotkeys: () => Promise<void>;
}

/** Timings for the Play flow (overridable in tests). */
export const playTiming = {
  /** How often to look for the game's process after launching it. */
  pollMs: 2000,
  /** Give up waiting for the game after this long (covers Steam updates and cloud sync). */
  timeoutMs: 5 * 60_000,
};

let playToken = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tableState(r: CeSessionTableState): Pick<CeSessionState, 'records' | 'tableId' | 'tableError' | 'hiddenIds' | 'verdict' | 'attempts' | 'recordErrors'> {
  return {
    records: r.records,
    tableId: r.tableId ?? null,
    tableError: r.tableError ?? null,
    hiddenIds: r.hiddenIds ?? [],
    verdict: r.verdict ?? 'unknown',
    attempts: r.attempts ?? [],
    recordErrors: { ...(r.prereqErrors ?? {}) },
  };
}

const CLEARED = {
  sessionId: null as string | null,
  records: [] as CeSessionRecord[],
  pending: new Set<number>(),
  recordErrors: {} as Record<number, string>,
  attached: false,
  proton: false,
  attachedTo: null,
  notRunning: false,
  needsPicker: false,
  tables: [] as CeTable[],
  tableId: null as number | null,
  tableError: null as string | null,
  speed: 1,
  speedError: null as string | null,
  hiddenIds: [] as number[],
  verdict: 'unknown' as CeTableVerdict,
  attempts: [] as CeTableAttempt[],
  running: true,
  progress: null as string | null,
  pickSteps: [] as CePickStep[],
  retrying: false,
  retries: 0,
};

export const useCeSessionStore = create<CeSessionState>((set, get) => ({
  ...CLEARED,
  title: null,
  starting: false,
  startError: null,
  startReason: null,
  allowingAccess: false,
  lastReq: null,
  launch: null,

  start: async (req) => {
    // One game at a time: a connected (or connecting) game is never replaced
    // by opening another — it stays until the game quits.
    const cur = get();
    const connecting = cur.launch !== null || (cur.starting && cur.lastReq?.pid !== undefined);
    const sameGame = cur.lastReq?.cacheKey === req.cacheKey;
    // Re-opening the connected game just shows it; asking for a specific table
    // or process on it is a deliberate reconnect and goes ahead.
    if (sameGame && (cur.attached || connecting) && req.tableId === undefined && req.pid === undefined) {
      set({ startError: null });
      return true;
    }
    if (!sameGame && ((cur.attached && cur.sessionId) || connecting)) {
      const name = cur.title ?? 'The current game';
      const next = req.title ?? req.game?.name ?? 'another game';
      set({
        startError: connecting
          ? `${name} is still starting. Cancel it first to open ${next}.`
          : `${name} is still connected. Quit it to use cheats in ${next}.`,
      });
      return false;
    }
    set({ starting: true, startError: null, startReason: null, lastReq: req, notRunning: false, needsPicker: false, progress: null, pickSteps: [], title: req.title ?? req.game?.name ?? null });
    try {
      // `launch` and `title` are renderer-side only.
      const { launch: _launch, title: _title, ...ipcReq } = req;
      const r = await starlight().ceSessionStart(ipcReq);
      // Main ends any previous session before starting, so on failure there is none.
      // Main kept the connected game: leave it on screen, just say why.
      if (!r.ok && r.reason === 'busy') { set({ starting: false, startError: r.error }); return false; }
      if (!r.ok) { set({ ...CLEARED, starting: false, startError: r.error, startReason: r.reason ?? null, notRunning: r.reason === 'not-running' }); return false; }
      set({
        ...CLEARED,
        starting: false,
        sessionId: r.sessionId,
        attached: r.attached,
        proton: r.proton,
        attachedTo: r.process ?? (req.pid !== undefined ? { pid: req.pid, name: req.processName } : null),
        needsPicker: r.needsPicker ?? false,
        running: r.running !== false,
        tables: r.tables ?? [],
        ...tableState(r),
      });
      if (r.attached) void get().syncHotkeys();
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

  switchTable: async (tableId) => {
    const base = get().lastReq;
    if (!base) return false;
    const target = get().attachedTo;
    await get().end();
    return get().start({
      ...base,
      tableId,
      ...(target ? { pid: target.pid, processName: target.name } : {}),
    });
  },

  setActive: async (recordId, active) => {
    const sid = get().sessionId;
    if (!sid) return;
    const pending = new Set(get().pending); pending.add(recordId);
    const errors = { ...get().recordErrors }; delete errors[recordId];
    set({ pending, startError: null, recordErrors: errors });
    try {
      const r = await starlight().ceSessionSetActive({ sessionId: sid, recordId, active });
      if (get().sessionId !== sid) return;
      if (r.ok) {
        set({ records: get().records.map((x) => (x.id === recordId ? { ...x, isActive: active } : x)) });
      } else {
        set({ recordErrors: { ...get().recordErrors, [recordId]: r.error ?? 'toggle failed' } });
      }
    } catch (err) {
      set({ recordErrors: { ...get().recordErrors, [recordId]: err instanceof Error ? err.message : String(err) } });
    } finally {
      const next = new Set(get().pending); next.delete(recordId);
      set({ pending: next });
    }
    // A cheat turning on can activate children and make their values readable.
    void get().refresh();
  },

  setValue: async (recordId, value) => {
    const sid = get().sessionId;
    if (!sid) return;
    const errors = { ...get().recordErrors }; delete errors[recordId];
    set({ recordErrors: errors });
    const r = await starlight().ceSessionCall({ sessionId: sid, method: 'set_value', params: { id: recordId, value } })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as Record<string, unknown>);
    if (get().sessionId !== sid) return;
    if (r['ok']) {
      const shown = typeof r['value'] === 'string' ? r['value'] : value;
      set({ records: get().records.map((x) => (x.id === recordId ? { ...x, value: shown } : x)) });
    } else {
      set({ recordErrors: { ...get().recordErrors, [recordId]: String(r['error'] ?? 'could not set value') } });
    }
  },

  refresh: async () => {
    const sid = get().sessionId;
    if (!sid || !get().attached) return;
    const r = await starlight().ceSessionCall({ sessionId: sid, method: 'refresh' }).catch(() => null);
    if (!r || get().sessionId !== sid || !Array.isArray(r['states'])) return;
    const byId = new Map<number, { a?: boolean; v?: string }>();
    for (const s of r['states'] as { id: number; a?: boolean; v?: string }[]) byId.set(s.id, s);
    const pending = get().pending;
    let changed = false;
    const records = get().records.map((x) => {
      const s = byId.get(x.id);
      if (!s || pending.has(x.id)) return x;
      const isActive = s.a ?? x.isActive;
      const value = s.v ?? x.value;
      if (isActive === x.isActive && value === x.value) return x;
      changed = true;
      return { ...x, isActive, ...(value !== undefined ? { value } : {}) };
    });
    if (changed) set({ records });
  },

  setSpeed: async (speed) => {
    const sid = get().sessionId;
    if (!sid) return;
    set({ speedError: null });
    const r = await starlight().ceSessionCall({ sessionId: sid, method: 'set_speed', params: { speed } })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as Record<string, unknown>);
    if (get().sessionId !== sid) return;
    if (r['ok']) set({ speed });
    else set({ speedError: String(r['error'] ?? 'could not change game speed') });
  },

  end: async () => {
    const sid = get().sessionId;
    playToken++;
    set({ ...CLEARED, launch: null });
    if (!sid) return;
    await starlight().ceSessionEnd({ sessionId: sid }).catch(() => {});
  },

  gameExited: async (sessionId) => {
    if (get().sessionId !== sessionId) return;
    const base = get().lastReq;
    set({ ...CLEARED, launch: null });
    if (!base) return;
    const { pid: _pid, processName: _name, ...rest } = base;
    await get().start(rest);
  },

  play: async (given) => {
    const req = given ?? get().lastReq;
    if (!req) return false;
    const title = req.title ?? req.game?.name ?? 'the game';
    const token = ++playToken;
    const live = (): boolean => token === playToken;
    const find = async (): Promise<{ pid: number; name: string } | null> =>
      req.game ? starlight().findGameProcess({ game: req.game }).catch(() => null) : null;

    set({ launch: { phase: 'launching', title }, startError: null, startReason: null, lastReq: req });
    let proc = await find();
    if (!live()) return false;
    if (!proc) {
      // The library scan may have finished after this game was opened.
      const target = req.launch ?? (req.game ? launchTargetFor(req.game) : undefined);
      if (!target) { set({ launch: null, startError: `${title} isn't running — start it, then attach.` }); return false; }
      const r = await starlight().launchGame(target).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
      if (!live()) return false;
      if (!r.ok) { set({ launch: null, startError: r.error }); return false; }
      set({ launch: { phase: 'waiting', title } });
      const deadline = Date.now() + playTiming.timeoutMs;
      while (!proc && Date.now() < deadline) {
        await sleep(playTiming.pollMs);
        if (!live()) return false;
        proc = await find();
        if (!live()) return false;
      }
      if (!proc) { set({ launch: null, startError: `${title} didn't start. Launch it yourself, then attach.` }); return false; }
    }
    // Attach right away: Cheat Engine starts while the game loads, and main
    // waits for the game's code before matching a table.
    set({ launch: null });
    // Only the pid: main reads the full (untruncated) process name itself.
    return get().start({ ...req, pid: proc.pid, processName: undefined });
  },

  allowMemoryAccess: async () => {
    if (get().allowingAccess) return;
    set({ allowingAccess: true });
    const r = await starlight().allowMemoryAccess()
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    set({ allowingAccess: false });
    if (!r.ok) {
      // A dismissed prompt leaves the original explanation (and its button) up.
      if (!('cancelled' in r && r.cancelled)) set({ startError: r.error, startReason: null });
      return;
    }
    const req = get().lastReq;
    if (req) await get().start(req);
  },

  cancelPlay: () => {
    playToken++;
    set({ launch: null });
  },

  retry: async (opts) => {
    const sid = get().sessionId;
    if (!sid || !get().attached || get().retrying) return;
    set({ retrying: true, pickSteps: [], retries: get().retries + (opts?.auto ? 1 : 0) });
    try {
      const r = await starlight().ceSessionRetry({ sessionId: sid });
      if (get().sessionId !== sid) return;
      if (r.ok) {
        set({ ...tableState(r), pending: new Set<number>() });
        void get().syncHotkeys();
      }
    } catch { /* keep what we have */ } finally {
      if (get().sessionId === sid) set({ retrying: false, progress: null });
    }
  },

  applyHotkey: (e) => {
    if (!get().sessionId) return;
    const errors = { ...get().recordErrors };
    if (e.ok) delete errors[e.recordId]; else errors[e.recordId] = e.error ?? 'toggle failed';
    set({
      records: get().records.map((x) => (x.id === e.recordId ? { ...x, isActive: e.active } : x)),
      recordErrors: errors,
    });
    playToggleTone(!e.ok ? 'error' : e.active ? 'on' : 'off');
    void get().refresh();
  },

  setHotkey: async (recordName, accelerator) => {
    const key = get().lastReq?.cacheKey;
    if (!key) return;
    await useConfigStore.getState().update({ cheatHotkeys: { [key]: { [recordName]: accelerator } } });
    await get().syncHotkeys();
  },

  resetHotkey: async (recordName) => {
    const key = get().lastReq?.cacheKey;
    if (!key) return;
    // The config merge can't delete a key; an empty string means "back to the default".
    await useConfigStore.getState().update({ cheatHotkeys: { [key]: { [recordName]: '' } } });
    await get().syncHotkeys();
  },

  syncHotkeys: async () => {
    const s = get();
    const sid = s.sessionId;
    if (!sid || !s.attached) return;
    const cfg = useConfigStore.getState().config;
    const enabled = cfg?.preferences.cheatHotkeys !== false;
    const overrides = cfg?.cheatHotkeys?.[s.lastReq?.cacheKey ?? ''] ?? {};
    const items = buildCheatList(s.records, { transparentIds: new Set(s.hiddenIds), revealAll: true }).sections.flatMap((x) => x.items);
    const payload = enabled ? hotkeyPayload(items, overrides) : { bindings: [], replace: [] };
    await starlight().ceSessionCall({ sessionId: sid, method: 'set_hotkeys', params: payload }).catch(() => {});
  },
}));
