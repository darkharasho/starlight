import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers: Array<(e: unknown) => void> = [];
const startMock = vi.fn();

vi.mock('uiohook-napi', () => ({
  uIOhook: {
    on: vi.fn((evt: string, h: (e: unknown) => void) => { if (evt === 'keydown') handlers.push(h); }),
    off: vi.fn((_evt: string, h: (e: unknown) => void) => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    }),
    start: startMock,
    stop: vi.fn(),
  },
  UiohookKey: { F1: 0x3b, F4: 0x3e, Y: 0x15, N: 0x31, End: 0xcf },
}));

const calls: string[] = [];
vi.mock('../../src/main/engine-host.js', () => ({
  toggleCheat: vi.fn(async (id: string, on: boolean) => { calls.push(`toggle:${id}:${on}`); return { ok: true }; }),
  incCheat: vi.fn(async () => ({ ok: true })),
  decCheat: vi.fn(async () => ({ ok: true })),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

beforeEach(async () => {
  handlers.length = 0;
  calls.length = 0;
  startMock.mockReset();
  const h = await import('../../src/main/hotkey-host.js');
  h.setAgentHotkeys(null);
  h.shutdown();
});

const fire = (e: object): Promise<void> =>
  Promise.all(handlers.map((h) => Promise.resolve(h({ keycode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...e })))).then(() => undefined);

const trainer = {
  id: 'demo',
  game: { name: 'Demo', processName: ['demo.exe'], platform: ['windows'] },
  metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
  categories: [{ name: 'X', cheats: [
    { id: 'godmode', name: 'God', type: 'toggle', valueType: 'uint32', address: { kind: 'absolute', address: '0x0' }, hotkeys: { toggle: 'F1' } },
  ] }],
} as never;

describe('agent hotkeys', () => {
  it('agent bindings fire and survive registerForTrainer and unregisterAll', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const on = { yes: vi.fn(), no: vi.fn(), stop: vi.fn() };
    expect(h.setAgentHotkeys({ yes: 'Ctrl+Shift+Y', no: 'Ctrl+Shift+N', stop: 'Ctrl+Shift+End' }, on)).toEqual({ ok: true });
    expect(startMock).toHaveBeenCalledTimes(1);
    h.registerForTrainer(trainer);
    h.unregisterAll();
    await fire({ keycode: 0x15, ctrlKey: true, shiftKey: true });
    await fire({ keycode: 0x31, ctrlKey: true, shiftKey: true });
    await fire({ keycode: 0xcf, ctrlKey: true, shiftKey: true });
    expect(on.yes).toHaveBeenCalledTimes(1);
    expect(on.no).toHaveBeenCalledTimes(1);
    expect(on.stop).toHaveBeenCalledTimes(1);
  });

  it('a bound agent hotkey takes priority over a cheat hotkey', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const on = { stop: vi.fn() };
    h.setAgentHotkeys({ stop: 'F1' }, on);
    h.registerForTrainer(trainer);
    await fire({ keycode: 0x3b });
    expect(on.stop).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('reports invalid accelerators', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const r = h.setAgentHotkeys({ yes: 'NonsenseKey', no: 'Ctrl+Shift+N' }, { yes: vi.fn(), no: vi.fn() });
    expect(r).toEqual({ ok: false, invalid: ['NonsenseKey'] });
  });

  it('null clears the agent bindings', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const on = { yes: vi.fn(), no: vi.fn(), stop: vi.fn() };
    h.setAgentHotkeys({ yes: 'Ctrl+Shift+Y', stop: 'Ctrl+Shift+End' }, on);
    h.setAgentHotkeys(null);
    await fire({ keycode: 0x15, ctrlKey: true, shiftKey: true });
    await fire({ keycode: 0xcf, ctrlKey: true, shiftKey: true });
    expect(on.yes).not.toHaveBeenCalled();
    expect(on.stop).not.toHaveBeenCalled();
  });

  it('binding yes/no keeps the stop binding', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const stop = vi.fn();
    const yes = vi.fn();
    h.setAgentHotkeys({ stop: 'Ctrl+Shift+End' }, { stop });
    h.setAgentHotkeys({ yes: 'Ctrl+Shift+Y', no: 'Ctrl+Shift+N' }, { yes, no: vi.fn() });
    await fire({ keycode: 0xcf, ctrlKey: true, shiftKey: true });
    await fire({ keycode: 0x15, ctrlKey: true, shiftKey: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(yes).toHaveBeenCalledTimes(1);
    h.setAgentHotkeys({ yes: null, no: null });
    await fire({ keycode: 0x15, ctrlKey: true, shiftKey: true });
    await fire({ keycode: 0xcf, ctrlKey: true, shiftKey: true });
    expect(yes).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
