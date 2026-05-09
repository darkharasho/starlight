import { describe, it, expect, afterEach } from 'vitest';
import { spawnTarget, type SpawnedTarget } from './spawn-target.js';

describe('spawnTarget', () => {
  let target: SpawnedTarget | undefined;
  afterEach(async () => { await target?.kill(); target = undefined; });

  it('spawns the C target and parses its address table', async () => {
    target = await spawnTarget();
    expect(target.pid).toBeGreaterThan(0);
    expect(target.addresses.g_health).toMatch(/^0x[0-9a-f]+$/);
    expect(target.addresses.g_speed).toMatch(/^0x[0-9a-f]+$/);
    expect(target.offsets.stats_in_player).toBe(0);
    expect(target.offsets.hp_in_stats).toBe(0);
  });
});
