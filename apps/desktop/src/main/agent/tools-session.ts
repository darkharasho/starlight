// apps/desktop/src/main/agent/tools-session.ts
//
// Session tools. Task 7 ships `list_games`; Task 9 adds attach, detach and game_info.
import { sep } from 'node:path';
import { z } from 'zod';
import type { DetectedProcess } from '../../shared/ipc.js';
import type { AntiCheatHit } from '../anti-cheat.js';
import type { GameIdentity } from '../game-identity.js';
import { isNoiseProcess } from '../process-host.js';
import { EXE_SUFFIX } from '../proc-exe-name.js';
import type { ToolDef } from './tools.js';

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
