import { describe, it, expect } from 'vitest';
import { ManualScanner } from '../../src/main/library-host.js';
import type { CatalogIndex } from '../../src/shared/ipc.js';
import type { ManualGame } from '../../src/shared/ipc.js';

const sampleCatalog: CatalogIndex = {
  schemaVersion: 1,
  generatedAt: '2026-05-09T00:00:00Z',
  games: [
    { id: 'elden-ring', name: 'Elden Ring', steamAppId: 1245620,
      processName: ['eldenring.exe'], platform: ['windows'],
      trainerPath: 'trainers/elden-ring.json' },
    { id: 'stardew-valley', name: 'Stardew Valley', steamAppId: 413150,
      processName: ['Stardew Valley.exe'], platform: ['windows'],
      trainerPath: 'trainers/stardew-valley.json' },
  ],
};

describe('ManualScanner', () => {
  it('returns [] when no manual games configured', async () => {
    const s = new ManualScanner({
      readManualGames: async () => [],
      readCatalog:     async () => null,
    });
    expect(await s.scan()).toEqual([]);
  });

  it('yields one DetectedGame per manual entry with source: manual', async () => {
    const games: ManualGame[] = [
      { id: 'manual-my-game-abc123', name: 'My Game',
        exePath: '/games/my-game/MyGame.exe', addedAt: '2026-05-09T00:00:00Z' },
    ];
    const s = new ManualScanner({
      readManualGames: async () => games,
      readCatalog:     async () => null,
    });
    const out = await s.scan();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: 'manual',
      appId: 'manual-my-game-abc123',
      name: 'My Game',
      installDir: '/games/my-game',
    });
    expect(out[0]!.boxartSteamAppId).toBeUndefined();
  });

  it('matches against catalog by exe basename and sets boxartSteamAppId', async () => {
    const games: ManualGame[] = [
      { id: 'manual-elden-ring-zzz', name: 'Elden Ring (cracked)',
        exePath: '/games/EldenRing/eldenring.exe', addedAt: '2026-05-09T00:00:00Z' },
    ];
    const s = new ManualScanner({
      readManualGames: async () => games,
      readCatalog:     async () => sampleCatalog,
    });
    const out = await s.scan();
    expect(out[0]!.boxartSteamAppId).toBe(1245620);
  });

  it('matches case-insensitively against catalog processName', async () => {
    const games: ManualGame[] = [
      { id: 'manual-stardew-aaa', name: 'Stardew',
        exePath: 'C:\\Games\\STARDEW VALLEY.EXE', addedAt: '2026-05-09T00:00:00Z' },
    ];
    const s = new ManualScanner({
      readManualGames: async () => games,
      readCatalog:     async () => sampleCatalog,
    });
    const out = await s.scan();
    expect(out[0]!.boxartSteamAppId).toBe(413150);
  });

  it('returns [] gracefully when readManualGames throws', async () => {
    const s = new ManualScanner({
      readManualGames: async () => { throw new Error('config read failed'); },
      readCatalog:     async () => null,
    });
    expect(await s.scan()).toEqual([]);
  });
});
