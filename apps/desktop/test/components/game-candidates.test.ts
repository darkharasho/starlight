import { describe, it, expect } from 'vitest';
import { gameCandidates } from '../../src/renderer/routes/ActiveTrainerRoute.js';

describe('gameCandidates', () => {
  it('prefers .exe (Proton/Windows) processes, sorted by name', () => {
    const out = gameCandidates([
      { pid: 1, name: 'zProc' },
      { pid: 2, name: 'Game.exe' },
      { pid: 3, name: 'Another.exe' },
    ]);
    expect(out.map((p) => p.name)).toEqual(['Another.exe', 'Game.exe']);
  });

  it('falls back to all processes when none are .exe', () => {
    const out = gameCandidates([
      { pid: 1, name: 'bravo' },
      { pid: 2, name: 'alpha' },
    ]);
    expect(out.map((p) => p.name)).toEqual(['alpha', 'bravo']);
  });
});
