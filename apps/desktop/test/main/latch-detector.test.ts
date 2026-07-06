// apps/desktop/test/main/latch-detector.test.ts
import { describe, it, expect } from 'vitest';
import { LatchDetector } from '../../src/main/latch-detector.js';

const entry = { id: '9-kings', name: '9 Kings', steamAppId: null, trainerSource: 'http://x' };
const index = () => new Map([['9kings', entry]]);
// Deterministic exe-name resolver: mimics recovering the full name from cmdline.
const resolveExeName = async (_pid: number, comm: string) =>
  comm === 'RSDragonwilds.e' ? 'RSDragonwilds.exe' : comm;
const base = {
  catalogIndex: index,
  detectedGames: () => [],
  isSessionActive: () => false,
  resolveExeName,
  identify: async (p: any) => (/9kings/i.test(p.name.replace(/[^a-z0-9]/gi, '')) ? entry : null),
};

describe('LatchDetector', () => {
  it('emits a detection for a newly-seen game process', async () => {
    const d = new LatchDetector(base);
    const r = await d.detect([{ pid: 1, name: 'other.exe' }, { pid: 2, name: '9Kings.exe' }]);
    expect(r).toMatchObject({ pid: 2, name: '9Kings.exe', game: { id: '9-kings' } });
  });

  it('does not re-emit for the same pid', async () => {
    const d = new LatchDetector(base);
    await d.detect([{ pid: 2, name: '9Kings.exe' }]);
    const again = await d.detect([{ pid: 2, name: '9Kings.exe' }]);
    expect(again).toBeNull();
  });

  it('stays silent while a session is active', async () => {
    const d = new LatchDetector({ ...base, isSessionActive: () => true });
    const r = await d.detect([{ pid: 2, name: '9Kings.exe' }]);
    expect(r).toBeNull();
  });

  it('ignores noise processes', async () => {
    const d = new LatchDetector(base);
    const r = await d.detect([{ pid: 3, name: 'services.exe' }]);
    expect(r).toBeNull();
  });

  it('considers processes whose .exe suffix was truncated by comm, and reports the full name', async () => {
    // A game identified by appid (not name): identify returns a match, but the
    // comm-truncated candidate ("RSDragonwilds.e") must still pass the filter.
    const dragon = { id: 'runescape-dragonwilds', name: 'RuneScape: Dragonwilds', steamAppId: null, trainerSource: 'http://x' };
    const d = new LatchDetector({
      ...base,
      identify: async (p: any) => (p.name === 'RSDragonwilds.exe' ? dragon : null),
    });
    const r = await d.detect([{ pid: 5, name: 'RSDragonwilds.e' }]);
    expect(r).toMatchObject({ pid: 5, name: 'RSDragonwilds.exe', game: { id: 'runescape-dragonwilds' } });
  });
});
