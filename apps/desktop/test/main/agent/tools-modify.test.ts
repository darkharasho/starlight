// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { EngineError, NeedsUpdateError, RpcCode } from '@starlight/engine';
import type { EngineClient, FreezeHandle, RunningCheat, Session, Watch, WatchReport } from '@starlight/engine';
import { modifyTools } from '../../../src/main/agent/tools-modify.js';
import { createAgentSession } from '../../../src/main/agent/session.js';
import { createActivityLog } from '../../../src/main/agent/activity.js';
import { createPlayerPrompts } from '../../../src/main/agent/player-prompt.js';
import { createGameOwner } from '../../../src/main/game-owner.js';
import {
  STOPPED_MIDWAY, type ActivitySink, type AgentClient, type AttachedContext, type ToolChange, type ToolContext, type ToolDef, type Tracker,
} from '../../../src/main/agent/tools.js';
import type { GameIdentity } from '../../../src/main/game-identity.js';
import { DEFAULT_AGENT_PREFS } from '../../../src/shared/ipc.js';
import { connectTools } from './harness.js';

const MODS = [{ name: 'target', base: 0x400000, size: 0x100000 }];
const CLIENT: AgentClient = { mcpSessionId: 's1', name: 'codex', version: '1', label: 'Codex' };
const LONG = { timeout: 3_700_000 };

function describeAddr(a: string): Promise<string | null> {
  const n = Number(BigInt(a));
  const m = MODS.find((x) => n >= x.base && n < x.base + x.size);
  return Promise.resolve(m ? `${m.name}+0x${(n - m.base).toString(16)}` : null);
}

/** A tracker that behaves like the session's: it counts tests and refuses a stale gen. */
function fakeTracker(gen: () => number) {
  const tests = new Map<number, RunningCheat>();
  const freezes = new Map<number, FreezeHandle>();
  let next = 1;
  const stale = (g: number): void => { if (g !== gen()) throw new Error(STOPPED_MIDWAY); };
  const track = {
    freeze: vi.fn((g: number, h: FreezeHandle) => { stale(g); const id = next++; freezes.set(id, h); return id; }),
    test: vi.fn((g: number, c: RunningCheat) => { stale(g); const id = next++; tests.set(id, c); return id; }),
    watch: vi.fn((g: number) => { stale(g); return next++; }),
    pointerScan: vi.fn(),
    speed: vi.fn((g: number) => { stale(g); }),
    untrackFreeze: vi.fn((id: number) => { const h = freezes.get(id) ?? null; freezes.delete(id); return h; }),
    untrackTest: vi.fn((id: number) => { const c = tests.get(id) ?? null; tests.delete(id); return c; }),
    untrackWatch: vi.fn(),
    liveTests: () => tests.size,
  };
  return track as typeof track & Tracker;
}

function fakeCtx() {
  const ac = new AbortController();
  const track = fakeTracker(() => 3);
  const session = { id: 'sess' } as unknown as Session;
  const attached = { gen: 3, session, signal: ac.signal, track, game: {}, client: CLIENT, describe: describeAddr } as unknown as AttachedContext;
  const ctx: ToolContext = { mcpSessionId: 's1', client: CLIENT, attached };
  return { ctx, track, attached, session, stop: () => ac.abort() };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fakeWatch(report: WatchReport) {
  const ended = deferred<string>();
  const w: Watch & { stop: ReturnType<typeof vi.fn>; end(reason: string): void } = {
    id: 9,
    poll: async () => report,
    stop: vi.fn(async () => report),
    onEnded(cb) { void ended.promise.then(cb); },
    end(reason) { ended.resolve(reason); },
  };
  return w;
}

function fakeEngine() {
  return {
    resolveAddressExpr: vi.fn(async (_s: unknown, e: string) => (e === 'target+0x10' ? '0x400010' : e)),
    read: vi.fn(async () => 100 as number | bigint | string),
    write: vi.fn(async () => {}),
    freeze: vi.fn(async (): Promise<FreezeHandle> => ({ active: true, cancel: vi.fn(async () => {}) })),
    watchStart: vi.fn(async (): Promise<Watch> => fakeWatch({ active: false, reason: 'timeout', hits: [] })),
    setSpeed: vi.fn(async (_s: unknown, speed: number) => ({ speed, hooks: [{ name: 'clock_gettime', address: '0x1', status: 'hooked' as const }] })),
    verifyCheat: vi.fn(async () => ({ status: 'ok' as const, reasons: [] as string[] })),
    enableCheat: vi.fn(async (): Promise<RunningCheat> => runningCheat()),
  };
}

function runningCheat(address = '0x400010'): RunningCheat & { disable: ReturnType<typeof vi.fn> } {
  return { kind: 'value', address, setValue: async () => {}, disable: vi.fn(async () => {}) };
}

function tool(defs: ToolDef<any>[], name: string): ToolDef<any> { return defs.find((d) => d.name === name)!; } // eslint-disable-line @typescript-eslint/no-explicit-any

function recordingSink() {
  const finished: Array<{ status: string; summary?: string; error?: string; change?: ToolChange }> = [];
  const sink: ActivitySink = { start: () => finished.length + 1, finish: (_id, r) => { finished.push(r); } };
  return { sink, finished };
}
const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text;

const valueDraft = (over: Record<string, unknown> = {}) => ({
  name: 'Gold', type: 'freeze', valueType: 'int32', value: 999,
  address: { kind: 'module', module: 'target', offset: '0x10' },
  verify: { range: { min: 0, max: 10000000 } },
  ...over,
});
const patchDraft = () => ({
  name: 'No recoil', type: 'patch',
  site: { kind: 'aob', module: 'target', pattern: '48 8B ??' },
  enable: [{ op: 'writeBytes', at: 'site', bytes: '90', original: '48' }],
});

/** The real agent session, attached to a fake engine session, for the tests about Stop and the switch. */
async function realSession() {
  const client = { closed: false, capabilities: [], call: vi.fn(async () => ({})), onNotification: () => () => {}, onClose: () => {}, close: async () => {} } as unknown as EngineClient;
  const session = {
    pid: 42, handle: 1, client, attached: true,
    detach: vi.fn(async () => {}),
    onDetached: () => () => {},
  } as unknown as Session;
  const onChange = vi.fn();
  const hotkeys = { set: vi.fn(() => ({ ok: true as const })) } as never;
  const prompts = createPlayerPrompts({
    notifier: { show: () => ({ close: () => {} }) }, focusAgentView: () => {}, onChange, hotkeys,
    prefs: async () => ({ ...DEFAULT_AGENT_PREFS }),
  });
  const identity: GameIdentity = {
    pid: 42, name: 'Target', key: 'target', exeName: 'target', proton: false, steamAppId: null, buildId: null, exeHash: null, catalogId: null,
  };
  const agent = createAgentSession({
    getClient: async () => client,
    engine: {
      attach: async () => session,
      listModules: async () => [{ name: 'target', base: '0x400000', size: '0x100000', path: '/t/target', kind: 'elf' as const }],
      setSpeed: vi.fn(async () => ({}) as never),
      pointerEnd: async () => {},
    },
    detectAntiCheatFn: async () => null,
    checkTarget: async () => null,
    identify: async () => identity,
    owner: createGameOwner({ ceSessionFor: () => null, releaseCe: async () => {} }),
    prompts, hotkeys,
    activity: createActivityLog({ onChange }),
    prefs: async () => ({ ...DEFAULT_AGENT_PREFS }),
    onChange, focusAgentView: () => {},
  });
  const p = agent.attach(42, CLIENT);
  await vi.waitFor(() => expect(prompts.approval()).not.toBeNull());
  prompts.respondApproval(prompts.approval()!.id, true);
  await p;
  return { agent, session };
}

describe('modify tools', () => {
  it('write reports old → new and records the change', async () => {
    const e = fakeEngine();
    const { ctx, session } = fakeCtx();
    const { sink, finished } = recordingSink();
    const client = await connectTools(modifyTools(e as never), { access: { require: async () => ctx.attached }, activity: sink });
    const r = await client.callTool({ name: 'write', arguments: { address: 'target+0x10', type: 'int32', value: '999' } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ address: '0x400010', where: 'target+0x10', old: '100', new: '999' });
    expect(e.write).toHaveBeenCalledWith(session, '0x400010', 'int32', 999);
    expect(finished[0]).toEqual({
      status: 'ok', summary: 'write target+0x10 100 → 999', change: { address: 'target+0x10', old: '100', new: '999' },
    });
  });

  it('write parses values per type and refuses the rest', async () => {
    const e = fakeEngine();
    const defs = modifyTools(e as never);
    const { ctx, session } = fakeCtx();
    await tool(defs, 'write').run({ address: '0x400010', type: 'int64', value: '-9007199254740993' }, ctx);
    expect(e.write).toHaveBeenLastCalledWith(session, '0x400010', 'int64', -9007199254740993n);
    await tool(defs, 'write').run({ address: '0x400010', type: 'float', value: '1.5' }, ctx);
    expect(e.write).toHaveBeenLastCalledWith(session, '0x400010', 'float', 1.5);
    await expect(tool(defs, 'write').run({ address: '0x400010', type: 'int32', value: '1.5' }, ctx)).rejects.toThrow('value must be a int32 number');
    await expect(tool(defs, 'write').run({ address: '0x400010', type: 'uint64', value: '1e3' }, ctx)).rejects.toThrow('value must be a uint64 number');
    await expect(tool(defs, 'write').run({ address: '0x400010', type: 'double', value: 'NaN' }, ctx)).rejects.toThrow('value must be a double number');
    await expect(tool(defs, 'write').run({ address: '0x400010', type: 'int8', value: 'abc' }, ctx)).rejects.toThrow('value must be a int8 number');
    expect(e.write).toHaveBeenCalledTimes(2);
    const client = await connectTools(defs, { access: { require: async () => ctx.attached }, activity: recordingSink().sink });
    expect((await client.callTool({ name: 'write', arguments: { address: '0x1', type: 'string', value: 'x' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'freeze', arguments: { address: '0x1', type: 'string', value: 'x' } })).isError).toBe(true);
  });

  it('Stop during write\'s old-value read means no engine write happens', async () => {
    const e = fakeEngine();
    const gate = deferred<number>();
    e.read.mockImplementationOnce(() => gate.promise);
    const { ctx, stop } = fakeCtx();
    const p = tool(modifyTools(e as never), 'write').run({ address: '0x400010', type: 'int32', value: '5' }, ctx);
    await vi.waitFor(() => expect(e.read).toHaveBeenCalled());
    stop();
    gate.resolve(100);
    await expect(p).rejects.toThrow(STOPPED_MIDWAY);
    expect(e.write).not.toHaveBeenCalled();
  });

  it('freeze is tracked and shown in the snapshot; unfreeze cancels it', async () => {
    const e = fakeEngine();
    const h = { active: true, cancel: vi.fn(async () => {}) };
    e.freeze.mockResolvedValueOnce(h);
    const { agent, session } = await realSession();
    const { sink, finished } = recordingSink();
    const client = await connectTools(modifyTools(e as never), { access: agent, activity: sink });
    const r = await client.callTool({ name: 'freeze', arguments: { address: 'target+0x10', type: 'int32', value: '999', interval_ms: 50 } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(text(r)) as { freeze: number; address: string };
    expect(out).toMatchObject({ address: '0x400010' });
    expect(e.freeze).toHaveBeenCalledWith(session, { address: '0x400010', type: 'int32', value: 999, intervalMs: 50 });
    expect(finished[0]!.summary).toBe('freeze target+0x10 = 999');
    await vi.waitFor(() => expect(agent.snapshot().live.freezes).toEqual([
      { id: out.freeze, address: '0x400010', where: 'target+0x10', type: 'int32', value: '999' },
    ]));
    const u = await client.callTool({ name: 'unfreeze', arguments: { freeze: out.freeze } });
    expect(JSON.parse(text(u))).toEqual({ unfrozen: true });
    expect(h.cancel).toHaveBeenCalled();
    expect(agent.snapshot().live.freezes).toEqual([]);
    const again = await client.callTool({ name: 'unfreeze', arguments: { freeze: out.freeze } });
    expect(again.isError).toBe(true);
    expect(text(again)).toBe(`Unknown freeze ${out.freeze}.`);
    // interval out of range is refused by the schema
    expect((await client.callTool({ name: 'freeze', arguments: { address: '0x1', type: 'int32', value: '1', interval_ms: 10 } })).isError).toBe(true);
  });

  it('freeze created after the switch went off is cancelled', async () => {
    const e = fakeEngine();
    const h = { active: true, cancel: vi.fn(async () => {}) };
    const gate = deferred<FreezeHandle>();
    e.freeze.mockImplementationOnce(() => gate.promise);
    const { agent } = await realSession();
    const client = await connectTools(modifyTools(e as never), { access: agent, activity: recordingSink().sink });
    const p = client.callTool({ name: 'freeze', arguments: { address: '0x400010', type: 'int32', value: '1' } });
    await vi.waitFor(() => expect(e.freeze).toHaveBeenCalled());
    await agent.setCanModify(false);
    gate.resolve(h);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(STOPPED_MIDWAY);
    expect(h.cancel).toHaveBeenCalled();
    expect(agent.snapshot().live.freezes).toEqual([]);
  });

  it('watch_writes blocks until the watch ends and returns sites by count', async () => {
    const e = fakeEngine();
    const hits = Array.from({ length: 25 }, (_, i) => ({
      address: `0x${(0x400100 + i * 4).toString(16)}`, next: '0x0', module: 'target', text: `mov [rax], ${i}`, count: i + 1, registers: { rax: '0x1' },
    }));
    hits.push({ address: null as unknown as string, next: '0x500000', module: null, text: '??', count: 100, registers: { rax: '0x2' } });
    const w = fakeWatch({ active: false, reason: 'max_hits', hits });
    e.watchStart.mockResolvedValueOnce(w);
    const { ctx, track, session } = fakeCtx();
    let done = false;
    const p = tool(modifyTools(e as never), 'watch_writes').run({ address: 'target+0x10', duration_ms: 2000 }, ctx).then((r) => { done = true; return r; });
    await vi.waitFor(() => expect(track.watch).toHaveBeenCalled());
    expect(e.watchStart).toHaveBeenCalledWith(session, { address: '0x400010', size: 4, kind: 'write', durationMs: 2000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    w.end('max_hits');
    const r = await p as { reason: string; total_sites: number; sites: Array<{ address: string; where: string | null; count: number; registers?: unknown }> };
    expect(r.reason).toBe('max_hits');
    expect(r.total_sites).toBe(26);
    expect(r.sites).toHaveLength(20);
    expect(r.sites[0]).toEqual({ address: '0x500000', where: null, text: '??', count: 100 });
    expect(r.sites[1]).toEqual({ address: '0x400160', where: 'target+0x160', text: 'mov [rax], 24', count: 25 });
    expect(r.sites.map((s) => s.count)).toEqual([...r.sites.map((s) => s.count)].sort((a, b) => b - a));
    expect(track.untrackWatch).toHaveBeenCalled();
    expect(tool(modifyTools(e as never), 'watch_writes').summarize({ address: 'target+0x10', duration_ms: 2000 }, r)).toBe('watch_writes target+0x10 2s → 26 sites');
  });

  it('watch_writes returns registers only when asked; duration over 60000 is refused', async () => {
    const e = fakeEngine();
    const hit = { address: '0x400100', next: '0x400104', module: 'target', text: 'inc [rax]', count: 3, registers: { rax: '0x10' } };
    const w = fakeWatch({ active: false, reason: 'timeout', hits: [hit] });
    w.end('timeout');
    e.watchStart.mockResolvedValueOnce(w);
    const { ctx } = fakeCtx();
    const defs = modifyTools(e as never);
    const r = await tool(defs, 'watch_accesses').run({ address: '0x400100', include_registers: true, size: 8 }, ctx) as { sites: Array<{ registers?: unknown }> };
    expect(e.watchStart.mock.calls[0]![1]).toMatchObject({ kind: 'access', size: 8, durationMs: 10000 });
    expect(r.sites[0]!.registers).toEqual({ rax: '0x10' });
    const client = await connectTools(defs, { access: { require: async () => ctx.attached }, activity: recordingSink().sink });
    expect((await client.callTool({ name: 'watch_writes', arguments: { address: '0x1', duration_ms: 60001 } }, undefined, LONG)).isError).toBe(true);
    expect((await client.callTool({ name: 'watch_writes', arguments: { address: '0x1', duration_ms: 999 } }, undefined, LONG)).isError).toBe(true);
    expect((await client.callTool({ name: 'watch_writes', arguments: { address: '0x1', size: 3 } }, undefined, LONG)).isError).toBe(true);
    expect(e.watchStart).toHaveBeenCalledTimes(1);
  });

  it('watch_writes ends early with reason stopped when the player stops the session', async () => {
    const e = fakeEngine();
    const w = fakeWatch({ active: false, reason: 'stopped', hits: [] });
    e.watchStart.mockResolvedValueOnce(w);
    const { agent } = await realSession();
    const client = await connectTools(modifyTools(e as never), { access: agent, activity: recordingSink().sink });
    const p = client.callTool({ name: 'watch_writes', arguments: { address: '0x400010', duration_ms: 60000 } }, undefined, LONG);
    await vi.waitFor(() => expect(agent.snapshot().live.watches).toHaveLength(1));
    const t0 = Date.now();
    await agent.stop('player');
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ reason: 'stopped', total_sites: 0, sites: [] });
    expect(w.stop).toHaveBeenCalled();
  });

  it('set_speed refuses values outside 0.1–10', async () => {
    const e = fakeEngine();
    const { ctx, track, session } = fakeCtx();
    const { sink, finished } = recordingSink();
    const client = await connectTools(modifyTools(e as never), { access: { require: async () => ctx.attached }, activity: sink });
    expect((await client.callTool({ name: 'set_speed', arguments: { speed: 0.05 } })).isError).toBe(true);
    expect((await client.callTool({ name: 'set_speed', arguments: { speed: 10.5 } })).isError).toBe(true);
    expect(e.setSpeed).not.toHaveBeenCalled();
    const r = await client.callTool({ name: 'set_speed', arguments: { speed: 2 } });
    expect(JSON.parse(text(r))).toEqual({ speed: 2, hooks: [{ name: 'clock_gettime', status: 'hooked' }] });
    expect(e.setSpeed).toHaveBeenCalledWith(session, 2);
    expect(track.speed).toHaveBeenCalledWith(3, 2);
    expect(finished[0]!.summary).toBe('set_speed 2×');
  });

  it('set_speed explains when the game page controls speed', async () => {
    const e = fakeEngine();
    const err = new EngineError("another session already controls this game's speed");
    err.code = RpcCode.PatchConflict;
    e.setSpeed.mockRejectedValueOnce(err);
    const { ctx, track } = fakeCtx();
    await expect(tool(modifyTools(e as never), 'set_speed').run({ speed: 2 }, ctx))
      .rejects.toThrow("Starlight's game page is controlling this game's speed; ask the player to change it there.");
    expect(track.speed).not.toHaveBeenCalled();
  });

  it('test_cheat applies a value draft and revert cancels it', async () => {
    const e = fakeEngine();
    const c = runningCheat('0x400010');
    e.enableCheat.mockResolvedValueOnce(c);
    const { ctx, track, session } = fakeCtx();
    const defs = modifyTools(e as never);
    const t = tool(defs, 'test_cheat');
    expect(typeof t.tier === 'function' && t.tier({ action: 'apply' })).toBe('modify');
    expect(typeof t.tier === 'function' && t.tier({ action: 'revert' })).toBe('attached');
    const r = await t.run({ action: 'apply', cheat: valueDraft(), value: 500 }, ctx) as { test: number; verify: unknown; address: string };
    expect(r).toMatchObject({ verify: { status: 'ok', reasons: [] }, address: '0x400010' });
    expect(e.enableCheat.mock.calls[0]![0]).toBe(session);
    expect(e.enableCheat.mock.calls[0]![1]).toMatchObject({ name: 'Gold', type: 'freeze' });
    expect(e.enableCheat.mock.calls[0]![2]).toEqual({ value: 500 });
    expect(track.liveTests()).toBe(1);
    expect(t.summarize({ action: 'apply', cheat: valueDraft() }, r)).toBe('test_cheat apply "Gold" (ok)');
    expect(await t.run({ action: 'revert', test: r.test }, ctx)).toEqual({ reverted: true });
    expect(c.disable).toHaveBeenCalled();
    expect(track.liveTests()).toBe(0);
    expect(t.summarize({ action: 'revert', test: r.test }, { reverted: true })).toBe(`test_cheat revert #${r.test}`);
    await expect(t.run({ action: 'revert', test: r.test }, ctx)).rejects.toThrow(`Unknown test ${r.test}.`);
  });

  it('test_cheat applies a patch draft and revert restores it', async () => {
    const e = fakeEngine();
    const c = { ...runningCheat('0x400200'), kind: 'patch' as const };
    e.enableCheat.mockResolvedValueOnce(c);
    e.verifyCheat.mockResolvedValueOnce({ status: 'unverified', reasons: [] } as never);
    const { ctx } = fakeCtx();
    const t = tool(modifyTools(e as never), 'test_cheat');
    const r = await t.run({ action: 'apply', cheat: patchDraft() }, ctx) as { test: number; address: string; verify: { status: string } };
    expect(r.address).toBe('0x400200');
    expect(r.verify.status).toBe('unverified');
    expect(e.enableCheat.mock.calls[0]![1]).toMatchObject({ type: 'patch', enable: [{ op: 'writeBytes', at: 'site', bytes: '90' }] });
    expect(e.enableCheat.mock.calls[0]![2]).toEqual({});
    await t.run({ action: 'revert', test: r.test }, ctx);
    expect(c.disable).toHaveBeenCalled();
  });

  it('test_cheat rejects absolute addresses but not a missing range', async () => {
    const e = fakeEngine();
    const { ctx } = fakeCtx();
    const t = tool(modifyTools(e as never), 'test_cheat');
    await expect(t.run({ action: 'apply', cheat: valueDraft({ address: { kind: 'absolute', address: '0x400010' } }) }, ctx))
      .rejects.toThrow("address: agent-made cheats can't use absolute addresses; use an aob, pointer or module address");
    await expect(t.run({ action: 'apply', cheat: { ...patchDraft(), name: '', disable: [] } }, ctx))
      .rejects.toThrow(/^name: [^\n]+$/);
    await expect(t.run({ action: 'apply', cheat: { ...patchDraft(), disable: [], enable: [{ op: 'alloc', name: 'site', size: 16 }] } }, ctx))
      .rejects.toThrow(/^disable: .*\nenable\[0\]\.name: /s);
    expect(e.enableCheat).not.toHaveBeenCalled();
    await expect(t.run({ action: 'apply', cheat: valueDraft({ verify: undefined }) }, ctx)).resolves.toMatchObject({ verify: { status: 'ok' } });
  });

  it('test_cheat refuses a draft that needs updating, with the reasons', async () => {
    const e = fakeEngine();
    e.verifyCheat.mockResolvedValueOnce({ status: 'needs-update', reasons: ["the AOB pattern isn't in target any more", 'the value is 5000, outside 0–1000'] } as never);
    e.enableCheat.mockRejectedValueOnce(new NeedsUpdateError(['x']));
    const { ctx, track } = fakeCtx();
    const t = tool(modifyTools(e as never), 'test_cheat');
    await expect(t.run({ action: 'apply', cheat: valueDraft() }, ctx))
      .rejects.toThrow("This cheat needs updating: the AOB pattern isn't in target any more; the value is 5000, outside 0–1000");
    expect(track.test).not.toHaveBeenCalled();
    // enableCheat's own check (the game changed between the two) reads the same way
    e.enableCheat.mockReset();
    e.enableCheat.mockRejectedValueOnce(new NeedsUpdateError(['the code at site changed']));
    await expect(t.run({ action: 'apply', cheat: valueDraft() }, ctx)).rejects.toThrow('This cheat needs updating: the code at site changed');
  });

  it('at most 8 test cheats at once', async () => {
    const e = fakeEngine();
    const { ctx, track } = fakeCtx();
    const t = tool(modifyTools(e as never), 'test_cheat');
    for (let i = 0; i < 8; i++) await t.run({ action: 'apply', cheat: valueDraft() }, ctx);
    expect(track.liveTests()).toBe(8);
    await expect(t.run({ action: 'apply', cheat: valueDraft() }, ctx)).rejects.toThrow('At most 8 test cheats can be on at once; revert one first.');
    expect(e.enableCheat).toHaveBeenCalledTimes(8);
  });

  it('refuse to start an engine write once stopped, and are not read-only', async () => {
    const e = fakeEngine();
    const { ctx, stop } = fakeCtx();
    stop();
    const defs = modifyTools(e as never);
    await expect(tool(defs, 'freeze').run({ address: '0x1', type: 'int32', value: '1' }, ctx)).rejects.toThrow(STOPPED_MIDWAY);
    await expect(tool(defs, 'set_speed').run({ speed: 2 }, ctx)).rejects.toThrow(STOPPED_MIDWAY);
    await expect(tool(defs, 'watch_writes').run({ address: '0x1' }, ctx)).rejects.toThrow(STOPPED_MIDWAY);
    await expect(tool(defs, 'test_cheat').run({ action: 'apply', cheat: valueDraft() }, ctx)).rejects.toThrow(STOPPED_MIDWAY);
    expect(e.freeze).not.toHaveBeenCalled();
    expect(e.setSpeed).not.toHaveBeenCalled();
    expect(e.watchStart).not.toHaveBeenCalled();
    expect(e.enableCheat).not.toHaveBeenCalled();
    expect(defs.map((d) => d.name)).toEqual(['write', 'freeze', 'unfreeze', 'watch_writes', 'watch_accesses', 'set_speed', 'test_cheat']);
    for (const d of defs) expect(d.readOnly).toBe(false);
    expect(tool(defs, 'unfreeze').tier).toBe('attached');
    for (const n of ['write', 'freeze', 'watch_writes', 'watch_accesses', 'set_speed']) expect(tool(defs, n).tier).toBe('modify');
  });

  it('Stop during test_cheat\'s verify means the cheat is not enabled', async () => {
    const e = fakeEngine();
    const gate = deferred<{ status: 'ok'; reasons: string[] }>();
    e.verifyCheat.mockImplementationOnce(() => gate.promise);
    const { ctx, stop } = fakeCtx();
    const p = tool(modifyTools(e as never), 'test_cheat').run({ action: 'apply', cheat: valueDraft() }, ctx);
    await vi.waitFor(() => expect(e.verifyCheat).toHaveBeenCalled());
    stop();
    gate.resolve({ status: 'ok', reasons: [] });
    await expect(p).rejects.toThrow(STOPPED_MIDWAY);
    expect(e.enableCheat).not.toHaveBeenCalled();
  });
});

describe('cheat draft input schema (I2)', () => {
  it('test_cheat and save_cheat publish the real draft schema in tools/list', async () => {
    const { libraryTools } = await import('../../../src/main/agent/tools-library.js');
    const defs = [...modifyTools(), ...libraryTools({ dir: '/nonexistent', catalogTrainerFor: async () => null, onSaved: () => {} })];
    const client = await connectTools(defs, { access: { require: async () => null }, activity: { start: () => 1, finish: () => undefined } });
    const { tools } = await client.listTools();
    for (const name of ['test_cheat', 'save_cheat']) {
      const cheat = (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, Record<string, unknown>>)['cheat']!;
      const text = JSON.stringify(cheat);
      // Both draft kinds, with their discriminators and key fields, are described.
      for (const k of ['"freeze"', '"patch"', 'valueType', 'baseOffset', 'offsets', 'pattern', 'enable', 'writeBytes', 'range']) {
        expect(text, `${name} ${k}`).toContain(k);
      }
      expect(cheat['anyOf'] ?? cheat['oneOf']).toBeDefined();
    }
  });

  it('the SDK rejects a draft with the wrong shape before it reaches the game', async () => {
    const { ctx } = fakeCtx();
    const enableCheat = vi.fn();
    const defs = modifyTools({ enableCheat, verifyCheat: vi.fn() } as never);
    const start = vi.fn(() => 1);
    const client = await connectTools(defs, { access: { require: async () => ctx.attached }, activity: { start, finish: () => undefined } });
    const r = await client.callTool({ name: 'test_cheat', arguments: { action: 'apply', cheat: { name: 'x', type: 'freeze', address: '0x10' } } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/valueType|address/);
    // R16: the SDK's input validation refused it, so no Starlight code ran.
    expect(start).not.toHaveBeenCalled();
    expect(enableCheat).not.toHaveBeenCalled();
  });
});
