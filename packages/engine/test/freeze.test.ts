import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read, write, readMany } from '../src/memory.js';
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

  it('freezes raw bytes (String / Array of byte records)', async () => {
    const at = target.addresses.g_name!;
    const handle = await freeze(session, { address: at, bytes: Buffer.from('Zed\0', 'latin1'), intervalMs: 25 });
    try {
      await new Promise(r => setTimeout(r, 60));
      expect(await read(session, at, { type: 'string', encoding: 'utf-8', maxLength: 16 })).toBe('Zed');
      await session.client.call('write', { handle: session.handle, address: at, bytes: Buffer.from('Bob\0').toString('hex') });
      await new Promise(r => setTimeout(r, 120));
      expect(await read(session, at, { type: 'string', encoding: 'utf-8', maxLength: 16 })).toBe('Zed');
    } finally {
      await handle.cancel();
    }
    // A hex string works too.
    const marker = target.addresses.g_aob_marker!;
    const h2 = await freeze(session, { address: marker, bytes: 'deadbeef', intervalMs: 25 });
    await new Promise(r => setTimeout(r, 60));
    expect((await readMany(session, [{ address: marker, length: 4 }]))[0]!.toString('hex')).toBe('deadbeef');
    await h2.cancel();
  });

  it('refuses empty or malformed raw bytes', async () => {
    const at = target.addresses.g_name!;
    await expect(freeze(session, { address: at, bytes: Buffer.alloc(0), intervalMs: 25 })).rejects.toThrow(/empty/);
    await expect(freeze(session, { address: at, bytes: 'abc', intervalMs: 25 })).rejects.toThrow(/hex/);
  });
});
