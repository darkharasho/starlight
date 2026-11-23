// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NeedsUpdateError, type EngineClient, type RunningCheat, type Session } from '@starlight/engine';
import { createUserCheatsHost } from '../../src/main/user-cheats-host.js';
import { saveUserCheat } from '../../src/main/user-cheats.js';
import { createGameOwner } from '../../src/main/game-owner.js';

const game = { name: '9 Kings', exeName: '9Kings.exe', proton: true, steamAppId: null };
const cheat = (name: string) => ({
  name, type: 'freeze' as const, valueType: 'int32' as const, value: 1,
  address: { kind: 'absolute' as const, address: '0x1000' },
});
const KEY = '9kings';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ucs-'));
  await saveUserCheat(dir, KEY, game, cheat('Gold'));
  await saveUserCheat(dir, KEY, game, cheat('Gems'));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function setup(o: { ce?: boolean; enable?: (...a: unknown[]) => Promise<RunningCheat>; antiCheat?: boolean } = {}) {
  const order: string[] = [];
  let ceOn = o.ce ?? false;
  const released: string[] = [];
  const base = createGameOwner({
    ceSessionFor: () => (ceOn ? { sessionId: 'ce1' } : null),
    releaseCe: async () => { order.push('releaseCe'); ceOn = false; },
  });
  const owner = {
    ...base,
    hold: (pid: number, h: 'agent' | 'user-cheats') => { order.push('hold'); const r = base.hold(pid, h); return () => { released.push('x'); r(); }; },
    claim: async (pid: number, h: 'agent' | 'user-cheats') => { order.push('claim'); const r = await base.claim(pid, h); return () => { released.push('x'); r(); }; },
  };
  const detachCbs: Array<(r: 'process-exit' | 'manual') => void> = [];
  const sessions: Session[] = [];
  const attach = vi.fn(async () => {
    const session = {
      pid: 42, handle: 1, attached: true, client: {} as EngineClient,
      detach: vi.fn(async () => { (session as { attached: boolean }).attached = false; }),
      onDetached: (cb: (r: 'process-exit' | 'manual') => void) => { detachCbs.push(cb); return () => undefined; },
    } as unknown as Session;
    sessions.push(session);
    return session;
  });
  const runners: RunningCheat[] = [];
  const enableCheat = vi.fn(o.enable ?? (async () => {
    order.push('enableCheat');
    const r: RunningCheat = { kind: 'value', address: '0x1000', setValue: vi.fn(async () => undefined), disable: vi.fn(async () => undefined) };
    runners.push(r);
    return r;
  }));
  const verifyCheat = vi.fn(async () => ({ status: 'ok' as const, reasons: [] }));
  const onChange = vi.fn();
  const host = createUserCheatsHost({
    dir, getClient: async () => ({}) as EngineClient, owner,
    attach: attach as never, enableCheat: enableCheat as never, verifyCheat: verifyCheat as never,
    detectAntiCheatFn: async () => (o.antiCheat ? { name: 'EAC', module: 'easyanticheat.so' } : null),
    onChange,
  });
  return { host, base, order, attach, enableCheat, verifyCheat, runners, detachCbs, sessions, released, onChange };
}

describe('user cheats host', () => {
  it('enabling on a CE-owned game asks to close the table', async () => {
    const s = setup({ ce: true });
    const r = await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    expect(r).toEqual({ ok: false, confirm: 'close-ce', error: 'This will close the current Cheat Engine table — continue?' });
    expect(s.enableCheat).not.toHaveBeenCalled();
    expect(s.base.holders(42)).toEqual([]);
  });

  it('closeCe claims the game, then enables', async () => {
    const s = setup({ ce: true });
    expect(await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true, closeCe: true })).toEqual({ ok: true });
    expect(s.order).toEqual(['claim', 'releaseCe', 'enableCheat']);
    expect(s.base.holders(42)).toEqual(['user-cheats']);
  });

  it('holds without closing anything when CE is not on the game', async () => {
    const s = setup();
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    expect(s.order).toEqual(['hold', 'enableCheat']);
  });

  it('anti-cheat refuses and never attaches', async () => {
    const s = setup({ antiCheat: true });
    const r = await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('EAC');
    expect(s.attach).not.toHaveBeenCalled();
    expect(s.base.holders(42)).toEqual([]);
  });

  it('a cheat that needs updating refuses to enable with the reasons', async () => {
    const s = setup({ enable: async () => { throw new NeedsUpdateError(['the value is 5, outside 10–20']); } });
    const r = await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    expect(r).toEqual({ ok: false, error: 'This cheat needs updating: the value is 5, outside 10–20' });
    expect(s.base.holders(42)).toEqual([]);
  });

  it('list reports verify status when attached and null when not', async () => {
    const s = setup();
    const off = await s.host.list(KEY, null);
    expect(off.map((v) => v.verify)).toEqual([null, null]);
    const on = await s.host.list(KEY, 42);
    expect(on[0]).toMatchObject({ active: false, verify: { status: 'ok', reasons: [] } });
    await s.host.setActive({ key: KEY, pid: 42, id: 'gems', on: true });
    expect((await s.host.list(KEY, 42)).map((v) => v.active)).toEqual([false, true]);
  });

  it('a CE-owned pid lists with verify null and never attaches', async () => {
    const s = setup({ ce: true });
    const v = await s.host.list(KEY, 42);
    expect(v.map((x) => x.verify)).toEqual([null, null]);
    expect(s.attach).not.toHaveBeenCalled();
    expect(s.base.holders(42)).toEqual([]);
  });

  it('a list-only verify leaves no attached session and no hold', async () => {
    const s = setup();
    const v = await s.host.list(KEY, 42);
    expect(v[0]!.verify?.status).toBe('ok');
    expect(s.base.holders(42)).toEqual([]);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]!.attached).toBe(false);
  });

  it('turning the last cheat off detaches the session it made', async () => {
    const s = setup();
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: false });
    expect(s.sessions[0]!.attached).toBe(false);
  });

  it('turning the last cheat off releases the game', async () => {
    const s = setup();
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    await s.host.setActive({ key: KEY, pid: 42, id: 'gems', on: true });
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: false });
    expect(s.base.holders(42)).toEqual(['user-cheats']);
    await s.host.setActive({ key: KEY, pid: 42, id: 'gems', on: false });
    expect(s.base.holders(42)).toEqual([]);
    expect(s.runners.every((r) => (r.disable as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
  });

  it('a disable that fails keeps the cheat on and the game held', async () => {
    const s = setup({ enable: async () => ({ kind: 'patch', address: '0x1', setValue: async () => undefined, disable: async () => { throw new Error('revert failed'); } }) });
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    expect(await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: false })).toEqual({ ok: false, error: 'revert failed' });
    expect(s.base.holders(42)).toEqual(['user-cheats']);
    expect((await s.host.list(KEY, 42))[0]!.active).toBe(true);
  });

  it('game exit clears active state and releases the game', async () => {
    const s = setup();
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    s.detachCbs.forEach((cb) => cb('process-exit'));
    expect(s.base.holders(42)).toEqual([]);
    expect((await s.host.list(KEY, null)).map((v) => v.active)).toEqual([false, false]);
    expect(s.onChange).toHaveBeenCalledWith(KEY);
  });

  it('setValue updates a running cheat and is reported in list', async () => {
    const s = setup();
    expect(await s.host.setValue({ key: KEY, pid: 42, id: 'gold', value: 7 })).toEqual({ ok: false, error: 'turn the cheat on first' });
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    expect(await s.host.setValue({ key: KEY, pid: 42, id: 'gold', value: 7 })).toEqual({ ok: true });
    expect(s.runners[0]!.setValue).toHaveBeenCalledWith(7);
    expect((await s.host.list(KEY, 42))[0]!.value).toBe(7);
  });

  it('disableAll turns every cheat on the pid off', async () => {
    const s = setup();
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    await s.host.setActive({ key: KEY, pid: 42, id: 'gems', on: true });
    await s.host.disableAll(42);
    expect(s.runners.map((r) => (r.disable as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1]);
    expect(s.base.holders(42)).toEqual([]);
  });

  it('remove turns the cheat off then deletes it', async () => {
    const s = setup();
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    expect(await s.host.remove(KEY, 'gold')).toEqual({ ok: true });
    expect(s.runners[0]!.disable).toHaveBeenCalled();
    expect((await s.host.list(KEY, null)).map((v) => v.cheat.id)).toEqual(['gems']);
    expect(await s.host.remove(KEY, 'gold')).toMatchObject({ ok: false });
  });

  it('end turns everything off, releases and detaches', async () => {
    const s = setup();
    await s.host.setActive({ key: KEY, pid: 42, id: 'gold', on: true });
    await s.host.end();
    expect(s.runners[0]!.disable).toHaveBeenCalled();
    expect(s.base.holders(42)).toEqual([]);
    expect(s.sessions[0]!.detach).toHaveBeenCalled();
  });
});
