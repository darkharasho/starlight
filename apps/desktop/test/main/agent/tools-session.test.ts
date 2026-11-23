// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { listGamesTool, type ListGamesDeps } from '../../../src/main/agent/tools-session.js';
import type { ToolContext } from '../../../src/main/agent/tools.js';
import type { GameIdentity } from '../../../src/main/game-identity.js';

const ctx: ToolContext = {
  mcpSessionId: 's1',
  client: { mcpSessionId: 's1', name: 'claude-code', version: '1', label: 'Claude' },
  attached: null,
};

function identity(pid: number, name: string, o: Partial<GameIdentity> = {}): GameIdentity {
  return {
    pid, name, key: name.toLowerCase(), exeName: `${name}.exe`, proton: true,
    steamAppId: 123, buildId: '42', exeHash: null, catalogId: null, ...o,
  };
}

function deps(o: Partial<ListGamesDeps> = {}): ListGamesDeps {
  return {
    listProcesses: async () => [
      { pid: 10, name: 'bash' },
      { pid: 11, name: 'Game.exe' },
      { pid: 12, name: 'steamwebhelper.exe' },
      { pid: 13, name: 'native-game' },
      { pid: 14, name: 'Other.exe' },
    ],
    manualExePaths: async () => [],
    installDirs: () => [],
    exePath: async (pid) => (pid === 13 ? '/opt/native/native-game' : `/usr/bin/p${pid}`),
    identify: async (pid) => identity(pid, pid === 11 ? 'Game' : pid === 13 ? 'Native Game' : 'Other', pid === 13 ? { proton: false, steamAppId: null, buildId: null } : {}),
    detectAntiCheatFn: async (pid) => (pid === 14 ? { name: 'Easy Anti-Cheat', module: 'easyanticheat_x64.dll' } : null),
    attachedPid: () => 11,
    ...o,
  };
}

describe('list_games', () => {
  it('list_games returns game-like processes with identity and anti-cheat status', async () => {
    const def = listGamesTool(deps());
    expect(def.name).toBe('list_games');
    expect(def.tier).toBe('open');
    expect(def.readOnly).toBe(true);
    const r = await def.run({}, ctx) as { games: unknown[] };
    expect(r.games).toEqual([
      { pid: 11, name: 'Game', proton: true, steamAppId: 123, buildId: '42', antiCheat: null, attached: true },
      { pid: 14, name: 'Other', proton: true, steamAppId: 123, buildId: '42', antiCheat: 'Easy Anti-Cheat', attached: false },
    ]);
  });

  it('a manual game\'s native exe counts as a game', async () => {
    const identify = vi.fn(deps().identify);
    const def = listGamesTool(deps({ manualExePaths: async () => ['/opt/native/native-game'], identify }));
    const r = await def.run({}, ctx) as { games: Array<{ pid: number; name: string }> };
    expect(r.games.map((g) => g.pid)).toEqual([11, 13, 14]);
    expect(r.games[1]).toMatchObject({ pid: 13, name: 'Native Game', proton: false, steamAppId: null });
    expect(identify).not.toHaveBeenCalledWith(10);
  });

  it('a native exe inside an installed game\'s folder counts as a game', async () => {
    const def = listGamesTool(deps({ installDirs: () => ['/opt/native'] }));
    const r = await def.run({}, ctx) as { games: Array<{ pid: number }> };
    expect(r.games.map((g) => g.pid)).toEqual([11, 13, 14]);
  });

  it('all:true lists every process without identity', async () => {
    const identify = vi.fn(deps().identify);
    const def = listGamesTool(deps({ identify }));
    const r = await def.run({ all: true }, ctx) as { games: unknown[] };
    expect(identify).not.toHaveBeenCalled();
    expect(r.games).toEqual([
      { pid: 10, name: 'bash', proton: null, steamAppId: null, buildId: null, antiCheat: null, attached: false },
      { pid: 11, name: 'Game.exe', proton: null, steamAppId: null, buildId: null, antiCheat: null, attached: true },
      { pid: 13, name: 'native-game', proton: null, steamAppId: null, buildId: null, antiCheat: null, attached: false },
      { pid: 14, name: 'Other.exe', proton: null, steamAppId: null, buildId: null, antiCheat: 'Easy Anti-Cheat', attached: false },
    ]);
  });

  it('all:true stops at 200 processes', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ pid: 1000 + i, name: `p${i}` }));
    const def = listGamesTool(deps({ listProcesses: async () => many }));
    const r = await def.run({ all: true }, ctx) as { games: unknown[] };
    expect(r.games).toHaveLength(200);
  });

  it('a process that can\'t be identified is still listed by its name', async () => {
    const def = listGamesTool(deps({ identify: async () => { throw new Error('gone'); } }));
    const r = await def.run({}, ctx) as { games: unknown[] };
    expect(r.games[0]).toEqual({ pid: 11, name: 'Game', proton: null, steamAppId: null, buildId: null, antiCheat: null, attached: true });
  });
});
