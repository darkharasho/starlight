import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { write } from '../src/memory.js';
import { RpcCode } from '../src/errors.js';
import { scanFirst, scanNext, scanResults, scanEnd } from '../src/scan.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('value scans', () => {
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

  async function setup(args: string[] = []): Promise<{ s: Session; t: SpawnedTarget }> {
    target = await spawnTarget({ args });
    session = await attach(engine.client, target.pid);
    return { s: session, t: target };
  }

  it('first exact int32 scan finds g_health, next scan narrows after a write', async () => {
    const { s, t } = await setup();
    const first = await scanFirst(s, { type: 'int32', mode: 'exact', value: '100' });
    expect(first.count).toBeGreaterThanOrEqual(1);
    const before = await scanResults(s, first.scan, { limit: 1000 });
    expect(before.results.map((r) => r.address)).toContain(t.addresses.g_health);
    expect(before.results.find((r) => r.address === t.addresses.g_health)?.value).toBe('100');

    await write(s, t.addresses.g_health!, 'int32', 4242);
    const next = await scanNext(s, first.scan, { mode: 'exact', value: '4242' });
    expect(next.count).toBeGreaterThanOrEqual(1);
    expect(next.count).toBeLessThan(first.count + 1);
    const after = await scanResults(s, first.scan, { limit: 1000 });
    expect(after.count).toBe(next.count);
    const hit = after.results.find((r) => r.address === t.addresses.g_health);
    expect(hit?.value).toBe('4242');
    await scanEnd(s, first.scan);
  });

  it('unknown + increased finds g_counter (--writer)', async () => {
    const { s, t } = await setup(['--writer']);
    const first = await scanFirst(s, { type: 'int32', mode: 'unknown' });
    expect(first.count).toBeGreaterThan(1000);
    await sleep(400); // the writer bumps g_counter every 50 ms
    const next = await scanNext(s, first.scan, { mode: 'increased' });
    expect(next.count).toBeLessThan(first.count);
    const res = await scanResults(s, first.scan, { limit: 1000 });
    expect(res.results.map((r) => r.address)).toContain(t.addresses.g_counter);
    await scanEnd(s, first.scan);
  });

  it('scanResults pages and scanEnd forgets the scan', async () => {
    const { s } = await setup();
    const first = await scanFirst(s, { type: 'int32', mode: 'unknown' });
    const p0 = await scanResults(s, first.scan, { offset: 0, limit: 2 });
    const p1 = await scanResults(s, first.scan, { offset: 2, limit: 2 });
    expect(p0.count).toBe(first.count);
    expect(p0.results).toHaveLength(2);
    expect(p1.results).toHaveLength(2);
    expect(p1.results[0]!.address).not.toBe(p0.results[0]!.address);
    expect(p1.results[0]!.address).not.toBe(p0.results[1]!.address);

    await scanEnd(s, first.scan);
    const err = await scanResults(s, first.scan).catch((e) => e);
    expect(err).toMatchObject({ code: RpcCode.UnknownId });
  });
});
