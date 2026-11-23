// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { DetachReason, EngineClient, FreezeHandle, RunningCheat, Session, Watch } from '@starlight/engine';
import { createAgentSession, type AgentSessionDeps } from '../../../src/main/agent/session.js';
import { createActivityLog } from '../../../src/main/agent/activity.js';
import { createPlayerPrompts, type PlayerPrompts } from '../../../src/main/agent/player-prompt.js';
import { createGameOwner } from '../../../src/main/game-owner.js';
import { antiCheatMessage, type AntiCheatHit } from '../../../src/main/anti-cheat.js';
import {
  DECLINED, MODIFY_OFF, NOT_ATTACHED, NO_ANSWER, OTHER_AGENT, STOPPED_MIDWAY, type AgentClient,
} from '../../../src/main/agent/tools.js';
import type { GameIdentity } from '../../../src/main/game-identity.js';
import { DEFAULT_AGENT_PREFS } from '../../../src/shared/ipc.js';

const PID = 42;
const CLAUDE: AgentClient = { mcpSessionId: 's1', name: 'claude-code', version: '2.0', label: 'Claude' };
const CODEX: AgentClient = { mcpSessionId: 's2', name: 'codex', version: '0.1', label: 'Codex' };
const EAC: AntiCheatHit = { name: 'Easy Anti-Cheat', module: 'easyanticheat_x64.dll' };

const identity: GameIdentity = {
  pid: PID, name: '9Kings.exe', key: '9kings', exeName: '9Kings.exe', proton: true,
  steamAppId: 123, buildId: '7', exeHash: 'abc', catalogId: null,
};

function fakeClient(): EngineClient & { fireClose(): void; setClosed(v: boolean): void } {
  let closed = false;
  const closeCbs: Array<() => void> = [];
  return {
    get closed() { return closed; },
    capabilities: [],
    call: vi.fn(async () => ({})),
    onNotification: () => () => {},
    onClose(cb) { closeCbs.push(cb); },
    close: async () => {},
    fireClose() { closed = true; for (const cb of closeCbs) cb(); },
    setClosed(v) { closed = v; },
  } as EngineClient & { fireClose(): void; setClosed(v: boolean): void };
}

function fakeSession(client: EngineClient, log: string[]): Session & { fireDetached(r: DetachReason): void } {
  const cbs: Array<(r: DetachReason) => void> = [];
  let attached = true;
  return {
    pid: PID, handle: 1, client,
    get attached() { return attached; },
    detach: vi.fn(async () => { log.push('detach'); attached = false; }),
    onDetached(cb) { cbs.push(cb); return () => { const i = cbs.indexOf(cb); if (i >= 0) cbs.splice(i, 1); }; },
    fireDetached(r) { attached = false; for (const cb of [...cbs]) cb(r); },
  } as Session & { fireDetached(r: DetachReason): void };
}

function freezeHandle(log: string[], name: string, fail = false): FreezeHandle & { cancel: ReturnType<typeof vi.fn> } {
  return { active: true, cancel: vi.fn(async () => { log.push(`cancel ${name}`); if (fail) throw new Error('boom'); }) };
}
function runningCheat(log: string[], name: string): RunningCheat & { disable: ReturnType<typeof vi.fn> } {
  return { kind: 'patch', address: '0x10', setValue: async () => {}, disable: vi.fn(async () => { log.push(`disable ${name}`); }) };
}
function watch(log: string[], name: string): Watch & { stop: ReturnType<typeof vi.fn> } {
  return {
    id: 1, poll: async () => ({ hits: [] }) as never, onEnded: () => {},
    stop: vi.fn(async () => { log.push(`stop ${name}`); return { hits: [] } as never; }),
  };
}

function setup(o: {
  antiCheat?: (pid: number) => Promise<AntiCheatHit | null>;
  ceSession?: { sessionId: string } | null;
  prompts?: Partial<PlayerPrompts>;
  attachFails?: boolean;
} = {}) {
  const log: string[] = [];
  const client = fakeClient();
  const session = fakeSession(client, log);
  const releaseCe = vi.fn(async () => { log.push('releaseCe'); });
  const owner = createGameOwner({ ceSessionFor: () => o.ceSession ?? null, releaseCe });
  const claim = owner.claim.bind(owner);
  owner.claim = vi.fn(async (pid, h) => { log.push(`claim ${h}`); return claim(pid, h); });
  const notifier = { show: vi.fn(() => ({ close: () => {} })) };
  const focusAgentView = vi.fn();
  const onChange = vi.fn();
  const hkSet = vi.fn((..._a: unknown[]) => ({ ok: true as const }));
  const hotkeys = { set: hkSet as never };
  const realPrompts = createPlayerPrompts({ notifier, focusAgentView, onChange, hotkeys, prefs: async () => ({ ...DEFAULT_AGENT_PREFS }) });
  const prompts: PlayerPrompts = { ...realPrompts, ...o.prompts };
  const requestApproval = vi.spyOn(prompts, 'requestApproval');
  const activity = createActivityLog({ onChange });
  const engine = {
    attach: vi.fn(async () => {
      log.push('attach');
      if (o.attachFails) throw new Error('attach failed');
      return session;
    }),
    listModules: vi.fn(async () => [{ name: '9Kings.exe', base: '0x140000000', size: '0x10000', path: '/g/9Kings.exe', kind: 'pe' as const }]),
    setSpeed: vi.fn(async () => { log.push('setSpeed 1'); return {} as never; }),
    pointerEnd: vi.fn(async (_s: Session, id: number) => { log.push(`pointerEnd ${id}`); }),
  };
  const deps: AgentSessionDeps = {
    getClient: async () => client,
    engine,
    detectAntiCheatFn: o.antiCheat ?? (async () => null),
    identify: async () => identity,
    owner,
    prompts,
    hotkeys,
    activity,
    prefs: async () => ({ ...DEFAULT_AGENT_PREFS }),
    onChange,
    focusAgentView,
  };
  const agent = createAgentSession(deps);
  const notes = (): string[] => activity.entries().filter((e) => e.status === 'note').map((e) => e.summary).reverse();
  return { hkSet, agent, log, client, session, owner, prompts: realPrompts, requestApproval, activity, engine, releaseCe, focusAgentView, notes };
}

type Setup = ReturnType<typeof setup>;

async function approve(s: Setup, allow = true): Promise<void> {
  await vi.waitFor(() => expect(s.prompts.approval()).not.toBeNull());
  s.prompts.respondApproval(s.prompts.approval()!.id, allow);
}

async function attached(s: Setup, client = CLAUDE): Promise<void> {
  const p = s.agent.attach(PID, client);
  await approve(s);
  await p;
}

describe('agent session', () => {
  it('attach refuses a game with anti-cheat loaded without asking the player', async () => {
    const s = setup({ antiCheat: async () => EAC });
    await expect(s.agent.attach(PID, CLAUDE)).rejects.toThrow(antiCheatMessage(EAC));
    expect(s.requestApproval).not.toHaveBeenCalled();
    expect(s.engine.attach).not.toHaveBeenCalled();
    expect(s.agent.snapshot().status).toBe('idle');
  });

  it('attach waits for the player and attaches on Allow', async () => {
    const s = setup();
    const p = s.agent.attach(PID, CLAUDE);
    await vi.waitFor(() => expect(s.agent.snapshot().status).toBe('awaiting-approval'));
    await vi.waitFor(() => expect(s.agent.snapshot().approval).not.toBeNull());
    expect(s.agent.snapshot().approval).toMatchObject({ label: 'Claude', game: '9Kings.exe', pid: PID, closesCeTable: false });
    expect(s.requestApproval).toHaveBeenCalledWith({ label: 'Claude', game: '9Kings.exe', pid: PID, closesCeTable: false, timeoutMs: 120_000 });
    expect(s.engine.attach).not.toHaveBeenCalled();
    await approve(s);
    await expect(p).resolves.toEqual({ pid: PID, name: '9Kings.exe', proton: true, steamAppId: 123, buildId: '7', canModify: true });
    expect(s.log).toEqual(['claim agent', 'attach']);
    expect(s.owner.holders(PID)).toEqual(['agent']);
    const snap = s.agent.snapshot();
    expect(snap).toMatchObject({
      status: 'attached', client: { label: 'Claude', name: 'claude-code' }, approval: null, canModify: true, questions: [],
      game: { pid: PID, name: '9Kings.exe', key: '9kings', proton: true, steamAppId: 123, buildId: '7' },
      live: { freezes: [], tests: [], watches: [], speed: 1 },
    });
    expect(s.notes()).toEqual(['Claude attached to 9Kings.exe']);
    expect(s.focusAgentView).toHaveBeenCalled();
  });

  it('Deny returns the declined message; timeout returns the no-answer message', async () => {
    const s = setup();
    const p = s.agent.attach(PID, CLAUDE);
    await approve(s, false);
    await expect(p).rejects.toThrow(DECLINED);
    expect(s.agent.snapshot().status).toBe('idle');
    expect(s.engine.attach).not.toHaveBeenCalled();
    expect(s.owner.holders(PID)).toEqual([]);

    const t = setup({ prompts: { requestApproval: async () => 'timeout' } });
    await expect(t.agent.attach(PID, CLAUDE)).rejects.toThrow(NO_ANSWER(120));
    expect(t.agent.snapshot().status).toBe('idle');
    expect(t.engine.attach).not.toHaveBeenCalled();
  });

  it('approval on a CE-owned game says so and closes the table before attaching', async () => {
    const s = setup({ ceSession: { sessionId: 'ce1' } });
    const p = s.agent.attach(PID, CLAUDE);
    await approve(s);
    await p;
    expect(s.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ closesCeTable: true }));
    expect(s.releaseCe).toHaveBeenCalledWith('ce1');
    expect(s.log).toEqual(['claim agent', 'releaseCe', 'attach']);
  });

  it('anti-cheat is checked again after approval, before attaching', async () => {
    let calls = 0;
    const s = setup({ antiCheat: async () => (++calls > 1 ? EAC : null) });
    const p = s.agent.attach(PID, CLAUDE);
    await approve(s);
    await expect(p).rejects.toThrow(antiCheatMessage(EAC));
    expect(calls).toBe(2);
    expect(s.owner.claim).not.toHaveBeenCalled();
    expect(s.engine.attach).not.toHaveBeenCalled();
    expect(s.agent.snapshot().status).toBe('idle');
  });

  it('an engine attach that fails releases the game', async () => {
    const s = setup({ attachFails: true });
    const p = s.agent.attach(PID, CLAUDE);
    await approve(s);
    await expect(p).rejects.toThrow('attach failed');
    expect(s.owner.holders(PID)).toEqual([]);
    expect(s.agent.snapshot().status).toBe('idle');
  });

  it('tools before attach say Not attached', async () => {
    const s = setup();
    await expect(s.agent.require('s1', 'open')).resolves.toBeNull();
    await expect(s.agent.require('s1', 'attached')).rejects.toThrow(NOT_ATTACHED);
    await expect(s.agent.require('s1', 'modify')).rejects.toThrow(NOT_ATTACHED);
  });

  it('a second agent cannot attach or use tools while one is attached', async () => {
    const s = setup();
    await attached(s);
    const msg = OTHER_AGENT('Claude', '9Kings.exe');
    await expect(s.agent.attach(PID, CODEX)).rejects.toThrow(msg);
    await expect(s.agent.require('s2', 'attached')).rejects.toThrow(msg);
    await expect(s.agent.require('s2', 'modify')).rejects.toThrow(msg);
    await expect(s.agent.require('s2', 'open')).resolves.toBeNull();
    expect(s.requestApproval).toHaveBeenCalledTimes(1);
    // The owner's tools still work.
    const ctx = await s.agent.require('s1', 'attached');
    expect(ctx!.game.name).toBe('9Kings.exe');
  });

  it('a second agent cannot attach while an approval is waiting', async () => {
    const s = setup();
    const p = s.agent.attach(PID, CLAUDE);
    await vi.waitFor(() => expect(s.prompts.approval()).not.toBeNull());
    await expect(s.agent.attach(PID, CODEX)).rejects.toThrow(OTHER_AGENT('Claude', '9Kings.exe'));
    await approve(s);
    await p;
  });

  it('describe names an address by module and offset', async () => {
    const s = setup();
    await attached(s);
    const ctx = (await s.agent.require('s1', 'attached'))!;
    await expect(ctx.describe('0x140001234')).resolves.toBe('9Kings.exe+0x1234');
    await expect(ctx.describe('0x10')).resolves.toBeNull();
    await expect(ctx.describe('junk')).resolves.toBeNull();
    expect(s.engine.listModules).toHaveBeenCalledTimes(1);
  });

  it('the Stop hotkey is bound while attached, stops the session, and is unbound after', async () => {
    const s = setup();
    expect(s.hkSet).not.toHaveBeenCalled();
    await attached(s);
    expect(s.hkSet).toHaveBeenCalledWith({ stop: 'Ctrl+Shift+End' }, { stop: expect.any(Function) });
    const on = s.hkSet.mock.calls.find((c) => (c[0] as { stop?: string }).stop === 'Ctrl+Shift+End')![1] as { stop(): void };
    on.stop();
    await vi.waitFor(() => expect(s.agent.snapshot().status).toBe('idle'));
    expect(s.hkSet).toHaveBeenLastCalledWith({ stop: null });
    await vi.waitFor(() => expect(s.notes()).toContain('Stopped with the hotkey'));
  });

  it('Stop resolves a pending question and the snapshot lists it', async () => {
    const s = setup();
    await attached(s);
    const a = s.prompts.ask({ question: 'Gold?', answer: 'number', timeoutMs: 60_000, label: 'Claude' });
    await vi.waitFor(() => expect(s.agent.snapshot().questions).toHaveLength(1));
    await s.agent.stop('player');
    expect(await a).toEqual({ answered: false, reason: 'stopped' });
    expect(s.agent.snapshot().questions).toEqual([]);
  });

  it('Stop cancels freezes, stops watches, reverts tests, ends pointer scans, detaches and releases the game', async () => {
    const s = setup();
    await attached(s);
    const ctx = (await s.agent.require('s1', 'modify'))!;
    const f1 = freezeHandle(s.log, 'f1', true);  // a failing step doesn't stop the rest
    const fid = ctx.track.freeze(ctx.gen, f1, { address: '0x140000010', type: 'int32', value: '99' });
    const w = watch(s.log, 'w1');
    ctx.track.watch(ctx.gen, w, { address: '0x20', kind: 'write', endsAt: 5000 });
    ctx.track.test(ctx.gen, runningCheat(s.log, 't1'), { name: 'Gold' });
    ctx.track.test(ctx.gen, runningCheat(s.log, 't2'), { name: 'Health' });
    expect(ctx.track.liveTests()).toBe(2);
    ctx.track.pointerScan(ctx.gen, 7);
    ctx.track.speed(ctx.gen, 2);
    await vi.waitFor(() => expect(s.agent.snapshot().live.freezes[0]?.where).toBe('9Kings.exe+0x10'));
    expect(s.agent.snapshot().live).toEqual({
      freezes: [{ id: fid, address: '0x140000010', where: '9Kings.exe+0x10', type: 'int32', value: '99' }],
      tests: [{ id: expect.any(Number), name: 'Gold' }, { id: expect.any(Number), name: 'Health' }],
      watches: [{ id: expect.any(Number), address: '0x20', kind: 'write', endsAt: 5000 }],
      speed: 2,
    });
    s.log.length = 0;

    await s.agent.stop('player');
    expect(s.log).toEqual(['cancel f1', 'stop w1', 'disable t2', 'disable t1', 'pointerEnd 7', 'detach']);
    expect(s.owner.holders(PID)).toEqual([]);
    expect(ctx.signal.aborted).toBe(true);
    const snap = s.agent.snapshot();
    expect(snap).toMatchObject({ status: 'idle', client: null, game: null, live: { freezes: [], tests: [], watches: [], speed: 1 } });
    expect(s.notes()).toEqual(['Claude attached to 9Kings.exe', 'Stopped by the player']);
    await expect(s.agent.require('s1', 'attached')).rejects.toThrow(NOT_ATTACHED);
  });

  it('Stop while the player is being asked cancels the request', async () => {
    const s = setup();
    const p = s.agent.attach(PID, CLAUDE);
    await vi.waitFor(() => expect(s.prompts.approval()).not.toBeNull());
    await s.agent.stop('hotkey');
    await expect(p).rejects.toThrow(STOPPED_MIDWAY);
    expect(s.engine.attach).not.toHaveBeenCalled();
    expect(s.agent.snapshot()).toMatchObject({ status: 'idle', approval: null });
    expect(s.notes()).toEqual(['Stopped with the hotkey']);
  });

  it('switching modify off reverts changes but stays attached; modify tier is refused', async () => {
    const s = setup();
    await attached(s);
    const ctx = (await s.agent.require('s1', 'modify'))!;
    ctx.track.freeze(ctx.gen, freezeHandle(s.log, 'f1'), { address: '0x30', type: 'int32', value: '1' });
    ctx.track.watch(ctx.gen, watch(s.log, 'w1'), { address: '0x20', kind: 'access', endsAt: 1 });
    ctx.track.test(ctx.gen, runningCheat(s.log, 't1'), { name: 'Gold' });
    ctx.track.speed(ctx.gen, 2);
    s.log.length = 0;

    await s.agent.setCanModify(false);
    expect(s.log).toEqual(['cancel f1', 'stop w1', 'disable t1', 'setSpeed 1']);
    expect(s.engine.setSpeed).toHaveBeenCalledWith(s.session, 1);
    expect(s.session.detach).not.toHaveBeenCalled();
    expect(ctx.signal.aborted).toBe(true);
    expect(s.agent.snapshot()).toMatchObject({ status: 'attached', canModify: false, live: { freezes: [], tests: [], watches: [], speed: 1 } });
    await expect(s.agent.require('s1', 'modify')).rejects.toThrow(MODIFY_OFF);
    await expect(s.agent.require('s1', 'attached')).resolves.not.toBeNull();
    expect(s.notes().at(-1)).toBe("Agent can't modify the game now");

    await s.agent.setCanModify(true);
    expect(s.notes().at(-1)).toBe('Agent can modify the game');
    await expect(s.agent.require('s1', 'modify')).resolves.not.toBeNull();
  });

  it('switching modify off without a speed change leaves speed alone', async () => {
    const s = setup();
    await attached(s);
    await s.agent.setCanModify(false);
    expect(s.engine.setSpeed).not.toHaveBeenCalled();
  });

  it('an item tracked after Stop is reverted at once', async () => {
    const s = setup();
    await attached(s);
    const ctx = (await s.agent.require('s1', 'modify'))!;
    await s.agent.stop('player');
    const h = freezeHandle(s.log, 'late');
    expect(() => ctx.track.freeze(ctx.gen, h, { address: '0x1', type: 'int32', value: '1' })).toThrow(STOPPED_MIDWAY);
    expect(h.cancel).toHaveBeenCalled();
    const t = runningCheat(s.log, 'late');
    expect(() => ctx.track.test(ctx.gen, t, { name: 'x' })).toThrow(STOPPED_MIDWAY);
    expect(t.disable).toHaveBeenCalled();
    const w = watch(s.log, 'late');
    expect(() => ctx.track.watch(ctx.gen, w, { address: '0x1', kind: 'write', endsAt: 1 })).toThrow(STOPPED_MIDWAY);
    expect(w.stop).toHaveBeenCalled();
    expect(() => ctx.track.pointerScan(ctx.gen, 9)).toThrow(STOPPED_MIDWAY);
    expect(s.engine.pointerEnd).toHaveBeenCalledWith(s.session, 9);
    expect(s.agent.snapshot().live.freezes).toEqual([]);
  });

  it('untrack removes an item so Stop leaves it alone', async () => {
    const s = setup();
    await attached(s);
    const ctx = (await s.agent.require('s1', 'modify'))!;
    const h = freezeHandle(s.log, 'f1');
    const id = ctx.track.freeze(ctx.gen, h, { address: '0x1', type: 'int32', value: '1' });
    expect(ctx.track.untrackFreeze(id)).toBe(h);
    expect(ctx.track.untrackFreeze(id)).toBeNull();
    await s.agent.stop('player');
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('game exit ends the session and logs it', async () => {
    const s = setup();
    await attached(s);
    s.session.fireDetached('process-exit');
    expect(s.agent.snapshot().status).toBe('idle');
    await vi.waitFor(() => expect(s.notes().at(-1)).toBe('The game exited'));
    expect(s.owner.holders(PID)).toEqual([]);
  });

  it('engine connection close ends the session', async () => {
    const s = setup();
    await attached(s);
    s.client.setClosed(true);
    s.session.fireDetached('process-exit');
    s.client.fireClose();
    expect(s.agent.snapshot().status).toBe('idle');
    await vi.waitFor(() => expect(s.notes()).toEqual(['Claude attached to 9Kings.exe', 'The engine stopped']));
    expect(s.owner.holders(PID)).toEqual([]);
  });

  it('anti-cheat appearing later stops the session on the next modify-tier call', async () => {
    let hit: AntiCheatHit | null = null;
    const s = setup({ antiCheat: async () => hit });
    await attached(s);
    await expect(s.agent.require('s1', 'attached')).resolves.not.toBeNull();
    hit = EAC;
    await expect(s.agent.require('s1', 'modify')).rejects.toThrow(antiCheatMessage(EAC));
    expect(s.agent.snapshot().status).toBe('idle');
    expect(s.session.detach).toHaveBeenCalled();
    expect(s.notes().at(-1)).toBe('Anti-cheat loaded in the game; stopped');
  });

  it('the MCP session closing stops the agent session it owns', async () => {
    const s = setup();
    await attached(s);
    await s.agent.onMcpSessionClosed('s2');
    expect(s.agent.snapshot().status).toBe('attached');
    await s.agent.onMcpSessionClosed('s1');
    expect(s.agent.snapshot().status).toBe('idle');
    expect(s.session.detach).toHaveBeenCalled();
    expect(s.notes().at(-1)).toBe('Claude disconnected');
  });

  it('detach by the agent logs it', async () => {
    const s = setup();
    await attached(s);
    await s.agent.stop('agent');
    expect(s.notes().at(-1)).toBe('Claude detached');
  });

  it('the same agent attaching again to its game gets the same session', async () => {
    const s = setup();
    await attached(s);
    await expect(s.agent.attach(PID, CLAUDE)).resolves.toMatchObject({ pid: PID, canModify: true });
    expect(s.requestApproval).toHaveBeenCalledTimes(1);
  });
});
