import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpUserDataRef = { current: '' };

// Mock electron's app.getPath('userData') for user-config to write under tmp.
vi.mock('electron', () => ({
  app: { getPath: (k: string) => k === 'userData' ? tmpUserDataRef.current : '' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

// Mock side-effect modules that trainer-loader pulls in.
vi.mock('../../src/main/engine-host.js', () => ({
  setActiveTrainer: vi.fn(),
  cancelAllFreezes: vi.fn(async () => undefined),
  getActiveTrainer: () => null,
  updateProcessName: vi.fn(),
}));
vi.mock('../../src/main/hotkey-host.js', () => ({
  registerForTrainer: vi.fn(),
}));
vi.mock('../../src/main/process-host-singleton.js', () => ({
  processHost: { setTrainerProcessNames: vi.fn() },
}));

beforeEach(async () => {
  tmpUserDataRef.current = join(tmpdir(), `starlight-trainer-recents-${Date.now()}-${Math.random()}`);
  await mkdir(tmpUserDataRef.current, { recursive: true });
});

describe('trainer-loader pushRecent', () => {
  it('pushes a catalog entry with source: catalog', async () => {
    const { setTrainerFromCatalog } = await import('../../src/main/trainer-loader.js');
    const { getConfig, clearConfigCache } = await import('../../src/main/user-config.js');
    clearConfigCache();
    const r = await setTrainerFromCatalog({
      schemaVersion: 1,
      id: 'demo-trainer',
      game: { name: 'Demo', processName: ['demo.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
      categories: [],
    } as never);
    expect(r.ok).toBe(true);
    const cfg = await getConfig();
    expect(cfg.recents).toHaveLength(1);
    expect(cfg.recents[0]).toMatchObject({ id: 'demo-trainer', source: 'catalog' });
  });

  it('caps recents at 20 and dedupes', async () => {
    const { setTrainerFromCatalog } = await import('../../src/main/trainer-loader.js');
    const { getConfig, clearConfigCache } = await import('../../src/main/user-config.js');
    clearConfigCache();
    for (let i = 0; i < 25; i++) {
      await setTrainerFromCatalog({
        schemaVersion: 1,
        id: `trainer-${i}`,
        game: { name: `T${i}`, processName: ['t.exe'], platform: ['windows'] },
        metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
        categories: [],
      } as never);
    }
    // Re-add an existing one to test dedupe-and-promote.
    await setTrainerFromCatalog({
      schemaVersion: 1,
      id: 'trainer-3',
      game: { name: 'T3', processName: ['t.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
      categories: [],
    } as never);
    const cfg = await getConfig();
    expect(cfg.recents.length).toBeLessThanOrEqual(20);
    expect(cfg.recents[0]!.id).toBe('trainer-3');                 // most recent
    expect(cfg.recents.filter(r => r.id === 'trainer-3')).toHaveLength(1);
  });

  it('applies processNameOverrides to trainer.game.processName before registration', async () => {
    const { updateConfigFrom } = await import('../../src/main/user-config.js');
    const { join } = await import('node:path');
    await updateConfigFrom(join(tmpUserDataRef.current, 'config.json'), {
      processNameOverrides: { 'overridden-trainer': ['custom-name.exe'] },
    });
    const { clearConfigCache } = await import('../../src/main/user-config.js');
    clearConfigCache();
    const { setTrainerFromCatalog } = await import('../../src/main/trainer-loader.js');
    const result = await setTrainerFromCatalog({
      schemaVersion: 1,
      id: 'overridden-trainer',
      game: { name: 'Demo', processName: ['original.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
      categories: [],
    } as never);
    expect(result.ok).toBe(true);
    const { processHost } = await import('../../src/main/process-host-singleton.js');
    expect(processHost.setTrainerProcessNames).toHaveBeenCalledWith(['custom-name.exe']);
  });
});
