import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read, write } from '../src/memory.js';
import { freeze } from '../src/freeze.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('freeze', () => {
  let target: SpawnedTarget;
  let session: Session;
  let engine: Awaited<ReturnType<typeof startTestEngine>>;

  beforeAll(async () => {
    engine = await startTestEngine();
    target = await spawnTarget();
    session = await attach(engine.client, target.pid);
  });
  afterAll(async () => {
    await session.detach();
    await target.kill();
    await engine.stop();
  });

  it('keeps the value pinned despite external writes', async () => {
    const handle = await freeze(session, {
      address: target.addresses.g_health!,
      type: 'int32',
      value: 7777,
      intervalMs: 25,
    });
    try {
      await new Promise(r => setTimeout(r, 100));
      // External write that the freeze loop should overwrite
      await write(session, target.addresses.g_health!, 'int32', 0);
      await new Promise(r => setTimeout(r, 150));
      expect(await read(session, target.addresses.g_health!, 'int32')).toBe(7777);
    } finally {
      await handle.cancel();
    }
  });

  it('cancel stops the freeze loop', async () => {
    const handle = await freeze(session, {
      address: target.addresses.g_speed!,
      type: 'float',
      value: 5.0,
      intervalMs: 25,
    });
    await new Promise(r => setTimeout(r, 60));
    await handle.cancel();
    await write(session, target.addresses.g_speed!, 'float', 1.0);
    await new Promise(r => setTimeout(r, 100));
    expect(await read(session, target.addresses.g_speed!, 'float')).toBeCloseTo(1.0, 5);
  });
});
