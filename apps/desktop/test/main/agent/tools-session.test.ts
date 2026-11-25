// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { attachTool, detachTool, gameInfoTool, listGamesTool, listInstalledGamesTool, type ListGamesDeps } from '../../../src/main/agent/tools-session.js';
import type { AttachedContext, ToolContext } from '../../../src/main/agent/tools.js';
import type { Session } from '@starlight/engine';
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

describe('attach, detach and game_info', () => {
  it('attach returns the game identity', async () => {
    const attach = vi.fn(async () => ({ pid: 11, name: 'Game', proton: true, steamAppId: 123, buildId: '42', canModify: true }));
    const def = attachTool({ attach });
    expect(def.name).toBe('attach');
    expect(def.tier).toBe('open');
    expect(def.readOnly).toBe(false);
    const r = await def.run({ pid: 11 }, ctx);
    expect(attach).toHaveBeenCalledWith(11, ctx.client, {});
    expect(r).toEqual({ attached: true, game: { pid: 11, name: 'Game', proton: true, steamAppId: 123, buildId: '42' }, canModify: true });
    expect(def.summarize({ pid: 11 }, r)).toBe('Attached to Game');
  });

  it("attach passes the request's abort signal, so a cancelled request drops the approval card", async () => {
    const attach = vi.fn(async () => ({ pid: 11, name: 'Game', proton: true, steamAppId: 123, buildId: '42', canModify: true }));
    const ac = new AbortController();
    await attachTool({ attach }).run({ pid: 11 }, { ...ctx, signal: ac.signal });
    expect(attach).toHaveBeenCalledWith(11, ctx.client, { signal: ac.signal });
  });

  it('detach stops the session as the agent', async () => {
    const stop = vi.fn(async () => {});
    const def = detachTool({ stop });
    expect(def.tier).toBe('attached');
    await expect(def.run({}, ctx)).resolves.toEqual({ detached: true });
    expect(stop).toHaveBeenCalledWith('agent');
  });

  it('game_info pages modules and summarizes regions', async () => {
    const session = { pid: 11 } as unknown as Session;
    const attached = {
      gen: 1, session, client: ctx.client, signal: new AbortController().signal,
      game: identity(11, 'Game', { exeHash: 'ff00' }),
      describe: async () => null, track: {} as AttachedContext['track'],
    } satisfies AttachedContext;
    const mods = Array.from({ length: 45 }, (_, i) => ({ name: `m${i}.dll`, base: `0x${(0x10000 * (i + 1)).toString(16)}`, size: '0x1000', path: `/x/m${i}.dll`, kind: 'pe' as const }));
    const listModules = vi.fn(async () => mods);
    const maps = [
      '00400000-00500000 r-xp 00000000 08:01 1 /g/game.exe',            // 1 MiB x
      '00600000-00800000 rw-p 00000000 00:00 0 [heap]',                 // 2 MiB rw private
      '00800000-00880000 rw-s 00000000 00:01 2 /dev/shm/x',             // shared: not counted
      '00900000-00940000 rwxp 00000000 00:00 0',                        // 0.25 MiB rw private + x
      '',
    ].join('\n');
    const readMaps = vi.fn(async () => maps);
    const def = gameInfoTool({ listModules, readMaps });
    expect(def.tier).toBe('attached');
    expect(def.readOnly).toBe(true);
    const c: ToolContext = { ...ctx, attached };

    const first = await def.run({}, c) as { modules: { count: number; items: Array<{ name: string }> } };
    expect(first).toEqual({
      pid: 11, name: 'Game', proton: true, steamAppId: 123, buildId: '42', exeHash: 'ff00',
      modules: { count: 45, items: mods.slice(0, 40).map(({ name, base, size, kind }) => ({ name, base, size, kind })) },
      regions: { count: 4, writableMiB: 2.3, executableMiB: 1.3 },
    });
    expect(readMaps).toHaveBeenCalledWith(11);
    expect(listModules).toHaveBeenCalledWith(session);

    const page = await def.run({ modules_offset: 40, modules_limit: 10 }, c) as { modules: { count: number; items: Array<{ name: string }> } };
    expect(page.modules.count).toBe(45);
    expect(page.modules.items.map((m) => m.name)).toEqual(['m40.dll', 'm41.dll', 'm42.dll', 'm43.dll', 'm44.dll']);
  });
});

describe('list_installed_games', () => {
  const installed = [
    { source: 'steam' as const, appId: '440', name: 'Team Fortress 2', installDir: '/s/tf2' },
    { source: 'steam' as const, appId: '999', name: 'Zebra Quest', installDir: '/s/zq' },
    { source: 'manual' as const, appId: 'm1', name: 'Hand Added', installDir: '/m/ha', boxartSteamAppId: 777 },
    { source: 'heroic' as const, appId: 'h1', name: 'Apple Farm: Deluxe', installDir: '/h/af' },
  ];
  const catalog = [
    { name: 'Team Fortress 2 v1.0 CT', steamAppId: 440 },
    { name: 'Some Other Title', steamAppId: 777 },
    { name: 'Apple Farm Deluxe', steamAppId: null },
  ];
  const tool = (o: Partial<Parameters<typeof listInstalledGamesTool>[0]> = {}) => listInstalledGamesTool({
    installedGames: async () => installed,
    catalog: async () => catalog,
    ...o,
  });

  it('is an open, read-only tool that lists installed games sorted by name with trainer status', async () => {
    const def = tool();
    expect(def.name).toBe('list_installed_games');
    expect(def.tier).toBe('open');
    expect(def.readOnly).toBe(true);
    const r = await def.run({}, ctx);
    expect(r).toEqual({
      total: 4, installed: 4, withTrainer: 3,
      games: [
        { name: 'Apple Farm: Deluxe', source: 'heroic', steamAppId: null, hasTrainer: true },
        { name: 'Hand Added', source: 'manual', steamAppId: 777, hasTrainer: true },
        { name: 'Team Fortress 2', source: 'steam', steamAppId: 440, hasTrainer: true },
        { name: 'Zebra Quest', source: 'steam', steamAppId: 999, hasTrainer: false },
      ],
    });
  });

  it('trainer "without" and "with" filter the list', async () => {
    const without = await tool().run({ trainer: 'without' }, ctx) as { total: number; games: Array<{ name: string }> };
    expect(without.total).toBe(1);
    expect(without.games.map((g) => g.name)).toEqual(['Zebra Quest']);
    const withT = await tool().run({ trainer: 'with' }, ctx) as { total: number };
    expect(withT.total).toBe(3);
  });

  it('pages with limit and offset', async () => {
    const r = await tool().run({ limit: 2, offset: 1 }, ctx) as { total: number; games: Array<{ name: string }> };
    expect(r.total).toBe(4);
    expect(r.games.map((g) => g.name)).toEqual(['Hand Added', 'Team Fortress 2']);
  });

  it('refuses when the catalog can\'t be loaded instead of calling every game trainer-less', async () => {
    await expect(tool({ catalog: async () => { throw new Error('offline'); } }).run({}, ctx)).rejects.toThrow(/catalog isn't loaded/);
    await expect(tool({ catalog: async () => null }).run({}, ctx)).rejects.toThrow(/catalog isn't loaded/);
  });

  it('summarizes with the filter', async () => {
    const def = tool();
    expect(def.summarize!({ trainer: 'without' }, { total: 1 })).toBe('Found 1 installed game without a trainer');
    expect(def.summarize!({}, { total: 4 })).toBe('Found 4 installed games');
  });
});
