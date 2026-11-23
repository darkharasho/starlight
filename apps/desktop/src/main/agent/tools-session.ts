// apps/desktop/src/main/agent/tools-session.ts
//
// Session tools: list_games, attach, detach and game_info.
import { sep } from 'node:path';
import { z } from 'zod';
import type { DetectedProcess } from '../../shared/ipc.js';
import type { AntiCheatHit } from '../anti-cheat.js';
import type { GameIdentity } from '../game-identity.js';
import { isNoiseProcess } from '../process-host.js';
import { EXE_SUFFIX } from '../proc-exe-name.js';
import type { ModuleInfo, Session } from '@starlight/engine';
import type { AgentClient, ToolDef } from './tools.js';

/** What attach/detach need from the agent session (kept here so tool files don't import session.ts). */
export interface SessionControl {
  attach(pid: number, client: AgentClient, o?: { signal?: AbortSignal }): Promise<{
    pid: number; name: string; proton: boolean; steamAppId: number | null; buildId: string | null; canModify: boolean;
  }>;
  stop(reason: 'agent'): Promise<void>;
}

export const LIST_ALL_CAP = 200;

export interface ListGamesDeps {
  listProcesses(): Promise<DetectedProcess[]>;
  /** The exe paths of the player's manually added games. */
  manualExePaths(): Promise<string[]>;
  /** The install folders of the games the library scan found (folders less than two levels deep are ignored). */
  installDirs(): string[];
  /** `/proc/<pid>/exe`, or null when it can't be read. */
  exePath(pid: number): Promise<string | null>;
  /** Identity without hashing the exe (R6). */
  identify(pid: number): Promise<GameIdentity>;
  detectAntiCheatFn(pid: number): Promise<AntiCheatHit | null>;
  attachedPid(): number | null;
}

export interface ListedGame {
  pid: number;
  name: string;
  proton: boolean | null;
  steamAppId: number | null;
  buildId: string | null;
  antiCheat: string | null;
  attached: boolean;
}

function inside(dir: string, file: string): boolean {
  const d = dir.endsWith(sep) ? dir : dir + sep;
  return file.startsWith(d);
}

const input = {
  all: z.boolean().optional().describe('List every running process, not only games (up to 200, without game details).'),
};

export function listGamesTool(deps: ListGamesDeps): ToolDef<typeof input> {
  return {
    name: 'list_games',
    title: 'List running games',
    description:
      'Lists the games that are running, with their Steam app id, build id and whether anti-cheat is loaded ' +
      '(games with anti-cheat can\'t be attached). Pass all: true if the game you want isn\'t listed.',
    tier: 'open',
    readOnly: true,
    input,
    async run(args) {
      const procs = (await deps.listProcesses()).filter((p) => !isNoiseProcess(p.name));
      const attachedPid = deps.attachedPid();
      const antiCheat = async (pid: number): Promise<string | null> =>
        (await deps.detectAntiCheatFn(pid).catch(() => null))?.name ?? null;

      if (args.all) {
        const games: ListedGame[] = await Promise.all(procs.slice(0, LIST_ALL_CAP).map(async (p) => ({
          pid: p.pid, name: p.name, proton: null, steamAppId: null, buildId: null,
          antiCheat: await antiCheat(p.pid), attached: p.pid === attachedPid,
        })));
        return { games };
      }

      const [manual, dirs] = [new Set(await deps.manualExePaths().catch(() => [])), deps.installDirs().filter((d) => d.split('/').filter(Boolean).length >= 2)];
      const gameLike = await Promise.all(procs.map(async (p) => {
        if (EXE_SUFFIX.test(p.name)) return true;
        if (manual.size === 0 && dirs.length === 0) return false;
        const exe = await deps.exePath(p.pid).catch(() => null);
        if (!exe) return false;
        return manual.has(exe) || dirs.some((d) => inside(d, exe));
      }));

      const games: ListedGame[] = await Promise.all(procs.filter((_, i) => gameLike[i]).map(async (p) => {
        const attached = p.pid === attachedPid;
        const ac = await antiCheat(p.pid);
        try {
          const id = await deps.identify(p.pid);
          return { pid: p.pid, name: id.name, proton: id.proton, steamAppId: id.steamAppId, buildId: id.buildId, antiCheat: ac, attached };
        } catch {
          return { pid: p.pid, name: p.name.replace(/\.exe$/i, ''), proton: null, steamAppId: null, buildId: null, antiCheat: ac, attached };
        }
      }));
      return { games };
    },
    summarize(args, result) {
      const n = (result as { games?: unknown[] } | null)?.games?.length ?? 0;
      return args.all ? `Listed ${n} running process${n === 1 ? '' : 'es'}` : `Found ${n} running game${n === 1 ? '' : 's'}`;
    },
  };
}

const attachInput = {
  pid: z.number().int().positive().describe('The pid from list_games.'),
};

export function attachTool(agent: Pick<SessionControl, 'attach'>): ToolDef<typeof attachInput> {
  return {
    name: 'attach',
    title: 'Attach to a game',
    description:
      'Asks the player to let you attach to a running game (from list_games). This waits until the player answers ' +
      'in Starlight, up to a few minutes. Every other game tool needs an attach the player approved. ' +
      'Games with anti-cheat loaded are refused.',
    tier: 'open',
    readOnly: false,
    input: attachInput,
    async run(args, ctx) {
      // The request's signal: Esc in the agent (notifications/cancelled) or its session ending drops the card.
      const g = await agent.attach(args.pid, ctx.client, ctx.signal ? { signal: ctx.signal } : {});
      return {
        attached: true,
        game: { pid: g.pid, name: g.name, proton: g.proton, steamAppId: g.steamAppId, buildId: g.buildId },
        canModify: g.canModify,
      };
    },
    summarize(_args, result) {
      const name = (result as { game?: { name?: string } } | null)?.game?.name;
      return name ? `Attached to ${name}` : 'Attached';
    },
  };
}

export function detachTool(agent: Pick<SessionControl, 'stop'>): ToolDef<Record<string, never>> {
  return {
    name: 'detach',
    title: 'Detach from the game',
    description: 'Reverts everything you left running in the game (freezes, watches, test cheats, speed) and detaches.',
    tier: 'attached',
    readOnly: false,
    input: {},
    async run() {
      await agent.stop('agent');
      return { detached: true };
    },
    summarize: () => 'Detached',
  };
}

export interface GameInfoDeps {
  listModules(session: Session): Promise<ModuleInfo[]>;
  readMaps(pid: number): Promise<string>;
}

const gameInfoInput = {
  modules_offset: z.number().int().min(0).optional().describe('First module to return (default 0).'),
  modules_limit: z.number().int().min(1).max(200).optional().describe('How many modules to return, 1–200 (default 40).'),
};

const MIB = 1024 * 1024;
const toMiB = (bytes: bigint): number => Math.round((Number(bytes) / MIB) * 10) / 10;

/** Region count, private writable MiB and executable MiB from /proc/<pid>/maps. */
export function summarizeRegions(maps: string): { count: number; writableMiB: number; executableMiB: number } {
  let count = 0;
  let writable = 0n;
  let executable = 0n;
  for (const line of maps.split('\n')) {
    const m = /^([0-9a-f]+)-([0-9a-f]+)\s+([rwxsp-]{4})/i.exec(line.trim());
    if (!m) continue;
    count++;
    const size = BigInt(`0x${m[2]}`) - BigInt(`0x${m[1]}`);
    const perms = m[3]!;
    if (perms[0] === 'r' && perms[1] === 'w' && perms[3] === 'p') writable += size;
    if (perms[2] === 'x') executable += size;
  }
  return { count, writableMiB: toMiB(writable), executableMiB: toMiB(executable) };
}

export function gameInfoTool(deps: GameInfoDeps): ToolDef<typeof gameInfoInput> {
  return {
    name: 'game_info',
    title: 'Game info',
    description:
      'The attached game: name, Steam app id and build id, the exe hash, its modules (paged) and a summary of its memory regions.',
    tier: 'attached',
    readOnly: true,
    input: gameInfoInput,
    async run(args, ctx) {
      const a = ctx.attached!;
      const offset = args.modules_offset ?? 0;
      const limit = args.modules_limit ?? 40;
      const [mods, maps] = await Promise.all([deps.listModules(a.session), deps.readMaps(a.game.pid).catch(() => '')]);
      const g = a.game;
      return {
        pid: g.pid, name: g.name, proton: g.proton, steamAppId: g.steamAppId, buildId: g.buildId, exeHash: g.exeHash,
        modules: {
          count: mods.length,
          items: mods.slice(offset, offset + limit).map((m) => ({ name: m.name, base: m.base, size: m.size, kind: m.kind })),
        },
        regions: summarizeRegions(maps),
      };
    },
    summarize(_args, result) {
      const r = result as { name?: string; modules?: { count?: number } } | null;
      return `Read game info for ${r?.name ?? 'the game'} (${r?.modules?.count ?? 0} modules)`;
    },
  };
}
