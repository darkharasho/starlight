import { describe, it, expect, vi } from 'vitest';
import { identifyGame, parseAppManifest, steamappsDirFor, EXE_HASH_LIMIT, type IdentityDeps } from '../../src/main/game-identity.js';
import { gameKey, userCheatsKey } from '../../src/shared/game-key.js';
import type { CatalogEntry } from '../../src/main/game-matcher.js';

const ACF = '"AppState" { "appid" "2784470" "buildid" "17012345" }';

function deps(o: Partial<IdentityDeps> & { env?: string; exe?: string; name?: string }): IdentityDeps {
  return {
    catalogIndex: () => new Map<string, CatalogEntry>(),
    detectedGames: () => [],
    readEnviron: async () => o.env ?? '',
    readText: async () => { throw new Error('ENOENT'); },
    readMaps: async () => '',
    exePath: async () => o.exe ?? '/opt/target',
    exeName: async () => o.name,
    fileSize: async () => 10,
    hashFile: async () => 'abc',
    ...o,
  };
}

describe('game identity', () => {
  it('parseAppManifest reads appid and buildid', () => {
    expect(parseAppManifest(ACF)).toEqual({ appId: 2784470, buildId: '17012345' });
    expect(parseAppManifest('garbage')).toBeNull();
  });

  it('steamappsDirFor handles Proton and native', () => {
    expect(steamappsDirFor({ compatDataPath: '/lib/steamapps/compatdata/12' })).toBe('/lib/steamapps');
    expect(steamappsDirFor({ exePath: '/lib/steamapps/common/G/g' })).toBe('/lib/steamapps');
    expect(steamappsDirFor({ exePath: '/opt/g' })).toBeNull();
  });

  it('Proton game: app id from compatdata, build id from the library manifest', async () => {
    const readText = vi.fn(async (p: string) => {
      if (p === '/lib/steamapps/appmanifest_2784470.acf') return ACF;
      throw new Error('ENOENT');
    });
    const id = await identifyGame(1, deps({ env: 'STEAM_COMPAT_DATA_PATH=/lib/steamapps/compatdata/2784470\0', name: '9Kings.exe', readText }));
    expect(id).toMatchObject({ proton: true, steamAppId: 2784470, buildId: '17012345' });
  });

  it('native Steam game: SteamAppId from the environment, manifest found above the exe', async () => {
    const id = await identifyGame(1, deps({
      env: 'SteamAppId=2784470\0', exe: '/lib/steamapps/common/G/game',
      readText: async (p) => (p === '/lib/steamapps/appmanifest_2784470.acf' ? ACF : Promise.reject(new Error('x'))),
    }));
    expect(id).toMatchObject({ proton: false, steamAppId: 2784470, buildId: '17012345' });
  });

  it('non-Steam game: no app id or build id; key from the exe name', async () => {
    const id = await identifyGame(1, deps({ exe: '/opt/target' }));
    expect(id).toMatchObject({ steamAppId: null, buildId: null, name: 'target', key: 'target', exeName: 'target', catalogId: null });
  });

  it('a manual game is named after its library entry', async () => {
    const id = await identifyGame(1, deps({
      exe: '/opt/t/target',
      detectedGames: () => [{ source: 'manual', appId: 'm', name: 'Target Game', installDir: '/opt/t' }],
    }));
    expect(id.name).toBe('Target Game');
    expect(id.key).toBe('targetgame');
  });

  it('a catalog match names the game and sets catalogId', async () => {
    const entry: CatalogEntry = { id: '9-kings', name: '9 Kings', steamAppId: null, trainerSource: 'x' };
    const id = await identifyGame(1, deps({ name: '9Kings.exe', catalogIndex: () => new Map([['9kings', entry]]) }));
    expect(id.catalogId).toBe('9-kings');
    expect(id.key).toBe(gameKey('9 Kings'));
  });

  it('exeHash is the sha256 of the exe file, null above 1 GiB', async () => {
    const hashFile = vi.fn(async () => 'deadbeef');
    expect((await identifyGame(1, deps({ hashFile }))).exeHash).toBe('deadbeef');
    expect((await identifyGame(1, deps({ hashFile, fileSize: async () => EXE_HASH_LIMIT + 1 }))).exeHash).toBeNull();
    hashFile.mockClear();
    expect((await identifyGame(1, deps({ hashFile }), { hash: false })).exeHash).toBeNull();
    expect(hashFile).not.toHaveBeenCalled();
  });

  it('hashing the real default reads degrade to null instead of throwing', async () => {
    const id = await identifyGame(1, { catalogIndex: () => new Map(), detectedGames: () => [], exePath: async () => '/nonexistent/x' });
    expect(id.exeHash).toBeNull();
  });

  it('Proton exe file is the mapped .exe with the process exe name', async () => {
    const hashFile = vi.fn(async () => 'h');
    const maps = [
      '7f00-7f01 r-xp 00000000 08:01 1 /lib/steamapps/common/G/UnityPlayer.dll',
      '7f02-7f03 r-xp 00000000 08:01 2 /lib/steamapps/common/G/9Kings.exe',
    ].join('\n');
    await identifyGame(1, deps({ env: 'STEAM_COMPAT_DATA_PATH=/lib/steamapps/compatdata/5\0', name: '9Kings.exe', readMaps: async () => maps, hashFile }));
    expect(hashFile).toHaveBeenCalledWith('/lib/steamapps/common/G/9Kings.exe');
  });

  it('userCheatsKey strips tools-', () => {
    expect(userCheatsKey('tools-targetgame')).toBe('targetgame');
    expect(userCheatsKey('x'.repeat(100))).toHaveLength(80);
  });
});
