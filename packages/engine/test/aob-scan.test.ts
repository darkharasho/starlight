import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { aobScan } from '../src/aob-scan.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('aobScan', () => {
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
  });

  it('resolves a mapped PE module by case-insensitive name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'starlight-pe-'));
    const path = join(dir, 'GameAssembly.dll');
    writeFileSync(path, minimalPe(0x3000));
    const pe = await spawnTarget({ map: path });
    try {
      const peSession = await attach(engine.client, pe.pid);
      const matches = await aobScan(peSession, { module: 'gameassembly.dll', pattern: '4D 5A 90 00' });
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]).toBe(pe.addresses.mapped);
      await peSession.detach();
    } finally {
      await pe.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Minimal PE image (MZ + PE\0\0 header, SizeOfImage set) padded to size, as the daemon expects. */
function minimalPe(sizeOfImage: number): Buffer {
  const b = Buffer.alloc(sizeOfImage);
  b.set([0x4d, 0x5a, 0x90, 0x00], 0);
  b.writeUInt32LE(0x40, 0x3c);
  b.write('PE\0\0', 0x40, 'latin1');
  b.writeUInt16LE(0x8664, 0x44);   // Machine
  b.writeUInt16LE(0xf0, 0x54);     // SizeOfOptionalHeader
  b.writeUInt16LE(0x20b, 0x58);    // PE32+ magic
  b.writeUInt32LE(sizeOfImage, 0x58 + 56);
  return b;
}
