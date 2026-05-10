import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HeroicScanner } from '../../src/main/library-host.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX = join(__dirname, '..', 'fixtures', 'heroic');

let configDir: string;

beforeAll(async () => {
  configDir = join(tmpdir(), `starlight-heroic-${Date.now()}`);
  await mkdir(join(configDir, 'store_cache'), { recursive: true });
  await mkdir(join(configDir, 'gog_store'), { recursive: true });
  await copyFile(join(FIX, 'store_cache', 'library.json'), join(configDir, 'store_cache', 'library.json'));
  await copyFile(join(FIX, 'gog_store', 'library.json'), join(configDir, 'gog_store', 'library.json'));
});

afterAll(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('HeroicScanner', () => {
  it('reads Epic-via-Heroic and GOG-via-Heroic libraries and merges', async () => {
    const s = new HeroicScanner({ configResolver: async () => configDir });
    const games = await s.scan();
    expect(games).toHaveLength(2);                        // Fortnite + Witcher; RocketLeague skipped (empty install)
    const byName = Object.fromEntries(games.map(g => [g.name, g]));
    expect(byName['Fortnite']).toMatchObject({
      source: 'heroic',
      installDir: '/games/Fortnite',
      appId: 'Fortnite',
    });
    expect(byName['Witcher 3: Wild Hunt']).toMatchObject({
      source: 'heroic',
      installDir: '/games/Witcher3',
      appId: '1207658691',
    });
  });

  it('returns [] when config dir does not exist', async () => {
    const s = new HeroicScanner({ configResolver: async () => '/nonexistent' });
    expect(await s.scan()).toEqual([]);
  });

  it('tolerates missing store_cache/library.json (only GOG present)', async () => {
    const dir = join(tmpdir(), `starlight-heroic-gog-only-${Date.now()}`);
    await mkdir(join(dir, 'gog_store'), { recursive: true });
    await copyFile(join(FIX, 'gog_store', 'library.json'), join(dir, 'gog_store', 'library.json'));
    const s = new HeroicScanner({ configResolver: async () => dir });
    const games = await s.scan();
    expect(games).toHaveLength(1);
    expect(games[0]!.name).toBe('Witcher 3: Wild Hunt');
    await rm(dir, { recursive: true, force: true });
  });

  it('skips games with empty install_path', async () => {
    const s = new HeroicScanner({ configResolver: async () => configDir });
    const games = await s.scan();
    expect(games.find(g => g.name === 'Rocket League')).toBeUndefined();
  });

  it('returns [] when both library files are malformed', async () => {
    const dir = join(tmpdir(), `starlight-heroic-bad-${Date.now()}`);
    const fs = await import('node:fs/promises');
    await mkdir(join(dir, 'store_cache'), { recursive: true });
    await fs.writeFile(join(dir, 'store_cache', 'library.json'), 'not json {');
    const s = new HeroicScanner({ configResolver: async () => dir });
    expect(await s.scan()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});
