import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read, write } from '../src/memory.js';
import { resolvePointerChain } from '../src/pointer-chain.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('resolvePointerChain', () => {
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

  it('walks g_player_ptr -> Player.stats -> Stats.hp = 250', async () => {
    // g_player_ptr is the address OF a pointer to a Player.
    // *(g_player_ptr) -> Player; +stats_in_player -> Stats*; *() -> Stats; +hp_in_stats -> int32
    const final = await resolvePointerChain(session, {
      baseAddress: target.addresses.g_player_ptr!,
      offsets: [
        toHex(target.offsets.stats_in_player!),  // walk into Player to reach .stats field
        toHex(target.offsets.hp_in_stats!),      // walk into Stats to reach .hp
      ],
    });
    expect(await read(session, final, 'int32')).toBe(250);
  });

  it('writing via the resolved address mutates the chained value', async () => {
    const final = await resolvePointerChain(session, {
      baseAddress: target.addresses.g_player_ptr!,
      offsets: [
        toHex(target.offsets.stats_in_player!),
        toHex(target.offsets.hp_in_stats!),
      ],
    });
    await write(session, final, 'int32', 9001);
    expect(await read(session, final, 'int32')).toBe(9001);
  });

  it('resolves a module+offset address with no further offsets', async () => {
    // Verify the module resolution path: passing module='target' and baseAddress='0x0'
    // should return the module base address (a valid hex string). This exercises the
    // Frida-side module resolution for the ASLR/module path.
    const result = await resolvePointerChain(session, {
      module: 'target',
      baseAddress: '0x0',  // base of module
      offsets: [],
    });
    expect(result).toMatch(/^0x[0-9a-f]+$/);
    // The result should be the module base, which on a non-PIE binary
    // is typically 0x400000.
  });
});

function toHex(n: number): string { return '0x' + n.toString(16); }
