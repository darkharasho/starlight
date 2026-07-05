// apps/desktop/test/main/latch-detector.test.ts
import { describe, it, expect } from 'vitest';
import { LatchDetector } from '../../src/main/latch-detector.js';

const entry = { id: '9-kings', name: '9 Kings', steamAppId: null, trainerSource: 'http://x' };
const index = () => new Map([['9kings', entry]]);
const base = { catalogIndex: index, detectedGames: () => [], isSessionActive: () => false, identify: async (p: any) => (/9kings/i.test(p.name.replace(/[^a-z0-9]/gi, '')) ? entry : null) };

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
});
