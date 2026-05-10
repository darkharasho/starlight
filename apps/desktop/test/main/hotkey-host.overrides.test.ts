import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers: Array<(e: unknown) => void> = [];

vi.mock('uiohook-napi', () => ({
  uIOhook: {
    on: vi.fn((evt: string, h: (e: unknown) => void) => { if (evt === 'keydown') handlers.push(h); }),
    off: vi.fn((_evt: string, h: (e: unknown) => void) => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    }),
    start: vi.fn(),
    stop: vi.fn(),
  },
  UiohookKey: {
    F1: 0x3b, F4: 0x3e, F5: 0x3f,
    ArrowUp: 0xc8, ArrowDown: 0xd0,
  },
}));

const calls: string[] = [];
vi.mock('../../src/main/engine-host.js', () => ({
  toggleCheat: vi.fn(async (id: string, on: boolean) => { calls.push(`toggle:${id}:${on}`); return { ok: true }; }),
  incCheat:    vi.fn(async (id: string) => { calls.push(`inc:${id}`); return { ok: true }; }),
  decCheat:    vi.fn(async (id: string) => { calls.push(`dec:${id}`); return { ok: true }; }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

beforeEach(() => { handlers.length = 0; calls.length = 0; });

function fireKey(keycode: number): Promise<void> {
  const e = { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  return Promise.all(handlers.map(h => Promise.resolve(h(e)))).then(() => undefined);
}

const trainer = {
  id: 'demo',
  categories: [{
    name: 'X',
    cheats: [
      { id: 'godmode', name: 'God', type: 'toggle', valueType: 'uint32',
        address: { kind: 'absolute', address: '0x0' },
        hotkeys: { toggle: 'F1' } },
      { id: 'speed', name: 'Speed', type: 'set', valueType: 'float',
        address: { kind: 'absolute', address: '0x0' },
        min: 0, max: 10, step: 0.5, default: 1,
        hotkeys: { toggle: 'F4', inc: 'F4+Up', dec: 'F4+Down' } },   // F4+Up unparseable; matches Phase 5.3 fixture
    ],
  }],
} as never;

describe('hotkey-host overrides (uiohook)', () => {
  it('uses defaults when no overrides passed', async () => {
    const { registerForTrainer, shutdown } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer);
    await fireKey(0x3b);                    // F1 → godmode
    expect(calls).toContain('toggle:godmode:true');
    await fireKey(0x3e);                    // F4 → speed toggle
    expect(calls).toContain('toggle:speed:true');
    shutdown();
  });

  it('replaces a slot when override is a non-null string', async () => {
    const { registerForTrainer, shutdown } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, { speed: { toggle: 'F5' } });
    await fireKey(0x3f);                    // F5 → speed toggle (overridden)
    expect(calls).toContain('toggle:speed:true');
    calls.length = 0;
    await fireKey(0x3e);                    // F4 → no longer fires speed
    expect(calls).not.toContain('toggle:speed:true');
    shutdown();
  });

  it('clears a slot when override is null', async () => {
    const { registerForTrainer, shutdown } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, { godmode: { toggle: null } });
    await fireKey(0x3b);                    // F1 → no longer fires godmode
    expect(calls).not.toContain('toggle:godmode:true');
    await fireKey(0x3e);                    // F4 → speed still fires
    expect(calls).toContain('toggle:speed:true');
    shutdown();
  });

  it('handles missing override entries gracefully', async () => {
    const { registerForTrainer, shutdown } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, {});
    await fireKey(0x3b);
    expect(calls).toContain('toggle:godmode:true');
    shutdown();
  });

  it('silently skips an override accelerator that does not parse', async () => {
    const { registerForTrainer, shutdown } = await import('../../src/main/hotkey-host.js');
    registerForTrainer(trainer, { godmode: { toggle: 'NonsenseKey' } });
    // F1 default replaced by unparseable override → no matcher registered for godmode toggle.
    await fireKey(0x3b);
    expect(calls).not.toContain('toggle:godmode:true');
    // Speed toggle still works via its default F4.
    await fireKey(0x3e);
    expect(calls).toContain('toggle:speed:true');
    shutdown();
  });
});
