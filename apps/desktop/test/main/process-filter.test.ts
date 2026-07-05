import { describe, it, expect } from 'vitest';
import { isNoiseProcess, filterCandidates } from '../../src/main/process-host.js';

describe('isNoiseProcess', () => {
  it('flags Wine/Steam infrastructure processes', () => {
    for (const n of ['services.exe', 'winedevice.exe', 'explorer.exe', 'steam.exe', 'xalia.exe', 'svchost.exe', 'rpcss.exe']) {
      expect(isNoiseProcess(n)).toBe(true);
    }
  });
  it('does not flag a real game process', () => {
    expect(isNoiseProcess('9Kings.exe')).toBe(false);
    expect(isNoiseProcess('eldenring.exe')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(isNoiseProcess('SERVICES.EXE')).toBe(true);
  });
});

describe('filterCandidates', () => {
  it('removes infrastructure noise but keeps the game', () => {
    const procs = [
      { pid: 1, name: 'services.exe' },
      { pid: 2, name: 'winedevice.exe' },
      { pid: 3, name: '9Kings.exe' },
      { pid: 4, name: 'steam.exe' },
    ];
    const out = filterCandidates(procs);
    expect(out.map((p) => p.name)).toEqual(['9Kings.exe']);
  });
});
