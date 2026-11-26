import {
  attach as engineAttach, enableCheat as engineEnableCheat, verifyCheat as engineVerifyCheat,
  NeedsUpdateError, type EngineClient, type RunningCheat, type Session,
} from '@starlight/engine';
import { isPatchCheat, isValueCheat, type StarlightCheat, type StarlightTrainer } from '@starlight/ct-importer';
import type { IpcResult, SetActiveResult, UserCheatView } from '../shared/ipc.js';
import type { GameOwner } from './game-owner.js';
import { detectAntiCheat, antiCheatMessage } from './anti-cheat.js';
import { loadUserTrainer, removeUserCheat } from './user-cheats.js';

export interface UserCheatsHost {
  list(key: string, pid: number | null): Promise<UserCheatView[]>;
  setActive(req: { key: string; pid: number; id: string; on: boolean; closeCe?: boolean; value?: number }): Promise<SetActiveResult>;
  setValue(req: { key: string; pid: number; id: string; value: number }): Promise<IpcResult>;
  remove(key: string, id: string): Promise<IpcResult>;
  disableAll(pid: number): Promise<void>;
  end(): Promise<void>;
}

export interface UserCheatsHostDeps {
  dir: string;
  getClient(): Promise<EngineClient>;
  owner: GameOwner;
  attach?: typeof engineAttach;
  enableCheat?: typeof engineEnableCheat;
  verifyCheat?: typeof engineVerifyCheat;
  detectAntiCheatFn?: typeof detectAntiCheat;
  onChange?(key: string): void;
  /** Where a key's cheats come from; defaults to the player's library. Community keys load community cheats. */
  loadTrainer?(key: string, pid: number | null): Promise<{ trainer: StarlightTrainer; meta?: Map<string, NonNullable<UserCheatView['community']>> } | null>;
}

const COMMUNITY_KEY = /^community-\d+$/;

export const CLOSE_CE_MESSAGE = 'This will close the current Cheat Engine table — continue?';

interface Entry { key: string; id: string; running: RunningCheat; value: number | undefined }
interface PidState {
  session: Session | null;
  attaching: Promise<Session> | null;
  entries: Map<string, Entry>;
  release: (() => void) | null;
  unsubscribe: (() => void) | null;
  /** Serialises changes to this game. */
  queue: Promise<unknown>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const entryKey = (key: string, id: string): string => `${key}\0${id}`;

export function createUserCheatsHost(deps: UserCheatsHostDeps): UserCheatsHost {
  const attachFn = deps.attach ?? engineAttach;
  const enable = deps.enableCheat ?? engineEnableCheat;
  const verify = deps.verifyCheat ?? engineVerifyCheat;
  const antiCheat = deps.detectAntiCheatFn ?? detectAntiCheat;
  const load: NonNullable<UserCheatsHostDeps['loadTrainer']> = deps.loadTrainer ?? (async (key: string) => {
    const trainer = await loadUserTrainer(deps.dir, key);
    return trainer ? { trainer } : null;
  });
  const states = new Map<number, PidState>();
  let ended = false;

  const stateFor = (pid: number): PidState => {
    let s = states.get(pid);
    if (!s) {
      s = { session: null, attaching: null, entries: new Map(), release: null, unsubscribe: null, queue: Promise.resolve() };
      states.set(pid, s);
    }
    return s;
  };

  const exclusive = <T>(pid: number, fn: () => Promise<T>): Promise<T> => {
    const st = stateFor(pid);
    const run = st.queue.then(fn, fn);
    st.queue = run.catch(() => undefined);
    return run;
  };

  function releaseHold(st: PidState): void {
    const r = st.release;
    st.release = null;
    r?.();
  }

  /** Nothing is running for this game any more: give it back and drop the attachment this host made. */
  async function idle(pid: number, st: PidState): Promise<void> {
    if (st.entries.size > 0) return;
    releaseHold(st);
    const s = st.session;
    st.unsubscribe?.(); st.unsubscribe = null;
    st.session = null;
    if (states.get(pid) === st && !st.attaching) states.delete(pid);
    await s?.detach().catch(() => undefined);
  }

  /** The game went away (or we are shutting down): everything held for it is stale. */
  function forget(pid: number, st: PidState): void {
    const keys = new Set([...st.entries.values()].map((e) => e.key));
    st.entries.clear();
    st.unsubscribe?.(); st.unsubscribe = null;
    st.session = null; st.attaching = null;
    releaseHold(st);
    if (states.get(pid) === st) states.delete(pid);
    for (const k of keys) deps.onChange?.(k);
  }

  async function sessionFor(pid: number): Promise<Session> {
    const st = stateFor(pid);
    if (st.session && !st.session.attached) { st.session = null; }
    if (st.session) return st.session;
    st.attaching ??= (async () => {
      const hit = await antiCheat(pid);
      if (hit) throw new Error(antiCheatMessage(hit));
      const s = await attachFn(await deps.getClient(), pid);
      st.session = s;
      st.unsubscribe = s.onDetached(() => { if (st.session === s) forget(pid, st); });
      return s;
    })();
    const pending = st.attaching;
    try { return await pending; } finally { if (st.attaching === pending) st.attaching = null; }
  }

  async function findCheat(key: string, id: string): Promise<StarlightCheat | null> {
    const t = (await load(key, null))?.trainer;
    for (const c of t?.categories ?? []) {
      const hit = c.cheats.find((x) => x.id === id);
      if (hit) return hit;
    }
    return null;
  }

  async function disableEntry(st: PidState, ek: string): Promise<void> {
    const e = st.entries.get(ek);
    if (!e) return;
    await e.running.disable(); // rejects (and the cheat stays on) if a revert fails
    st.entries.delete(ek);
    deps.onChange?.(e.key);
  }

  async function turnOn(req: { key: string; pid: number; id: string; closeCe?: boolean; value?: number }): Promise<SetActiveResult> {
    const { key, pid, id } = req;
    const st = stateFor(pid);
    const ek = entryKey(key, id);
    if (st.entries.has(ek)) {
      if (req.value !== undefined) return setValueLocked({ key, pid, id, value: req.value });
      return { ok: true };
    }
    const cheat = await findCheat(key, id);
    if (!cheat) return { ok: false, error: `no cheat "${id}" in your library for this game` };
    if (!isValueCheat(cheat) && !isPatchCheat(cheat)) return { ok: false, error: "this cheat can't be run" };

    const hit = await antiCheat(pid);
    if (hit) return { ok: false, error: antiCheatMessage(hit) };

    const gaveHold = st.release === null;
    if (gaveHold) {
      const owner = deps.owner.ownerOf(pid);
      if (owner?.engine === 'ce') {
        if (!req.closeCe) return { ok: false, confirm: 'close-ce', error: CLOSE_CE_MESSAGE };
        st.release = await deps.owner.claim(pid, 'user-cheats');
      } else {
        st.release = deps.owner.hold(pid, 'user-cheats');
      }
    }
    const giveBack = (): Promise<void> => idle(pid, st);

    try {
      const session = await sessionFor(pid);
      const running = await enable(session, cheat, req.value !== undefined ? { value: req.value } : {});
      if (states.get(pid) !== st || ended || !session.attached) {
        // The game exited (or we are quitting) while the cheat was being turned on.
        await running.disable().catch(() => undefined);
        return { ok: false, error: 'the game is no longer running' };
      }
      st.entries.set(ek, { key, id, running, value: req.value });
      deps.onChange?.(key);
      return { ok: true };
    } catch (err) {
      await giveBack();
      if (err instanceof NeedsUpdateError) return { ok: false, error: `This cheat needs updating: ${err.reasons.join('; ')}` };
      return { ok: false, error: errMsg(err) };
    }
  }

  async function turnOff(key: string, pid: number, id: string): Promise<SetActiveResult> {
    const st = states.get(pid);
    if (!st) return { ok: true };
    try {
      await disableEntry(st, entryKey(key, id));
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    await idle(pid, st);
    return { ok: true };
  }

  async function setValueLocked(req: { key: string; pid: number; id: string; value: number }): Promise<IpcResult> {
    const e = states.get(req.pid)?.entries.get(entryKey(req.key, req.id));
    if (!e) return { ok: false, error: 'turn the cheat on first' };
    try {
      await e.running.setValue(req.value);
      e.value = req.value;
      deps.onChange?.(req.key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  return {
    async list(key, pid) {
      const loaded = await load(key, pid);
      if (!loaded) return [];
      const t = loaded.trainer;
      const cheats = t.categories.flatMap((c) => c.cheats);
      const verifyAll = async (session: Session | null): Promise<Map<string, UserCheatView['verify']>> => {
        const out = new Map<string, UserCheatView['verify']>();
        if (!session) return out;
        for (const cheat of cheats) {
          if (!session.attached) break;
          try {
            const r = await verify(session, cheat);
            out.set(cheat.id, { status: r.status, reasons: r.reasons });
          } catch { /* leave null */ }
        }
        return out;
      };

      let results = new Map<string, UserCheatView['verify']>();
      if (pid !== null && !ended) {
        results = await exclusive(pid, async () => {
          const st = stateFor(pid);
          // Already ours: verify through the live session. Held by Cheat Engine: leave it alone.
          if (st.session?.attached && st.release) return verifyAll(st.session);
          if (deps.owner.ownerOf(pid)?.engine === 'ce') { if (!st.session && st.entries.size === 0) states.delete(pid); return new Map(); }
          const release = st.release ? null : deps.owner.hold(pid, 'user-cheats');
          if (release) st.release = release;
          try {
            return await verifyAll(await sessionFor(pid).catch(() => null));
          } finally {
            await idle(pid, st);
          }
        });
      }
      const st = pid !== null ? states.get(pid) : undefined;
      return cheats.map((cheat) => {
        const e = st?.entries.get(entryKey(key, cheat.id));
        const community = loaded.meta?.get(cheat.id);
        return {
          cheat, active: !!e, ...(e?.value !== undefined ? { value: e.value } : {}), verify: results.get(cheat.id) ?? null,
          ...(community ? { community } : {}),
        };
      });
    },

    setActive(req) {
      if (ended) return Promise.resolve({ ok: false, error: 'Starlight is shutting down' });
      return exclusive(req.pid, () => (req.on ? turnOn(req) : turnOff(req.key, req.pid, req.id)));
    },

    setValue(req) {
      return exclusive(req.pid, () => setValueLocked(req));
    },

    async remove(key, id) {
      if (COMMUNITY_KEY.test(key)) return { ok: false, error: "Community cheats can't be deleted here." };
      for (const [pid, st] of [...states]) {
        const ek = entryKey(key, id);
        if (!st.entries.has(ek)) continue;
        const r = await exclusive(pid, () => turnOff(key, pid, id));
        if (!r.ok) return { ok: false, error: `Turn the cheat off first: ${r.error}` };
      }
      try {
        const removed = await removeUserCheat(deps.dir, key, id);
        if (!removed) return { ok: false, error: `no cheat "${id}" in your library for this game` };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
      deps.onChange?.(key);
      return { ok: true };
    },

    async disableAll(pid) {
      await exclusive(pid, async () => {
        const st = states.get(pid);
        if (!st) return;
        for (const ek of [...st.entries.keys()]) await disableEntry(st, ek).catch(() => undefined);
        await idle(pid, st);
      });
    },

    async end() {
      ended = true;
      for (const [pid, st] of [...states]) {
        await exclusive(pid, async () => {
          for (const ek of [...st.entries.keys()]) await disableEntry(st, ek).catch(() => undefined);
          const s = st.session;
          st.unsubscribe?.(); st.unsubscribe = null;
          st.entries.clear(); st.session = null; st.attaching = null;
          releaseHold(st);
          states.delete(pid);
          await s?.detach().catch(() => undefined);
        });
      }
    },
  };
}
