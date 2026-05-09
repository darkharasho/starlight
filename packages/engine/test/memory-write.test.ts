import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read, write } from '../src/memory.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('memory.write', () => {
  let target: SpawnedTarget;
  let session: Session;

  beforeAll(async () => {
    target = await spawnTarget();
    session = await attach(target.pid);
  });
  afterAll(async () => {
    await session.detach();
    await target.kill();
  });

  it('writes int32 and reads back the new value', async () => {
    await write(session, target.addresses.g_health!, 'int32', 4242);
    expect(await read(session, target.addresses.g_health!, 'int32')).toBe(4242);
  });

  it('writes float', async () => {
    await write(session, target.addresses.g_speed!, 'float', 3.25);
    expect(await read(session, target.addresses.g_speed!, 'float')).toBeCloseTo(3.25, 5);
  });

  it('writes int64 from bigint', async () => {
    await write(session, target.addresses.g_souls!, 'int64', 999_999_999n);
    expect(await read(session, target.addresses.g_souls!, 'int64')).toBe(999_999_999n);
  });

  it('writes uint8', async () => {
    await write(session, target.addresses.g_byte!, 'uint8', 0xAB);
    expect(await read(session, target.addresses.g_byte!, 'uint8')).toBe(0xAB);
  });
});
