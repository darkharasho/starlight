// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { EngineClient, Session } from '@starlight/engine';
import { createScannerHost, SCANNER_METHODS } from '../../src/main/scanner-host.js';

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

function setup(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    closed: false,
    call: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const h = handlers[method];
      return h ? h(params) : {};
    }),
  } as unknown as EngineClient;
  let nextHandle = 1;
  const sessions: Session[] = [];
  const attachFn = vi.fn(async (_c: EngineClient, pid: number) => {
    const s = {
      pid, handle: nextHandle++, client, attached: true,
      detach: vi.fn(async () => { (s as { attached: boolean }).attached = false; }),
      onDetached: () => () => undefined,
    } as unknown as Session;
    sessions.push(s);
    return s;
  });
  const host = createScannerHost({
    getClient: async () => client,
    attach: attachFn as never,
    detectAntiCheatFn: async () => null,
  });
  return { host, calls, attachFn, sessions, client };
}

const of = (calls: Array<{ method: string }>, m: string) => calls.filter((c) => c.method === m);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('scanner-host', () => {
  it('lists the panel commands', () => {
    expect([...SCANNER_METHODS].sort()).toEqual([
      'freeze_clear', 'freeze_set', 'mem_read', 'mem_write', 'scan_first', 'scan_next', 'scan_reset', 'scan_results', 'scan_status',
    ]);
  });

  it('scan_first returns ok immediately and scan_status reports busy until the daemon answers', async () => {
    let release!: (v: unknown) => void;
    const { host } = setup({ scan_first: () => new Promise((r) => { release = r; }) });
    expect(await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '100' })).toEqual({ ok: true });
    expect(await host.call(10, 'scan_status', {})).toEqual({ busy: true, started: true, count: 0, valueType: 'i32' });
    release({ scan: 7, count: 42 });
    await tick(); await tick();
    expect(await host.call(10, 'scan_status', {})).toEqual({ busy: false, started: true, count: 42, valueType: 'i32' });
  });

  it('maps i32/exact to scan_first {type:"int32", mode:"exact", value:"100"}', async () => {
    const { host, calls } = setup({ scan_first: () => ({ scan: 1, count: 0 }) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '100' });
    await tick();
    expect(of(calls, 'scan_first')[0]!.params).toMatchObject({ type: 'int32', mode: 'exact', value: '100' });
    await host.call(10, 'scan_reset', {});
    await host.call(10, 'scan_first', { valueType: 'f32', op: 'unknown' });
    await tick();
    const p = of(calls, 'scan_first')[1]!.params;
    expect(p).toMatchObject({ type: 'float', mode: 'unknown' });
    expect(p).not.toHaveProperty('value');
  });

  it('maps next ops and refuses next before a first scan', async () => {
    const { host, calls } = setup({
      scan_first: () => ({ scan: 3, count: 5 }),
      scan_next: () => ({ count: 2 }),
    });
    expect(await host.call(10, 'scan_next', { op: 'changed' })).toEqual({ ok: false, error: 'start a new scan first' });
    await host.call(10, 'scan_first', { valueType: 'i16', op: 'bigger', value: '3' });
    await tick(); await tick();
    expect(await host.call(10, 'scan_next', { op: 'increased' })).toEqual({ ok: true });
    await tick(); await tick();
    expect(of(calls, 'scan_next')[0]!.params).toMatchObject({ scan: 3, mode: 'increased' });
    expect(await host.call(10, 'scan_status', {})).toMatchObject({ busy: false, count: 2 });
  });

  it('surfaces a background failure once through scan_status', async () => {
    const { host } = setup({ scan_first: () => { throw new Error('boom'); } });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    await tick(); await tick();
    expect(await host.call(10, 'scan_status', {})).toEqual({ ok: false, error: 'boom' });
    expect(await host.call(10, 'scan_status', {})).toMatchObject({ busy: false, started: false, count: 0 });
  });

  it('scan_results formats addresses as uppercase hex without 0x and caps limit at 500', async () => {
    const { host, calls } = setup({
      scan_first: () => ({ scan: 9, count: 3 }),
      scan_results: () => ({ count: 3, results: [
        { address: '0x7ff6a1b2c3d4', value: '100' }, { address: '0x10', value: null },
      ] }),
    });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '100' });
    await tick(); await tick();
    const r = await host.call(10, 'scan_results', { limit: 5000 });
    expect(r).toEqual({
      count: 3, valueType: 'i32',
      items: [{ address: '7FF6A1B2C3D4', value: '100' }, { address: '10', value: '' }],
    });
    expect(of(calls, 'scan_results')[0]!.params).toMatchObject({ scan: 9, limit: 500 });
  });

  it('scan_results formats float values the way Cheat Engine does', async () => {
    const { host } = setup({
      scan_first: () => ({ scan: 9, count: 2 }),
      scan_results: () => ({ count: 2, results: [
        { address: '0x1', value: '0.1' }, { address: '0x2', value: '100' },
      ] }),
    });
    await host.call(10, 'scan_first', { valueType: 'f32', op: 'exact', value: '0.1' });
    await tick(); await tick();
    const r = await host.call(10, 'scan_results', {}) as { items: Array<{ value: string }> };
    expect(r.items.map((i) => i.value)).toEqual(['0.10000000149012', '100.0']);
  });

  it('scan_results is empty while a scan is running and scan_reset refuses', async () => {
    const { host } = setup({ scan_first: () => new Promise(() => undefined) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    expect(await host.call(10, 'scan_results', {})).toEqual({ count: 0, items: [], valueType: 'i32' });
    expect(await host.call(10, 'scan_reset', {})).toEqual({ ok: false, error: 'a scan is still running' });
    expect(await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' }))
      .toEqual({ ok: false, error: 'a scan is already running' });
  });

  it('scan_reset ends the daemon scan', async () => {
    const { host, calls } = setup({ scan_first: () => ({ scan: 4, count: 1 }) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    await tick(); await tick();
    expect(await host.call(10, 'scan_reset', {})).toEqual({ ok: true });
    expect(of(calls, 'scan_end')[0]!.params).toEqual({ scan: 4 });
    expect(await host.call(10, 'scan_status', {})).toMatchObject({ started: false, count: 0 });
  });

  it('mem_read accepts CE-format addresses and returns "" for unreadable', async () => {
    const le = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b.toString('hex'); };
    const f = Buffer.alloc(4); f.writeFloatLE(1.5);
    const { host, calls } = setup({
      read_many: () => ({ values: [le(-7), null, f.toString('hex'), 'ff'] }),
    });
    const r = await host.call(10, 'mem_read', { items: [
      { address: '7FF6A1B2C3D4', valueType: 'i32' },
      { address: '10', valueType: 'i32' },
      { address: '20', valueType: 'f32' },
      { address: '30', valueType: 'i8' },
    ] });
    expect(r).toEqual({ values: ['-7', '', '1.5', '-1'] });
    expect(of(calls, 'read_many')[0]!.params).toMatchObject({
      items: [
        { address: '0x7ff6a1b2c3d4', length: 4 }, { address: '0x10', length: 4 },
        { address: '0x20', length: 4 }, { address: '0x30', length: 1 },
      ],
    });
  });

  it('mem_read formats 64-bit integers and doubles', async () => {
    const q = Buffer.alloc(8); q.writeBigInt64LE(-9007199254740993n);
    const d = Buffer.alloc(8); d.writeDoubleLE(2);
    const { host } = setup({ read_many: () => ({ values: [q.toString('hex'), d.toString('hex')] }) });
    expect(await host.call(10, 'mem_read', { items: [
      { address: '1', valueType: 'i64' }, { address: '2', valueType: 'f64' },
    ] })).toEqual({ values: ['-9007199254740993', '2.0'] });
  });

  it('mem_write writes the value and reports failure', async () => {
    const { host, calls } = setup({ write: (p) => { if (p['address'] === '0xdead') throw new Error('nope'); return {}; } });
    expect(await host.call(10, 'mem_write', { address: '1F4', valueType: 'i32', value: '1000' })).toEqual({ ok: true });
    expect(of(calls, 'write')[0]!.params).toMatchObject({ address: '0x1f4', bytes: 'e8030000' });
    expect(await host.call(10, 'mem_write', { address: 'DEAD', valueType: 'i32', value: '1' }))
      .toEqual({ ok: false, error: 'could not write that address' });
    expect(await host.call(10, 'mem_write', { address: '1', valueType: 'i32', value: 'abc' }))
      .toEqual({ ok: false, error: 'could not write that address' });
    expect(await host.call(10, 'mem_write', { address: 'zz', valueType: 'i32', value: '1' }))
      .toEqual({ ok: false, error: 'bad address' });
  });

  it('freeze_set then mem_write updates the frozen value; freeze_clear cancels', async () => {
    let id = 100;
    const { host, calls } = setup({ freeze: () => ({ id: id++ }) });
    expect(await host.call(10, 'freeze_set', { address: '1F4', valueType: 'i32', value: '50' })).toEqual({ ok: true });
    expect(of(calls, 'freeze')[0]!.params).toMatchObject({ address: '0x1f4', bytes: '32000000', interval_ms: 100 });

    expect(await host.call(10, 'mem_write', { address: '1F4', valueType: 'i32', value: '99' })).toEqual({ ok: true });
    expect(of(calls, 'unfreeze')[0]!.params).toEqual({ id: 100 });
    expect(of(calls, 'freeze')[1]!.params).toMatchObject({ address: '0x1f4', bytes: '63000000' });

    expect(await host.call(10, 'freeze_clear', { address: '1F4' })).toEqual({ ok: true });
    expect(of(calls, 'unfreeze')[1]!.params).toEqual({ id: 101 });
    expect(await host.call(10, 'freeze_clear', { address: '1F4' })).toEqual({ ok: true });
    expect(of(calls, 'unfreeze')).toHaveLength(2);
  });

  it('freeze_set on a frozen address replaces the freeze', async () => {
    let id = 1;
    const { host, calls } = setup({ freeze: () => ({ id: id++ }) });
    await host.call(10, 'freeze_set', { address: 'A0', valueType: 'i32', value: '1' });
    await host.call(10, 'freeze_set', { address: '0xa0', valueType: 'i32', value: '2' });
    expect(of(calls, 'unfreeze')).toHaveLength(1);
    expect(of(calls, 'freeze')).toHaveLength(2);
  });

  it('refuses with the anti-cheat message and never attaches', async () => {
    const { attachFn, client } = setup();
    const host = createScannerHost({
      getClient: async () => client,
      attach: attachFn as never,
      detectAntiCheatFn: async () => ({ name: 'Easy Anti-Cheat', module: 'EasyAntiCheat.so' }),
    });
    const r = await host.call(10, 'mem_read', { items: [{ address: '1', valueType: 'i32' }] });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Easy Anti-Cheat.*won't attach/) });
    expect(attachFn).not.toHaveBeenCalled();
  });

  it('reports attach failures as ok:false', async () => {
    const { client } = setup();
    const host = createScannerHost({
      getClient: async () => client,
      attach: (async () => { throw new Error('ptrace denied'); }) as never,
      detectAntiCheatFn: async () => null,
    });
    expect(await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' }))
      .toEqual({ ok: false, error: 'ptrace denied' });
  });

  it('end() cancels freezes, ends the scan and detaches', async () => {
    const { host, calls, sessions } = setup({ scan_first: () => ({ scan: 5, count: 1 }), freeze: () => ({ id: 77 }) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    await tick(); await tick();
    await host.call(10, 'freeze_set', { address: '10', valueType: 'i32', value: '1' });
    await host.end();
    expect(of(calls, 'unfreeze')[0]!.params).toEqual({ id: 77 });
    expect(of(calls, 'scan_end')[0]!.params).toEqual({ scan: 5 });
    expect(sessions[0]!.detach).toHaveBeenCalled();
    expect(await host.call(10, 'scan_status', {})).toMatchObject({ started: false });
  });

  it('a new pid re-attaches', async () => {
    const { host, attachFn, sessions } = setup({ read_many: () => ({ values: [null] }) });
    const items = [{ address: '1', valueType: 'i32' }];
    await host.call(10, 'mem_read', { items });
    await host.call(10, 'mem_read', { items });
    expect(attachFn).toHaveBeenCalledTimes(1);
    await host.call(20, 'mem_read', { items });
    expect(attachFn).toHaveBeenCalledTimes(2);
    expect(sessions[0]!.detach).toHaveBeenCalled();
  });

  it('concurrent scan_first with a prior scan starts only one scan', async () => {
    let n = 0;
    const { host, calls } = setup({ scan_first: () => ({ scan: ++n, count: 1 }) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    await tick(); await tick();
    const [a, b] = await Promise.all([
      host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '2' }),
      host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '3' }),
    ]);
    expect([a, b]).toEqual([{ ok: true }, { ok: false, error: 'a scan is already running' }]);
    await tick(); await tick();
    expect(of(calls, 'scan_first')).toHaveLength(2);
    expect(of(calls, 'scan_end')).toEqual([{ method: 'scan_end', params: { scan: 1 } }]);
  });

  it('scan_reset during a restarting scan is refused', async () => {
    const { host } = setup({ scan_first: () => ({ scan: 1, count: 1 }) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    await tick(); await tick();
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '2' });
    expect(await host.call(10, 'scan_reset', {})).toEqual({ ok: false, error: 'a scan is still running' });
  });

  it('a pid change cancels a live scan and a live freeze', async () => {
    const { host, calls } = setup({ scan_first: () => ({ scan: 8, count: 1 }), freeze: () => ({ id: 55 }), read_many: () => ({ values: [null] }) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    await tick(); await tick();
    await host.call(10, 'freeze_set', { address: '10', valueType: 'i32', value: '1' });
    await host.call(20, 'mem_read', { items: [{ address: '1', valueType: 'i32' }] });
    expect(of(calls, 'unfreeze')[0]!.params).toEqual({ id: 55 });
    expect(of(calls, 'scan_end')[0]!.params).toEqual({ scan: 8 });
    expect(await host.call(20, 'scan_status', {})).toMatchObject({ started: false });
  });

  it('a scan that completes after end() is ended on the daemon', async () => {
    let release!: (v: unknown) => void;
    const { host, calls } = setup({ scan_first: () => new Promise((r) => { release = r; }) });
    await host.call(10, 'scan_first', { valueType: 'i32', op: 'exact', value: '1' });
    await host.end();
    release({ scan: 12, count: 3 });
    await tick(); await tick();
    expect(of(calls, 'scan_end')).toEqual([{ method: 'scan_end', params: { scan: 12 } }]);
  });

  it('a freeze that starts after end() is dropped, not tracked on the new session', async () => {
    let release!: (v: unknown) => void;
    const { host, calls } = setup({ freeze: () => new Promise((r) => { release = r; }) });
    const pending = host.call(10, 'freeze_set', { address: '10', valueType: 'i32', value: '1' });
    await tick();
    await host.end();
    release({ id: 31 });
    expect(await pending).toMatchObject({ ok: false });
    // Not tracked: a write to that address is a plain write, not a freeze restart.
    await host.call(10, 'mem_write', { address: '10', valueType: 'i32', value: '2' });
    expect(of(calls, 'freeze')).toHaveLength(1);
    expect(of(calls, 'write')).toHaveLength(1);
  });

  it('an attach that resolves after end() is detached and the call fails', async () => {
    const { client, sessions } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const detach = vi.fn(async () => undefined);
    const host = createScannerHost({
      getClient: async () => client,
      attach: (async (_c: EngineClient, pid: number) => {
        await gate;
        return { pid, handle: 1, client, attached: true, detach, onDetached: () => () => undefined } as unknown as Session;
      }) as never,
      detectAntiCheatFn: async () => null,
    });
    const pending = host.call(10, 'mem_read', { items: [{ address: '1', valueType: 'i32' }] });
    await tick(); await tick();
    await host.end();
    release();
    expect(await pending).toEqual({ ok: false, error: 'session ended' });
    expect(detach).toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it('mem_write on a frozen address restarts the freeze with the request type', async () => {
    let id = 1;
    const { host, calls } = setup({ freeze: () => ({ id: id++ }) });
    await host.call(10, 'freeze_set', { address: '10', valueType: 'i32', value: '1' });
    await host.call(10, 'mem_write', { address: '10', valueType: 'i16', value: '2' });
    expect(of(calls, 'freeze')[1]!.params).toMatchObject({ bytes: '0200' });
  });

  it('rejects unknown methods', async () => {
    const { host } = setup();
    expect(await host.call(10, 'nope', {})).toEqual({ ok: false, error: 'unsupported command: nope' });
  });
});
