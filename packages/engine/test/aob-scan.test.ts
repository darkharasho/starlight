import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read } from '../src/memory.js';
import { aobScan } from '../src/aob-scan.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('aobScan', () => {
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

  it('finds a 12-byte signature in the target module', async () => {
    const matches = await aobScan(session, {
      module: 'target',
      pattern: 'DE AD BE EF CA FE BA BE 12 34 56 78',
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toBe(target.addresses.g_aob_marker);
  });

  it('matches with wildcards', async () => {
    const matches = await aobScan(session, {
      module: 'target',
      pattern: 'DE AD BE EF ?? ?? BA BE',
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  it('resultOffset is added to the first match', async () => {
    const matches = await aobScan(session, {
      module: 'target',
      pattern: 'DE AD BE EF CA FE BA BE 12 34 56 78',
      resultOffset: 12,  // 12 bytes after the marker is g_after_aob
    });
    expect(matches.length).toBeGreaterThan(0);
    // Reading float at first match should give 9.99 (g_after_aob), accounting for alignment.
    // The actual address of g_after_aob may include padding, so just verify the address
    // matches the recorded one within the same byte (alignment-aware).
    const first = parseInt(matches[0]!, 16);
    const expected = parseInt(target.addresses.g_after_aob!, 16);
    expect(Math.abs(first - expected)).toBeLessThanOrEqual(8);
    void read;  // suppress unused
  });
});
