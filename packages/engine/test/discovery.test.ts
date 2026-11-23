import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read } from '../src/memory.js';
import { RpcCode } from '../src/errors.js';
import { resolvePointerChain } from '../src/pointer-chain.js';
import { aobScan } from '../src/aob-scan.js';
import { pointerScan, pointerResults, pointerRescan, pointerEnd } from '../src/pointer-scan.js';
import { watchStart } from '../src/watch.js';
import { disassemble, makeSignature } from '../src/code.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (hex: string) => BigInt(hex);

describe('discovery', () => {
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

  it('pointerScan paths resolve with resolvePointerChain (--heap-chain)', async () => {
    const { s, t } = await setup(['--heap-chain']);
    const scan = await pointerScan(s, { address: t.addresses.heap_value! });
    expect(scan.count).toBeGreaterThanOrEqual(1);
    expect(scan.truncated).toBe(false);

    const { count, paths } = await pointerResults(s, scan.id, { limit: 1000 });
    expect(count).toBe(scan.count);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths.every((p) => p.baseAddress.startsWith('0x'))).toBe(true);

    // The known static path g_root -> [+0x18] -> [+0x10] is among them.
    const known = paths.find((p) => p.module === 'target' && p.offsets.join() === '0x18,0x10');
    expect(known).toBeDefined();
    const final = await resolvePointerChain(s, known!);
    expect(final).toBe(t.addresses.heap_value);
    expect(await read(s, final, 'int32')).toBe(777);

    // Rescanning the live process keeps the path; the target address is reused when omitted.
    expect((await pointerRescan(s, scan.id)).count).toBeGreaterThanOrEqual(1);
    expect((await pointerRescan(s, scan.id, t.addresses.heap_value)).count).toBeGreaterThanOrEqual(1);

    await pointerEnd(s, scan.id);
    const err = await pointerResults(s, scan.id).catch((e) => e);
    expect(err).toMatchObject({ code: RpcCode.UnknownId });
  });

  it('watchStart on g_counter reports a hit inside bump_counter (--writer)', async () => {
    const { s, t } = await setup(['--writer']);
    const w = await watchStart(s, { address: t.addresses.g_counter!, size: 4, kind: 'write', durationMs: 5000 });
    await sleep(400);
    const polled = await w.poll();
    expect(polled.active).toBe(true);
    const report = await w.stop();
    expect(report.active).toBe(false);
    expect(report.reason).toBe('stopped');
    expect(report.hits.length).toBeGreaterThanOrEqual(1);
    const hit = report.hits[0]!;
    expect(hit.address).not.toBeNull();
    const bump = num(t.addresses.bump_counter!);
    expect(num(hit.address!)).toBeGreaterThanOrEqual(bump);
    expect(num(hit.address!)).toBeLessThan(bump + 64n);
    expect(num(hit.next)).toBeGreaterThan(num(hit.address!));
    expect(hit.count).toBeGreaterThanOrEqual(3);
    expect(hit.registers.rip).toBe(hit.next);
  });

  it('onEnded fires when the watch times out, and not after stop()', async () => {
    const { s, t } = await setup(['--writer']);
    const w = await watchStart(s, { address: t.addresses.g_counter!, size: 4, kind: 'write', durationMs: 200 });
    const reason = await new Promise<string>((resolve) => w.onEnded(resolve));
    expect(reason).toBe('timeout');
    const late: string[] = [];
    w.onEnded((r) => late.push(r)); // already ended: fires at once
    expect(late).toEqual(['timeout']);

    const w2 = await watchStart(s, { address: t.addresses.g_counter!, size: 4, kind: 'write', durationMs: 300 });
    const fired: string[] = [];
    w2.onEnded((r) => fired.push(r));
    await w2.stop();
    await sleep(500);
    expect(fired).toEqual([]);
  });

  it('disassemble + makeSignature round-trip through aobScan', async () => {
    const { s, t } = await setup(['--writer']);
    const ins = await disassemble(s, t.addresses.bump_counter!, 8);
    expect(ins).toHaveLength(8);
    expect(ins[0]!.address).toBe(t.addresses.bump_counter);
    expect(ins.some((i) => i.target?.address === t.addresses.g_counter)).toBe(true);

    const sig = await makeSignature(s, t.addresses.bump_counter!);
    expect(sig.unique).toBe(true);
    expect(sig.matches).toBe(1);
    expect(sig.pattern).toContain('??');
    expect(await aobScan(s, { module: sig.module, pattern: sig.pattern })).toEqual([t.addresses.bump_counter]);
  });
});
