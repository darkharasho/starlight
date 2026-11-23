// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { referencedModules, mappedModules, processAgeMs, waitForGameReady } from '../../src/main/game-ready.js';

describe('referencedModules', () => {
  it('finds the modules a table uses as address bases and AOB scan targets', () => {
    const ct = `
      <Address>"GameAssembly.dll"+01A2B3C</Address>
      <Address>UnityPlayer.dll+4F0</Address>
      aobscanmodule(INJECT,Game-Win64-Shipping.exe,48 8B 05)
      aobscanmodule( other , "mono-2.0-bdwgc.dll" , 90 90)
      <Description>Works on v1.2m.So read the notes; get it from site.exe</Description>`;
    expect(referencedModules(ct).sort()).toEqual(
      ['game-win64-shipping.exe', 'gameassembly.dll', 'mono-2.0-bdwgc.dll', 'unityplayer.dll']);
  });

  it('finds native libraries too', () => {
    expect(referencedModules('<Address>"libgame.so.1"+40</Address>')).toEqual(['libgame.so.1']);
  });
});

describe('mappedModules / processAgeMs', () => {
  it('lists mapped file names, including paths with spaces', async () => {
    const maps = [
      '7f00-7f01 r-xp 00000000 fd:01 123   /games/My Game/GameAssembly.dll',
      '7f01-7f02 rw-p 00000000 00:00 0     [heap]',
      '7f02-7f03 r--p 00000000 fd:01 124   /usr/lib/libc.so.6',
    ].join('\n');
    expect([...await mappedModules(1, async () => maps)]).toEqual(['gameassembly.dll', 'libc.so.6']);
  });

  it('reads a real process', async () => {
    const child = spawn('sleep', ['5']);
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await mappedModules(child.pid!)).toContain('libc.so.6');
      const age = await processAgeMs(child.pid!);
      expect(age).not.toBeNull();
      expect(age!).toBeLessThan(5000);
    } finally { child.kill(); }
  });
});

describe('waitForGameReady', () => {
  /** A fake clock, and a game whose module list changes over time. */
  function fakeGame(timeline: [number, string[]][], ageAtStart = 1000) {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
      ageMs: async () => ageAtStart,
      modulesOf: async () => new Set([...timeline].reverse().find(([at]) => t >= at)![1]),
      elapsed: () => t,
    };
  }

  it('goes as soon as the table\'s module is in and loading has gone quiet', async () => {
    const g = fakeGame([[0, ['game.exe']], [2000, ['game.exe', 'gameassembly.dll']]]);
    expect(await waitForGameReady({ pid: 1, modules: ['gameassembly.dll'], ...g })).toBe('loaded');
    expect(g.elapsed()).toBe(3500);   // loaded at 2 s, then 1.5 s quiet
  });

  it('just waits for loading to settle when the table names no module', async () => {
    const g = fakeGame([[0, ['a']], [1000, ['a', 'b']]]);
    expect(await waitForGameReady({ pid: 1, modules: [], ...g })).toBe('loaded');
    expect(g.elapsed()).toBe(2500);
  });

  it('does not wait for a game that has been running a while', async () => {
    const g = fakeGame([[0, []]], 5 * 60_000);
    expect(await waitForGameReady({ pid: 1, modules: ['gameassembly.dll'], ...g })).toBe('running');
    expect(g.elapsed()).toBe(0);
  });

  it('gives up once the game is 20 s old even if the module never shows up', async () => {
    const g = fakeGame([[0, ['game.exe']]], 4000);
    expect(await waitForGameReady({ pid: 1, modules: ['never.dll'], ...g })).toBe('timeout');
    expect(g.elapsed()).toBe(16_000);
  });

  it('stops when the game exits', async () => {
    const g = fakeGame([[0, []]]);
    expect(await waitForGameReady({ pid: 1, modules: ['x.dll'], ...g, modulesOf: async () => { throw new Error('ENOENT'); } })).toBe('gone');
  });
});
