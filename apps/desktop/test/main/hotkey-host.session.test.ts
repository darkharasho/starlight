// @vitest-environment node
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
  UiohookKey: { F1: 0x3b, F2: 0x3c, F3: 0x3d },
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
  h.clearSessionHotkeys();
  h.unregisterAll();
  h.shutdown();
});

const fire = (e: object): Promise<void> =>
  Promise.all(handlers.map((h) => Promise.resolve(h({ keycode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...e })))).then(() => undefined);

const trainer = {
  id: 'demo',
  game: { name: 'Demo', processName: ['demo.exe'], platform: ['windows'] },
  metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
  categories: [{ name: 'X', cheats: [
    { id: 'godmode', name: 'God', type: 'toggle', valueType: 'uint32', address: { kind: 'absolute', address: '0x0' }, hotkeys: { toggle: 'F3' } },
  ] }],
} as never;

describe('session hotkeys', () => {
  it('session hotkeys survive registerForTrainer and unregisterAll', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const onPress = vi.fn();
    h.setSessionHotkeys([{ id: 0, accelerator: 'F1' }, { id: 7, accelerator: 'Ctrl+F2' }], onPress);
    expect(startMock).toHaveBeenCalledTimes(1);
    h.registerForTrainer(trainer);
    h.unregisterAll();
    await fire({ keycode: 0x3b });
    await fire({ keycode: 0x3c, ctrlKey: true });
    await fire({ keycode: 0x3c }); // no Ctrl: not bound
    expect(onPress.mock.calls).toEqual([[0], [7]]);
  });

  it('setSessionHotkeys replaces the previous session bindings', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const first = vi.fn();
    const second = vi.fn();
    h.setSessionHotkeys([{ id: 1, accelerator: 'F1' }], first);
    h.setSessionHotkeys([{ id: 2, accelerator: 'F2' }], second);
    await fire({ keycode: 0x3b });
    await fire({ keycode: 0x3c });
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls).toEqual([[2]]);
    h.clearSessionHotkeys();
    await fire({ keycode: 0x3c });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('skips bindings with an accelerator it cannot read, and a throwing handler does not break the listener', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const onPress = vi.fn(() => { throw new Error('boom'); });
    h.setSessionHotkeys([{ id: 1, accelerator: 'NotAKey' }, { id: 2, accelerator: 'F1' }], onPress);
    await fire({ keycode: 0x3b });
    await fire({ keycode: 0x3b });
    expect(onPress.mock.calls).toEqual([[2], [2]]);
  });

  it('trainer hotkeys keep working next to session hotkeys', async () => {
    const h = await import('../../src/main/hotkey-host.js');
    const onPress = vi.fn();
    h.setSessionHotkeys([{ id: 1, accelerator: 'F1' }], onPress);
    h.registerForTrainer(trainer);
    await fire({ keycode: 0x3d });
    expect(calls).toEqual(['toggle:godmode:true']);
    expect(onPress).not.toHaveBeenCalled();
  });
});
