import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpUserDataRef = { current: '' };

vi.mock('electron', () => ({
  app: { getPath: (k: string) => k === 'userData' ? tmpUserDataRef.current : '' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const registerForTrainer = vi.fn();
vi.mock('../../src/main/hotkey-host.js', () => ({
  registerForTrainer,
}));

vi.mock('../../src/main/engine-host.js', () => ({
  setActiveTrainer: vi.fn(),
  cancelAllFreezes: vi.fn(async () => undefined),
  getActiveTrainer: () => null,
  updateProcessName: vi.fn(),
}));
vi.mock('../../src/main/process-host-singleton.js', () => ({
  processHost: { setTrainerProcessNames: vi.fn() },
}));

beforeEach(async () => {
  tmpUserDataRef.current = join(tmpdir(), `starlight-trainer-overrides-${Date.now()}-${Math.random()}`);
  await mkdir(tmpUserDataRef.current, { recursive: true });
  registerForTrainer.mockClear();
});

describe('trainer-loader hotkey overrides at activation', () => {
  it('passes empty overrides when none configured', async () => {
    const { setTrainerFromCatalog } = await import('../../src/main/trainer-loader.js');
    const { clearConfigCache } = await import('../../src/main/user-config.js');
    clearConfigCache();
    await setTrainerFromCatalog({
      schemaVersion: 1, id: 'plain-trainer',
      game: { name: 'Plain', processName: ['plain.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
      categories: [],
    } as never);
    expect(registerForTrainer).toHaveBeenCalled();
    const args = registerForTrainer.mock.calls[0]!;
    expect(args[1]).toEqual({});
  });

  it('passes hotkey overrides for matching trainer id', async () => {
    const { updateConfigFrom } = await import('../../src/main/user-config.js');
    await updateConfigFrom(join(tmpUserDataRef.current, 'config.json'), {
      hotkeyOverrides: {
        'overridden-trainer': { 'speed': { toggle: 'F5' } },
      },
    });
    const { setTrainerFromCatalog } = await import('../../src/main/trainer-loader.js');
    const { clearConfigCache } = await import('../../src/main/user-config.js');
    clearConfigCache();
    await setTrainerFromCatalog({
      schemaVersion: 1, id: 'overridden-trainer',
      game: { name: 'O', processName: ['o.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
      categories: [],
    } as never);
    expect(registerForTrainer).toHaveBeenCalled();
    const args = registerForTrainer.mock.calls[0]!;
    expect(args[1]).toEqual({ 'speed': { toggle: 'F5' } });
  });
});
