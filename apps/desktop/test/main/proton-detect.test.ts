import { describe, it, expect } from 'vitest';
import { detectProton } from '../../src/main/proton-detect.js';

// Real environ captured from a live 9 Kings process under Proton Experimental.
const NUL = '\0';
const PROTON_ENVIRON = [
  'PATH=/var/mnt/data/SteamLibrary/steamapps/common/Proton - Experimental/files/bin/:/usr/bin:/bin',
  'STEAM_COMPAT_CLIENT_INSTALL_PATH=/home/user/.local/share/Steam',
  'STEAM_COMPAT_DATA_PATH=/var/mnt/data/SteamLibrary/steamapps/compatdata/2784470',
  'STEAM_COMPAT_TOOL_PATHS=/var/mnt/data/SteamLibrary/steamapps/common/Proton - Experimental:/var/mnt/data/SteamLibrary/steamapps/common/SteamLinuxRuntime_4',
  'STEAM_COMPAT_PROTON=1',
].join(NUL) + NUL;

const PROTON_DIR = '/var/mnt/data/SteamLibrary/steamapps/common/Proton - Experimental';

describe('detectProton', () => {
  it('returns Proton launch info for a Proton game', async () => {
    const info = await detectProton({
      pid: 1234,
      readEnviron: async () => PROTON_ENVIRON,
      fileExists: async (p) => p === `${PROTON_DIR}/proton`,
    });
    expect(info).not.toBeNull();
    expect(info!.compatDataPath).toBe('/var/mnt/data/SteamLibrary/steamapps/compatdata/2784470');
    expect(info!.clientInstallPath).toBe('/home/user/.local/share/Steam');
    expect(info!.protonDir).toBe(PROTON_DIR);
    expect(info!.protonBin).toBe(`${PROTON_DIR}/proton`);
  });

  it('resolves the proton dir from PATH when tool-paths are absent', async () => {
    const environ = [
      'PATH=/games/Proton 9.0/files/bin/:/usr/bin',
      'STEAM_COMPAT_DATA_PATH=/games/compatdata/42',
      'STEAM_COMPAT_CLIENT_INSTALL_PATH=/steam',
    ].join(NUL);
    const info = await detectProton({
      pid: 1,
      readEnviron: async () => environ,
      fileExists: async (p) => p === '/games/Proton 9.0/proton',
    });
    expect(info!.protonDir).toBe('/games/Proton 9.0');
  });

  it('returns null for a native (non-Proton) process', async () => {
    const info = await detectProton({
      pid: 1,
      readEnviron: async () => 'PATH=/usr/bin\0HOME=/home/user\0',
      fileExists: async () => false,
    });
    expect(info).toBeNull();
  });

  it('returns null when the process environ cannot be read', async () => {
    const info = await detectProton({
      pid: 999999,
      readEnviron: async () => { throw new Error('ESRCH'); },
    });
    expect(info).toBeNull();
  });

  it('returns null when no proton launcher script is found on disk', async () => {
    const info = await detectProton({
      pid: 1,
      readEnviron: async () => PROTON_ENVIRON,
      fileExists: async () => false, // proton script missing
    });
    expect(info).toBeNull();
  });
});
