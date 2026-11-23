import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findAntiCheat, detectAntiCheat, antiCheatMessage } from '../../src/main/anti-cheat.js';

const line = (path: string) => `7f0000000000-7f0000100000 r-xp 00000000 08:01 1234  ${path}`;

describe('findAntiCheat', () => {
  it('detects EAC loaded via a Proton path with spaces', () => {
    const maps = line('/home/u/.steam/steamapps/common/Some Game/EasyAntiCheat/EasyAntiCheat_EOS_x64.dll');
    expect(findAntiCheat(maps)).toEqual({ name: 'Easy Anti-Cheat', module: 'EasyAntiCheat_EOS_x64.dll' });
  });
  it('detects the Proton BattlEye runtime .so', () => {
    const maps = line('/x/Proton BattlEye Runtime/v1/beclient_x64.so');
    expect(findAntiCheat(maps)).toEqual({ name: 'BattlEye', module: 'beclient_x64.so' });
  });
  it('strips a trailing (deleted)', () => {
    expect(findAntiCheat(line('/x/beclient_x64.so (deleted)'))?.module).toBe('beclient_x64.so');
  });
  it('ignores anti-cheat files that are not mapped', () => {
    expect(findAntiCheat(line('/x/game.exe') + '\n' + line('/lib/libc.so.6'))).toBeNull();
  });
  it('ignores EOSSDK', () => {
    expect(findAntiCheat(line('/x/EOSSDK-Win64-Shipping.dll'))).toBeNull();
  });
});

describe('detectAntiCheat', () => {
  it('reads maps through the injected reader', async () => {
    const hit = await detectAntiCheat(5, async () => line('/x/beclient_x64.so'));
    expect(hit?.name).toBe('BattlEye');
  });
  it('returns null when maps are unreadable', async () => {
    expect(await detectAntiCheat(5, async () => { throw new Error('ESRCH'); })).toBeNull();
  });
  it('message text', () => {
    expect(antiCheatMessage({ name: 'BattlEye', module: 'm' })).toBe(
      "BattlEye is running in this game, so Starlight won't attach. Starlight only works with single-player games that don't have anti-cheat running.");
  });
});

describe('engine-host.attach anti-cheat', () => {
  beforeEach(() => vi.resetModules());
  it('refuses with code anti-cheat and never calls the engine', async () => {
    const attachMock = vi.fn();
    const getClient = vi.fn(async () => ({}));
    vi.doMock('../../src/main/starlightd-host.js', () => ({ getEngineClient: getClient }));
    vi.doMock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
    vi.doMock('@starlight/engine', () => ({
      attach: attachMock, read: vi.fn(), write: vi.fn(), resolvePointerChain: vi.fn(), aobScan: vi.fn(), freeze: vi.fn(),
      AttachError: class extends Error {}, PermissionError: class extends Error {}, ScanError: class extends Error {},
      ReadError: class extends Error {}, WriteError: class extends Error {},
    }));
    const eh = await import('../../src/main/engine-host.js');
    const r = await eh.attach(9, async () => ({ name: 'BattlEye', module: 'beclient_x64.so' }));
    expect(r).toEqual({ ok: false, code: 'anti-cheat', message: antiCheatMessage({ name: 'BattlEye', module: 'beclient_x64.so' }) });
    expect(attachMock).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });
  it('re-checks before writing: anti-cheat loaded after attach detaches and refuses', async () => {
    const freezeMock = vi.fn(async () => ({ cancel: vi.fn(async () => undefined) }));
    const detachMock = vi.fn(async () => undefined);
    vi.doMock('../../src/main/starlightd-host.js', () => ({ getEngineClient: async () => ({}) }));
    vi.doMock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
    vi.doMock('@starlight/engine', () => ({
      attach: vi.fn(async () => ({ pid: 9, handle: 1, attached: true, onDetached: vi.fn(), detach: detachMock })),
      read: vi.fn(), write: vi.fn(), resolvePointerChain: vi.fn(), aobScan: vi.fn(), freeze: freezeMock,
      AttachError: class extends Error {}, PermissionError: class extends Error {}, ScanError: class extends Error {},
      ReadError: class extends Error {}, WriteError: class extends Error {},
    }));
    const eh = await import('../../src/main/engine-host.js');
    let calls = 0;
    const hit = { name: 'Easy Anti-Cheat', module: 'easyanticheat_x64.dll' };
    expect((await eh.attach(9, async () => (++calls === 1 ? null : hit))).ok).toBe(true);
    eh.setActiveTrainer({
      game: { name: 'g', processName: ['x'] },
      categories: [{ name: 'c', cheats: [{
        id: 'hp', name: 'HP', type: 'toggle', valueType: 'uint32', value: 1,
        address: { kind: 'absolute', address: '0x100' },
      }] }],
    } as never);
    const r = await eh.toggleCheat('hp', true);
    expect(r).toEqual({ ok: false, error: antiCheatMessage(hit) });
    expect(freezeMock).not.toHaveBeenCalled();
    expect(detachMock).toHaveBeenCalled();
    expect(eh.isAttached()).toBe(false);
  });
});
