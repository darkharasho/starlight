import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read } from '../src/memory.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('memory.read', () => {
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

  it('reads int32', async () => {
    expect(await read(session, target.addresses.g_health!, 'int32')).toBe(100);
  });
  it('reads float', async () => {
    expect(await read(session, target.addresses.g_speed!, 'float')).toBeCloseTo(1.5, 5);
  });
  it('reads double', async () => {
    expect(await read(session, target.addresses.g_pi!, 'double')).toBeCloseTo(3.14159265358979, 10);
  });
  it('reads int64 as bigint', async () => {
    expect(await read(session, target.addresses.g_souls!, 'int64')).toBe(50000n);
  });
  it('reads uint8', async () => {
    expect(await read(session, target.addresses.g_byte!, 'uint8')).toBe(0x42);
  });
  it('reads utf-8 string', async () => {
    const value = await read(session, target.addresses.g_name!, { type: 'string', encoding: 'utf-8', maxLength: 16 });
    expect(value).toBe('Hero');
  });
});
