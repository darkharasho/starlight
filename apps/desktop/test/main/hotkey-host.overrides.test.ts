import { describe, it, expect, vi, beforeEach } from 'vitest';

const fired = new Map<string, () => void>();
vi.mock('electron', () => ({
  globalShortcut: {
    register: (accel: string, cb: () => void) => {
      if (fired.has(accel)) return false;                 // collision → reject
      if (accel === 'BAD') return false;
      fired.set(accel, cb);
      return true;
    },
    unregister: (accel: string) => { fired.delete(accel); },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../src/main/engine-host.js', () => ({
  toggleCheat: vi.fn(async () => ({ ok: true })),
  incCheat:    vi.fn(async () => ({ ok: true })),
  decCheat:    vi.fn(async () => ({ ok: true })),
}));

beforeEach(() => { fired.clear(); });

const trainer = {
  id: 'demo',
  game: { name: 'Demo', processName: ['demo.exe'], platform: ['windows'] },
  metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
  categories: [{
    name: 'Player',
    cheats: [
      { id: 'speed', name: 'Speed', type: 'set', valueType: 'float',
        address: { kind: 'absolute', address: '0x0' },
        min: 0, max: 10, step: 0.5, default: 1,
        hotkeys: { toggle: 'F4', inc: 'F4+Up', dec: 'F4+Down' } },
      { id: 'god', name: 'God', type: 'toggle', valueType: 'uint32',
        address: { kind: 'absolute', address: '0x0' },
        hotkeys: { toggle: 'F1' } },
    ],
  }],
} as never;

describe('hotkey-host registerForTrainer overrides', () => {
  it('uses defaults when no overrides passed', async () => {
    const { registerForTrainer, unregisterAll } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer);
    expect(fired.has('F4')).toBe(true);
    expect(fired.has('F4+Up')).toBe(true);
    expect(fired.has('F4+Down')).toBe(true);
    expect(fired.has('F1')).toBe(true);
    unregisterAll();
  });

  it('replaces a slot when override is a non-null string', async () => {
    const { registerForTrainer, unregisterAll } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, { speed: { toggle: 'F5' } });
    expect(fired.has('F5')).toBe(true);
    expect(fired.has('F4')).toBe(false);                  // default replaced
    expect(fired.has('F4+Up')).toBe(true);                 // unchanged
    expect(fired.has('F1')).toBe(true);                    // other cheat unchanged
    unregisterAll();
  });

  it('clears a slot when override is null', async () => {
    const { registerForTrainer, unregisterAll } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, { god: { toggle: null } });
    expect(fired.has('F1')).toBe(false);                   // explicitly cleared
    expect(fired.has('F4')).toBe(true);                    // unchanged
    unregisterAll();
  });

  it('handles missing override entries gracefully', async () => {
    const { registerForTrainer, unregisterAll } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, {});
    expect(fired.has('F4')).toBe(true);
    expect(fired.has('F1')).toBe(true);
    unregisterAll();
  });

  it('skips an override accelerator the OS rejects', async () => {
    const { registerForTrainer, unregisterAll } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, { god: { toggle: 'BAD' } });
    expect(fired.has('BAD')).toBe(false);
    expect(fired.has('F1')).toBe(false);                   // override took effect (default discarded), but BAD failed
    expect(fired.has('F4')).toBe(true);                    // other cheat unchanged
    unregisterAll();
  });
});
