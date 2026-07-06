import { describe, it, expect } from 'vitest';
import { exeNameFromCmdline } from '../../src/main/proc-exe-name.js';

const NUL = '\0';

describe('exeNameFromCmdline', () => {
  it('recovers the full exe name from a Windows-style Proton argv[0]', () => {
    // Real Dragonwilds cmdline; comm truncated to 15 chars.
    const cmdline = `S:\\common\\RSDragonwilds\\RSDragonwilds.exe${NUL}`;
    expect(exeNameFromCmdline(cmdline, 'RSDragonwilds.e')).toBe('RSDragonwilds.exe');
  });

  it('handles a short exe whose comm was not truncated', () => {
    expect(exeNameFromCmdline(`Z:\\games\\9Kings.exe${NUL}`, '9Kings.exe')).toBe('9Kings.exe');
  });

  it('picks the token matching comm when argv has several exes', () => {
    const cmdline = [
      'c:\\windows\\system32\\steam.exe',
      '/var/mnt/data/SteamLibrary/steamapps/common/RSDragonwilds/RSDragonwilds.exe',
    ].join(NUL) + NUL;
    expect(exeNameFromCmdline(cmdline, 'RSDragonwilds.e')).toBe('RSDragonwilds.exe');
  });

  it('falls back to the last exe token when comm does not match any', () => {
    const cmdline = `wine${NUL}C:\\games\\Game.exe${NUL}--flag${NUL}`;
    expect(exeNameFromCmdline(cmdline)).toBe('Game.exe');
  });

  it('handles a Unix path exe', () => {
    expect(exeNameFromCmdline(`/opt/games/Foo.exe${NUL}`, 'Foo.exe')).toBe('Foo.exe');
  });

  it('returns null when there is no exe token', () => {
    expect(exeNameFromCmdline(`/usr/bin/python3${NUL}launcher.py${NUL}`)).toBeNull();
  });

  it('returns null for empty cmdline', () => {
    expect(exeNameFromCmdline('')).toBeNull();
  });
});
