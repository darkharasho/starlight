import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { openSync, readSync, closeSync } from 'node:fs';
import { attach, type Session } from '../src/session.js';
import { read, readMany } from '../src/memory.js';
import { assemble, alloc, free, patch, disassemble } from '../src/code.js';
import { setSpeed, getSpeed } from '../src/speed.js';
import { moduleExports, resolveSymbol } from '../src/symbols.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads the game's memory straight from /proc, without the daemon. */
function procRead(pid: number, address: string, length: number): Buffer {
  const fd = openSync(`/proc/${pid}/mem`, 'r');
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, Number(BigInt(address)));
    return buf;
  } finally { closeSync(fd); }
}

describe('code injection, speed and symbols', () => {
  let engine: Awaited<ReturnType<typeof startTestEngine>>;
  let target: SpawnedTarget | undefined;
  let session: Session | undefined;

  beforeAll(async () => { engine = await startTestEngine(); });
  afterAll(async () => { await engine.stop(); });
  afterEach(async () => {
    await session?.detach();
    await target?.kill();
    session = undefined;
    target = undefined;
  });

  async function setup(args: string[]): Promise<{ s: Session; t: SpawnedTarget }> {
    target = await spawnTarget({ args });
    session = await attach(engine.client, target.pid);
    return { s: session, t: target };
  }

  it('client.capabilities lists every M2 capability', () => {
    for (const cap of ['read_many', 'scan', 'symbols', 'disasm', 'signature', 'assemble', 'alloc', 'patch', 'watch', 'pointer_scan', 'speed']) {
      expect(engine.client.capabilities).toContain(cap);
    }
  });

  it('assemble works without a session and returns bytes and labels', async () => {
    const r = await assemble(engine.client, { address: '0x1000', source: 'top:\nmov eax,[thing]\njmp top', symbols: { thing: '0x1100' } });
    expect(r.bytes.toString('hex')).toBe('8b05fa000000ebf8');
    expect(r.labels).toEqual({ top: '0x1000' });
  });

  it('assemble + alloc + patch + revert restores bytes', async () => {
    const { s, t } = await setup(['--writer']);

    // Code in allocated memory: assemble at the real address, patch it in, revert it.
    const page = await alloc(s, { size: 64, near: t.addresses.bump_counter });
    expect(page).toMatch(/^0x[0-9a-f]+$/);
    const code = await assemble(s, { address: page, source: 'mov eax,1\nret' });
    expect(code.bytes.length).toBeGreaterThan(0);
    const p = await patch(s, page, code.bytes);
    expect(p.original.length).toBe(code.bytes.length);
    expect((await readMany(s, [{ address: page, length: code.bytes.length }]))[0]!.equals(code.bytes)).toBe(true);
    await p.revert();
    expect((await readMany(s, [{ address: page, length: code.bytes.length }]))[0]!.equals(p.original)).toBe(true);
    await free(s, page);

    // Patching the store to g_counter with NOPs freezes the counter; reverting resumes it.
    const ins = await disassemble(s, t.addresses.bump_counter!, 12);
    const store = [...ins].reverse().find((i) => i.target?.address === t.addresses.g_counter)!;
    expect(store).toBeDefined();
    const original = Buffer.from(store.bytes, 'hex');
    const nops = (await assemble(s, { address: store.address, source: Array(store.length).fill('nop').join('\n') })).bytes;
    expect(nops.length).toBe(store.length);

    const counter = async () => (await read(s, t.addresses.g_counter!, 'int32')) as number;
    const patched = await patch(s, store.address, nops);
    expect(patched.original.equals(original)).toBe(true);
    const frozenAt = await counter();
    await sleep(300);
    expect(await counter()).toBe(frozenAt);

    await patched.revert();
    expect(procRead(target!.pid, store.address, store.length).equals(original)).toBe(true);
    await sleep(300);
    expect(await counter()).toBeGreaterThan(frozenAt);
  });

  it('readMany returns null for unreadable ranges', async () => {
    const { s, t } = await setup([]);
    const [good, bad] = await readMany(s, [{ address: t.addresses.g_health!, length: 4 }, { address: '0x10', length: 4 }]);
    expect(good!.readInt32LE(0)).toBe(100);
    expect(bad).toBeNull();
  });

  it('resolves module exports and symbols', async () => {
    const { s } = await setup([]);
    const list = await moduleExports(s, 'libc.so.6');
    const e = list.find((x) => x.name === 'clock_gettime');
    expect(e).toBeDefined();
    expect(await resolveSymbol(s, 'libc.so.6', 'clock_gettime')).toBe(e!.address);
  });

  it('setSpeed(2) doubles the g_mono_ns rate, setSpeed(1) brings it back; detach restores bytes (--clocks)', async () => {
    const { s, t } = await setup(['--clocks']);
    await sleep(300);
    const mono = t.addresses.g_mono_ns!;
    const clock = t.addresses.libc_clock_gettime!;
    const rate = async (): Promise<number> => {
      const v0 = (await read(s, mono, 'int64')) as bigint;
      const t0 = performance.now();
      await sleep(1000);
      const v1 = (await read(s, mono, 'int64')) as bigint;
      return Number(v1 - v0) / (performance.now() - t0) / 1e6;
    };
    const original = procRead(t.pid, clock, 16);

    const st = await setSpeed(s, 2);
    expect(st.speed).toBe(2);
    expect(st.hooks.find((h) => h.name === 'clock_gettime')?.status).toBe('hooked');
    expect((await getSpeed(s)).speed).toBe(2);
    expect(procRead(t.pid, clock, 16).equals(original)).toBe(false);
    await sleep(300);
    const fast = await rate();
    expect(fast).toBeGreaterThan(1.8);
    expect(fast).toBeLessThan(2.2);

    // Back to 1: the rate returns to 1 and the clock never goes backwards across the change.
    const samples: bigint[] = [];
    const sampler = (async () => {
      for (let i = 0; i < 40; i++) { samples.push((await read(s, mono, 'int64')) as bigint); await sleep(20); }
    })();
    await sleep(200);
    expect((await setSpeed(s, 1)).speed).toBe(1);
    await sampler;
    for (let i = 1; i < samples.length; i++) expect(samples[i]! >= samples[i - 1]!).toBe(true);
    await sleep(300);
    const normal = await rate();
    expect(normal).toBeGreaterThan(0.9);
    expect(normal).toBeLessThan(1.1);

    // The hooks stay as a pass-through at 1.0; detach puts the original bytes back.
    expect(procRead(t.pid, clock, 16).equals(original)).toBe(false);
    await s.detach();
    expect(procRead(t.pid, clock, 16).equals(original)).toBe(true);
  }, 30000);
});
