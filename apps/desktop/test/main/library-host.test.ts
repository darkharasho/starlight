import { describe, it, expect, beforeAll } from 'vitest';
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { SteamScanner, scanAll } from '../../src/main/library-host.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIX = join(__dirname, '../fixtures/steam');

async function prepareSteamRoot(): Promise<string> {
  const root = join(tmpdir(), `starlight-steam-${Date.now()}`);
  // Steam expects libraryfolders.vdf under <root>/steamapps/
  await mkdir(join(root, 'steamapps'), { recursive: true });
  await mkdir(join(root, 'steamapps', 'common', 'Team Fortress 2'), { recursive: true });
  await mkdir(join(root, 'steamapps', 'common', 'Counter-Strike Global Offensive'), { recursive: true });

  // Library 1 = root itself
  const lf = (await readFile(join(FIX, 'libraryfolders.vdf'), 'utf8'))
    .replaceAll('FIXTURE_ROOT', root);
  await writeFile(join(root, 'steamapps', 'libraryfolders.vdf'), lf);

  // Copy library1 manifests directly under root/steamapps
  await copyFile(join(FIX, 'library1', 'steamapps', 'appmanifest_440.acf'),
                 join(root, 'steamapps', 'appmanifest_440.acf'));
  await copyFile(join(FIX, 'library1', 'steamapps', 'appmanifest_730.acf'),
                 join(root, 'steamapps', 'appmanifest_730.acf'));

  // Build library2 alongside root
  const lib2 = join(root, 'library2');
  await mkdir(join(lib2, 'steamapps', 'common', 'dota 2 beta'), { recursive: true });
  await copyFile(join(FIX, 'library2', 'steamapps', 'appmanifest_570.acf'),
                 join(lib2, 'steamapps', 'appmanifest_570.acf'));

  return root;
}

describe('SteamScanner', () => {
  let root: string;
  beforeAll(async () => { root = await prepareSteamRoot(); });

  it('returns all installed games across libraries', async () => {
    const s = new SteamScanner({ rootResolver: async () => root });
    const games = await s.scan();
    expect(games).toHaveLength(3);
    const byId = Object.fromEntries(games.map(g => [g.appId, g]));
    expect(byId['440']!.name).toBe('Team Fortress 2');
    expect(byId['440']!.installDir).toBe(join(root, 'steamapps', 'common', 'Team Fortress 2'));
    expect(byId['730']!.installDir).toBe(join(root, 'steamapps', 'common', 'Counter-Strike Global Offensive'));
    expect(byId['570']!.installDir).toBe(join(root, 'library2', 'steamapps', 'common', 'dota 2 beta'));
    for (const g of games) expect(g.source).toBe('steam');
  });

  it('returns [] when root cannot be resolved', async () => {
    const s = new SteamScanner({ rootResolver: async () => null });
    expect(await s.scan()).toEqual([]);
  });

  it('returns [] when libraryfolders.vdf is missing', async () => {
    const empty = join(tmpdir(), `starlight-empty-${Date.now()}`);
    await mkdir(empty, { recursive: true });
    const s = new SteamScanner({ rootResolver: async () => empty });
    expect(await s.scan()).toEqual([]);
    await rm(empty, { recursive: true, force: true });
  });

  it('returns [] when libraryfolders.vdf is malformed', async () => {
    const bad = join(tmpdir(), `starlight-bad-${Date.now()}`);
    await mkdir(join(bad, 'steamapps'), { recursive: true });
    await writeFile(join(bad, 'steamapps', 'libraryfolders.vdf'), 'this is not vdf');
    const s = new SteamScanner({ rootResolver: async () => bad });
    expect(await s.scan()).toEqual([]);
    await rm(bad, { recursive: true, force: true });
  });
});

describe('scanAll', () => {
  it('aggregates across registered scanners and tolerates failures', async () => {
    const games = await scanAll([
      { source: 'steam', scan: async () => [{ source: 'steam', appId: '1', name: 'A', installDir: '/a' }] },
      { source: 'steam', scan: async () => { throw new Error('boom'); } },
      { source: 'steam', scan: async () => [{ source: 'steam', appId: '2', name: 'B', installDir: '/b' }] },
    ]);
    expect(games.map(g => g.appId).sort()).toEqual(['1', '2']);
  });
});
