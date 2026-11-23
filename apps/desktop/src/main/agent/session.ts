// apps/desktop/src/main/agent/session.ts
//
// The agent session: the safety core of the MCP agent.
//   - The agent only touches a game the player approved (attach asks first,
//     and anti-cheat is checked before asking and again right before attaching).
//   - One agent session at a time, owned by one MCP session (D4).
//   - Tiers: `open` always runs, `attached` needs this MCP session to own the
//     attached session, `modify` also needs "Agent can modify the game" and a
//     fresh anti-cheat check.
//   - Stop reverts everything the agent left running (freezes, watches, test
//     cheats, pointer scans), detaches (the daemon restores speed hooks and ends
//     scans) and releases the game. Every step is best-effort.
//   - `gen` goes up on Stop and when the switch goes off; anything tracked with
//     an older `gen` is reverted at once.
import {
  attach as engineAttach, listModules as engineListModules, setSpeed as engineSetSpeed, pointerEnd as enginePointerEnd,
  type EngineClient, type FreezeHandle, type ModuleInfo, type RunningCheat, type Session, type Watch,
} from '@starlight/engine';
import type { AgentPreferences, AgentSnapshot } from '../../shared/ipc.js';
import { antiCheatMessage, detectAntiCheat, type AntiCheatHit } from '../anti-cheat.js';
import type { GameIdentity } from '../game-identity.js';
import type { GameOwner } from '../game-owner.js';
import type { ActivityLog } from './activity.js';
import type { AgentHotkeysPort } from '../hotkey-host.js';
import type { PlayerPrompts } from './player-prompt.js';
import {
  DECLINED, MODIFY_OFF, NOT_ATTACHED, NO_ANSWER, OTHER_AGENT, STOPPED_MIDWAY, ToolError, describeEngineError,
  type AgentAccess, type AgentClient, type AttachedContext, type EngineApi, type Tier, type Tracker,
} from './tools.js';

export type { AgentSnapshot, AttachedContext, Tracker };

export type StopReason =
  | 'player' | 'hotkey' | 'agent' | 'agent-disconnected' | 'game-exited' | 'anti-cheat' | 'engine-closed' | 'app-quit';

export interface AttachInfo {
  pid: number;
  name: string;
  proton: boolean;
  steamAppId: number | null;
  buildId: string | null;
  canModify: boolean;
}

export interface AgentSessionDeps {
  getClient(): Promise<EngineClient>;
  engine?: Partial<Pick<EngineApi, 'attach' | 'listModules' | 'setSpeed' | 'pointerEnd'>>;
  detectAntiCheatFn?(pid: number): Promise<AntiCheatHit | null>;
  /**
   * I5: a refusal when `pid` isn't the player's own program (another user's or root's,
   * or Starlight itself), else null. Checked before asking and again before attaching.
   */
  checkTarget(pid: number): Promise<string | null>;
  identify(pid: number): Promise<GameIdentity>;
  owner: GameOwner;
  prompts: PlayerPrompts;
  hotkeys: AgentHotkeysPort;
  activity: ActivityLog;
  prefs(): Promise<AgentPreferences>;
  onChange(): void;
  focusAgentView(): void;
}

export interface AgentSession extends AgentAccess {
  /** `signal`: the agent's request; aborting it while the player is asked denies the attach. */
  attach(pid: number, client: AgentClient, o?: { signal?: AbortSignal }): Promise<AttachInfo>;
  stop(reason: StopReason): Promise<void>;
  setCanModify(on: boolean): Promise<void>;
  require(mcpSessionId: string, tier: Tier): Promise<AttachedContext | null>;
  snapshot(): AgentSnapshot;
  onMcpSessionClosed(mcpSessionId: string): Promise<void>;
  /** The attached game's pid, or null. */
  attachedPid(): number | null;
}

const STOP_NOTES: Record<StopReason, (label: string) => string> = {
  'player': () => 'Stopped by the player',
  'hotkey': () => 'Stopped with the hotkey',
  'agent': (l) => `${l} detached`,
  'agent-disconnected': (l) => `${l} disconnected`,
  'game-exited': () => 'The game exited',
  'anti-cheat': () => 'Anti-cheat loaded in the game; stopped',
  'engine-closed': () => 'The engine stopped',
  'app-quit': () => 'Starlight is quitting',
};

interface FreezeItem { h: FreezeHandle; info: { address: string; type: string; value: string }; where: string | null }
interface TestItem { c: RunningCheat; info: { name: string } }
interface WatchItem { w: Watch; info: { address: string; kind: 'write' | 'access'; endsAt: number } }

interface Attached {
  client: AgentClient;
  game: GameIdentity;
  session: Session;
  release: () => void;
  canModify: boolean;
  freezes: Map<number, FreezeItem>;
  tests: Map<number, TestItem>;
  watches: Map<number, WatchItem>;
  pointerScans: Set<number>;
  /** The speed the agent set, or null if it never did. */
  speed: number | null;
  modules: Promise<ModuleInfo[]> | null;
  unsubscribe: () => void;
  track: Tracker;
}

interface Asking { client: AgentClient; game: string }

const swallow = (p: Promise<unknown> | unknown): void => {
  if (p instanceof Promise) p.catch(() => {});
};

async function attempt(fn: () => unknown): Promise<void> {
  try { await fn(); } catch { /* best-effort */ }
}

function parseAddress(a: string): bigint | null {
  try {
    const s = a.trim();
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(s)) return null;
    return BigInt(s);
  } catch { return null; }
}

export function createAgentSession(deps: AgentSessionDeps): AgentSession {
  const eng = {
    attach: deps.engine?.attach ?? engineAttach,
    listModules: deps.engine?.listModules ?? engineListModules,
    setSpeed: deps.engine?.setSpeed ?? engineSetSpeed,
    pointerEnd: deps.engine?.pointerEnd ?? enginePointerEnd,
  };
  const antiCheat = deps.detectAntiCheatFn ?? ((pid: number) => detectAntiCheat(pid));

  let gen = 0;
  let controller = new AbortController();
  let cur: Attached | null = null;
  let asking: Asking | null = null;
  let nextItemId = 1;

  const changed = (): void => { try { deps.onChange(); } catch { /* listener's problem */ } };
  const note = (s: string): void => { try { deps.activity.note(s); } catch { /* never block a revert */ } };

  /** Every context handed out so far goes stale. */
  const bumpGen = (): void => {
    gen++;
    controller.abort();
    controller = new AbortController();
  };

  const checkAntiCheat = async (pid: number): Promise<AntiCheatHit | null> => antiCheat(pid).catch(() => null);

  /** Cancels freezes, stops watches and reverts test cheats (newest first). */
  async function revertChanges(a: Attached): Promise<void> {
    const freezes = [...a.freezes.values()];
    a.freezes.clear();
    for (const f of freezes) await attempt(() => f.h.cancel());
    const watches = [...a.watches.values()];
    a.watches.clear();
    for (const w of watches) await attempt(() => w.w.stop());
    const tests = [...a.tests.values()].reverse();
    a.tests.clear();
    for (const t of tests) await attempt(() => t.c.disable());
  }

  function makeTracker(a: Attached): Tracker {
    const stale = (g: number): boolean => g !== gen || cur !== a;
    const refuse = (revert: () => unknown): never => {
      try { swallow(revert()); } catch { /* best-effort */ }
      throw new ToolError(STOPPED_MIDWAY);
    };
    return {
      freeze(g, h, info) {
        if (stale(g)) refuse(() => h.cancel());
        const id = nextItemId++;
        const item: FreezeItem = { h, info: { ...info }, where: null };
        a.freezes.set(id, item);
        void describe(a, info.address).then((w) => {
          if (w !== null && a.freezes.get(id) === item) { item.where = w; changed(); }
        });
        changed();
        return id;
      },
      test(g, c, info) {
        if (stale(g)) refuse(() => c.disable());
        const id = nextItemId++;
        a.tests.set(id, { c, info: { ...info } });
        changed();
        return id;
      },
      watch(g, w, info) {
        if (stale(g)) refuse(() => w.stop());
        const id = nextItemId++;
        a.watches.set(id, { w, info: { ...info } });
        changed();
        return id;
      },
      pointerScan(g, id) {
        if (stale(g)) refuse(() => eng.pointerEnd(a.session, id));
        a.pointerScans.add(id);
      },
      speed(g, v) {
        if (stale(g)) refuse(() => (v !== 1 ? eng.setSpeed(a.session, 1) : undefined));
        a.speed = v;
        changed();
      },
      untrackFreeze(id) {
        const f = a.freezes.get(id);
        if (!f) return null;
        a.freezes.delete(id);
        changed();
        return f.h;
      },
      untrackTest(id) {
        const t = a.tests.get(id);
        if (!t) return null;
        a.tests.delete(id);
        changed();
        return t.c;
      },
      untrackWatch(id) {
        if (a.watches.delete(id)) changed();
      },
      liveTests: () => a.tests.size,
    };
  }

  async function describe(a: Attached, address: string): Promise<string | null> {
    const addr = parseAddress(address);
    if (addr === null) return null;
    if (!a.modules) {
      const p = eng.listModules(a.session);
      a.modules = p;
      p.catch(() => { if (a.modules === p) a.modules = null; });
    }
    let mods: ModuleInfo[];
    try { mods = await a.modules; } catch { return null; }
    for (const m of mods) {
      const base = parseAddress(m.base);
      const size = parseAddress(m.size);
      if (base === null || size === null) continue;
      if (addr >= base && addr < base + size) return `${m.name}+0x${(addr - base).toString(16)}`;
    }
    return null;
  }

  function info(a: Attached): AttachInfo {
    const g = a.game;
    return { pid: g.pid, name: g.name, proton: g.proton, steamAppId: g.steamAppId, buildId: g.buildId, canModify: a.canModify };
  }

  async function stop(reason: StopReason): Promise<void> {
    bumpGen();
    const a = cur;
    const ask = asking;
    cur = null;
    asking = null;
    try { deps.prompts.cancelAll(); } catch { /* best-effort */ }
    try { deps.hotkeys.set({ stop: null }); } catch { /* best-effort */ }
    if (a) {
      a.unsubscribe();
      await revertChanges(a);
      for (const id of a.pointerScans) await attempt(() => eng.pointerEnd(a.session, id));
      a.pointerScans.clear();
      // The daemon restores speed hooks and ends scans when the handle detaches.
      await attempt(() => a.session.detach());
      try { a.release(); } catch { /* best-effort */ }
    }
    const who = a?.client ?? ask?.client;
    if (who) note(STOP_NOTES[reason](who.label));
    changed();
  }

  async function attach(pid: number, client: AgentClient, o: { signal?: AbortSignal } = {}): Promise<AttachInfo> {
    if (cur) {
      if (cur.client.mcpSessionId !== client.mcpSessionId) throw new ToolError(OTHER_AGENT(cur.client.label, cur.game.name));
      if (cur.game.pid === pid) return info(cur);
      throw new ToolError(`Already attached to ${cur.game.name}. Call detach first.`);
    }
    if (asking) {
      if (asking.client.mcpSessionId !== client.mcpSessionId) throw new ToolError(OTHER_AGENT(asking.client.label, asking.game));
      throw new ToolError('An attach request is already waiting for the player.');
    }

    // 2. Only the player's own programs, never Starlight itself (I5), and no anti-cheat: refuse without asking.
    const notTarget = await deps.checkTarget(pid);
    if (notTarget) throw new ToolError(notTarget);
    const hit = await checkAntiCheat(pid);
    if (hit) throw new ToolError(antiCheatMessage(hit));
    if (cur || asking) return attach(pid, client, o);  // raced with another attach

    const myGen = gen;
    const ask: Asking = { client, game: String(pid) };
    asking = ask;
    changed();
    const abandon = (): void => {
      if (asking === ask) { asking = null; changed(); }
    };
    const stillMine = (): boolean => gen === myGen && asking === ask;

    let game: GameIdentity;
    let timeoutSec: number;
    try {
      game = await deps.identify(pid);
      ask.game = game.name;
      timeoutSec = (await deps.prefs()).approvalTimeoutSec;
    } catch (err) {
      abandon();
      throw err;
    }
    if (!stillMine()) throw new ToolError(STOPPED_MIDWAY);
    if (o.signal?.aborted) { abandon(); throw new ToolError(STOPPED_MIDWAY); }

    // 3. Ask the player. The agent giving up (cancel, disconnect) drops the card.
    const answer = await deps.prompts.requestApproval({
      label: client.label, game: game.name, pid,
      closesCeTable: deps.owner.ownerOf(pid)?.engine === 'ce',
      timeoutMs: timeoutSec * 1000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (!stillMine() || answer === 'stopped') { abandon(); throw new ToolError(STOPPED_MIDWAY); }
    if (answer === 'deny') { abandon(); throw new ToolError(DECLINED); }
    if (answer === 'timeout') { abandon(); throw new ToolError(NO_ANSWER(timeoutSec)); }
    changed();

    // 4. The target and anti-cheat again, right before attaching (the pid may have been reused).
    const lateTarget = await deps.checkTarget(pid).catch(() => null);
    if (lateTarget) { abandon(); throw new ToolError(lateTarget); }
    const late = await checkAntiCheat(pid);
    if (late) { abandon(); throw new ToolError(antiCheatMessage(late)); }
    if (!stillMine()) throw new ToolError(STOPPED_MIDWAY);

    // 5. Claim the game (closes a CE table the player just agreed to close).
    let release: () => void;
    try {
      release = await deps.owner.claim(pid, 'agent');
    } catch (err) {
      abandon();
      throw err;
    }
    if (!stillMine()) { release(); throw new ToolError(STOPPED_MIDWAY); }

    // 6. Attach the engine.
    let session: Session;
    try {
      const engineClient = await deps.getClient();
      session = await eng.attach(engineClient, pid);
    } catch (err) {
      release();
      abandon();
      throw new Error(describeEngineError(err), { cause: err });
    }
    if (!stillMine()) {
      await attempt(() => session.detach());
      release();
      throw new ToolError(STOPPED_MIDWAY);
    }

    const a: Attached = {
      client, game, session, release, canModify: true,
      freezes: new Map(), tests: new Map(), watches: new Map(), pointerScans: new Set(),
      speed: null, modules: null, unsubscribe: () => {}, track: undefined as unknown as Tracker,
    };
    a.track = makeTracker(a);
    const offDetached = session.onDetached((r) => {
      if (r === 'process-exit' && cur === a) void stop(session.client.closed ? 'engine-closed' : 'game-exited');
    });
    a.unsubscribe = offDetached;
    session.client.onClose(() => { if (cur === a) void stop('engine-closed'); });
    asking = null;
    cur = a;

    // The Stop hotkey works while the agent is attached.
    try {
      const stopKey = (await deps.prefs()).stop;
      if (cur === a) {
        const r = deps.hotkeys.set({ stop: stopKey }, { stop: () => { void stop('hotkey'); } });
        if (!r.ok) note(`Stop hotkey ${stopKey} isn't valid; use the Stop button`);
      }
    } catch { /* the Stop button still works */ }

    // 7. Tell the player.
    note(`${client.label} attached to ${game.name}`);
    try { deps.focusAgentView(); } catch { /* cosmetic */ }
    changed();
    return info(a);
  }

  async function require(mcpSessionId: string, tier: Tier): Promise<AttachedContext | null> {
    if (tier === 'open') return null;
    const a = cur;
    if (!a) throw new ToolError(NOT_ATTACHED);
    if (a.client.mcpSessionId !== mcpSessionId) throw new ToolError(OTHER_AGENT(a.client.label, a.game.name));
    if (tier === 'modify') {
      if (!a.canModify) throw new ToolError(MODIFY_OFF);
      const hit = await checkAntiCheat(a.game.pid);
      if (hit) {
        if (cur === a) await stop('anti-cheat');
        throw new ToolError(antiCheatMessage(hit));
      }
      if (cur !== a) throw new ToolError(STOPPED_MIDWAY);
      if (!a.canModify) throw new ToolError(MODIFY_OFF);
    }
    return {
      gen, session: a.session, game: a.game, client: a.client,
      describe: (address) => describe(a, address),
      track: a.track,
      signal: controller.signal,
    };
  }

  async function setCanModify(on: boolean): Promise<void> {
    const a = cur;
    if (!a || a.canModify === on) return;
    if (on) {
      a.canModify = true;
      note('Agent can modify the game');
      changed();
      return;
    }
    a.canModify = false;
    bumpGen();
    changed();
    await revertChanges(a);
    // R9: only when the agent changed speed; errors are ignored.
    if (a.speed !== null && a.speed !== 1) await attempt(() => eng.setSpeed(a.session, 1));
    a.speed = null;
    note("Agent can't modify the game now");
    changed();
  }

  function snapshot(): AgentSnapshot {
    const a = cur;
    const approval = deps.prompts.approval();
    const client = a?.client ?? asking?.client ?? null;
    return {
      status: a ? 'attached' : asking ? 'awaiting-approval' : 'idle',
      client: client ? { label: client.label, name: client.name } : null,
      approval: a ? null : approval,
      game: a ? {
        pid: a.game.pid, name: a.game.name, key: a.game.key, proton: a.game.proton,
        steamAppId: a.game.steamAppId, buildId: a.game.buildId,
      } : null,
      canModify: a?.canModify ?? false,
      questions: deps.prompts.pending(),
      live: {
        freezes: a ? [...a.freezes].map(([id, f]) => ({ id, address: f.info.address, where: f.where, type: f.info.type, value: f.info.value })) : [],
        tests: a ? [...a.tests].map(([id, t]) => ({ id, name: t.info.name })) : [],
        watches: a ? [...a.watches].map(([id, w]) => ({ id, address: w.info.address, kind: w.info.kind, endsAt: w.info.endsAt })) : [],
        speed: a?.speed ?? 1,
      },
      activity: deps.activity.entries(),
    };
  }

  return {
    attach,
    stop,
    setCanModify,
    require,
    snapshot,
    attachedPid: () => cur?.game.pid ?? null,
    async onMcpSessionClosed(mcpSessionId) {
      const owns = cur?.client.mcpSessionId === mcpSessionId || asking?.client.mcpSessionId === mcpSessionId;
      if (owns) await stop('agent-disconnected');
    },
  };
}
