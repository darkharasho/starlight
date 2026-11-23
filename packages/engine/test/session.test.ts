import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { attach } from '../src/session.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';
import { AttachError } from '../src/errors.js';

describe('Session', () => {
  let target: SpawnedTarget | undefined;
  let engine: Awaited<ReturnType<typeof startTestEngine>>;
  beforeAll(async () => { engine = await startTestEngine(); });
  afterAll(async () => { await engine.stop(); });
  afterEach(async () => { await target?.kill(); target = undefined; });

  it('attaches by pid and detaches cleanly', async () => {
    target = await spawnTarget();
    const session = await attach(engine.client, target.pid);
    expect(session.pid).toBe(target.pid);
    expect(session.attached).toBe(true);
    await session.detach();
    expect(session.attached).toBe(false);
  });

  it('throws AttachError for non-existent pid', async () => {
    await expect(attach(engine.client, 999_999_999)).rejects.toBeInstanceOf(AttachError);
  });
});
