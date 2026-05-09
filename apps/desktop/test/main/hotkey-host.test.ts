import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron globalShortcut
const fired = new Map<string, () => void>();
vi.mock('electron', () => ({
  globalShortcut: {
    register: (accel: string, cb: () => void) => {
      if (accel === 'BAD') return false;
      fired.set(accel, cb);
      return true;
    },
    unregister: (accel: string) => { fired.delete(accel); },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

// Mock engine-host
const calls: string[] = [];
vi.mock('../../src/main/engine-host.js', () => ({
  toggleCheat: vi.fn(async (id: string, on: boolean) => { calls.push(`toggle:${id}:${on}`); return { ok: true }; }),
  incCheat:    vi.fn(async (id: string) => { calls.push(`inc:${id}`); return { ok: true }; }),
  decCheat:    vi.fn(async (id: string) => { calls.push(`dec:${id}`); return { ok: true }; }),
}));

beforeEach(() => { fired.clear(); calls.length = 0; });

describe('hotkey-host', () => {
  it('registers toggle/inc/dec slots for a value cheat and dispatches', async () => {
    const { registerForTrainer, unregisterAll } = await import('../../src/main/hotkey-host.js');
    registerForTrainer({
      categories: [{ name: 'X', cheats: [{
        id: 'speed', name: 'Speed', type: 'set', kind: 'value',
        valueType: 'float', address: { kind: 'absolute', address: '0x0' },
        min: 0, max: 10, step: 0.5, default: 1,
        hotkeys: { toggle: 'F4', inc: 'F4+Up', dec: 'F4+Down' },
      }] }],
    } as never);
    expect(fired.has('F4')).toBe(true);
    expect(fired.has('F4+Up')).toBe(true);
    expect(fired.has('F4+Down')).toBe(true);

    fired.get('F4+Up')!();
    fired.get('F4+Down')!();
    fired.get('F4')!();
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toContain('inc:speed');
    expect(calls).toContain('dec:speed');
    expect(calls).toContain('toggle:speed:true');

    unregisterAll();
    expect(fired.size).toBe(0);
  });

  it('skips accelerators globalShortcut rejects', async () => {
    const { registerForTrainer, unregisterAll } = await import('../../src/main/hotkey-host.js');
    registerForTrainer({
      categories: [{ name: 'X', cheats: [{
        id: 'godmode', name: 'God', type: 'toggle', kind: 'toggle',
        valueType: 'uint32', address: { kind: 'absolute', address: '0x0' },
        hotkeys: { toggle: 'BAD' },
      }] }],
    } as never);
    expect(fired.size).toBe(0);
    unregisterAll();
  });
});
