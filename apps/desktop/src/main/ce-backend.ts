import { copyFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { DetectResult } from './ce-runtime-detect.js';
import { createBridge } from './ce-bridge.js';
import { generateControlScript } from './ce-control-script.js';
import { spawnCeProcess, type CeProcessHandle, type CeWineLaunch } from './ce-process.js';
import {
  findWineRunner, findSteamRoot, readPtraceScope, startCeServer, hasPtraceCap, NO_WINE_MESSAGE, PTRACE_MESSAGE, PTRACE_LOCKED_MESSAGE,
  type CeServerHandle, type WineRunner,
} from './ce-native.js';
import type { ProtonInfo } from './proton-detect.js';
import type { TableBackend, BackendCommand } from './table-backend.js';

/** Convert a Linux path to the Wine drive-Z form CE understands (Z:\a\b). */
export function toWinePath(linuxPath: string): string {
  return 'Z:' + linuxPath.replace(/\//g, '\\');
}

/**
 * The control script does `require("json")`. The Windows CE runtime ships
 * `lua/json.lua`; a Windows CE that older installs put inside the Linux CE
 * (`…/windowsbin`) may lack it, so copy the Linux CE's next to it.
 */
export async function ensureWinCeJson(winCeDir: string): Promise<void> {
  const dest = join(winCeDir, 'lua', 'json.lua');
  try { await access(dest, constants.F_OK); return; } catch { /* missing — copy it */ }
  await mkdir(join(winCeDir, 'lua'), { recursive: true });
  await copyFile(join(winCeDir, '..', 'lua', 'json.lua'), dest).catch(() => {});
}

/** What launching Cheat Engine for a session needs (the session's own options, resolved). */
export interface CeLaunchOpts {
  runtimeRoot: string;
  pingTimeoutMs?: number | undefined;
  /** Unsolicited messages from Cheat Engine (hotkey presses). */
  onEvent?: ((event: Record<string, unknown>) => void) | undefined;
  findWineRunnerFn?: (() => Promise<WineRunner | null>) | undefined;
  startCeServerFn?: ((opts: { bin: string }) => Promise<CeServerHandle>) | undefined;
  readPtraceScopeFn?: (() => Promise<number>) | undefined;
  hasPtraceCapFn?: ((pid: number) => Promise<boolean>) | undefined;
  /** Whether starlightd lacks CAP_SYS_PTRACE (only asked when ptrace is restricted). */
  engineNeedsPtraceGrantFn?: (() => Promise<boolean>) | undefined;
  /** The installed trainer engine. */
  detect: Extract<DetectResult, { status: 'ready' }>;
  effectivePid: number;
  processName: string | undefined;
  proton: ProtonInfo | null;
  /** The table CE loads at startup (Linux path), or null for none. */
  ctPath: string | null;
  sessionId: string;
  /** `proton run` / `wine` exited: CE is gone. */
  onLauncherExit(): void;
}

export interface CeBackend extends TableBackend {
  kind: 'ce';
  /** Whether the table had finished loading at the first ping. */
  ready: boolean;
  /** True once the launcher (and so Cheat Engine) has exited. */
  launcherExited(): boolean;
}

/**
 * Starts Windows Cheat Engine for the game (inside the game's prefix for a
 * Proton game, or in Starlight's own prefix connected to ceserver for a native
 * one) and waits until its bridge answers.
 */
export async function launchCeBackend(o: CeLaunchOpts): Promise<CeBackend> {
  const { detect, effectivePid, processName, proton, ctPath, sessionId } = o;

  // Every game is cheated by Windows CE: inside the game's prefix for a Proton
  // game, or in Starlight's own prefix connected to ceserver for a native one.
  let runner: WineRunner | null = null;
  let ptraceScope = 0;
  if (!proton) {
    ptraceScope = await (o.readPtraceScopeFn ?? readPtraceScope)();
    if (ptraceScope >= 3) throw new Error(PTRACE_LOCKED_MESSAGE);
    runner = await (o.findWineRunnerFn ?? (async () => findWineRunner({
      prefixRoot: join(o.runtimeRoot, 'prefix'),
      steamRoot: await findSteamRoot(),
    })))();
    if (!runner) throw new Error(NO_WINE_MESSAGE);
  }

  // Short poll: Cheat Engine's Lua runs on its UI thread, so a long-poll would
  // stall its timers (value freezing, scan completion, window hiding) for the
  // whole wait. Quick empty replies keep CE responsive.
  const bridge = await createBridge({ pollTimeoutMs: 25, onEvent: o.onEvent });
  await ensureWinCeJson(detect.winCeDir);

  let ceServer: CeServerHandle | null = null;
  let launch: CeWineLaunch;
  if (proton) {
    launch = {
      command: proton.protonBin,
      args: ['run'],
      env: {
        ...proton.compatEnv,
        STEAM_COMPAT_DATA_PATH: proton.compatDataPath,
        STEAM_COMPAT_CLIENT_INSTALL_PATH: proton.clientInstallPath,
      },
      winCeExe: detect.winCeExe,
      winCeDir: detect.winCeDir,
    };
  } else {
    try {
      ceServer = await (o.startCeServerFn ?? startCeServer)({ bin: detect.ceserver });
      // With ptrace restricted, ceserver can only read the game with
      // CAP_SYS_PTRACE (granted once from the UI).
      // starlightd needs it too: an update that only changed starlightd drops
      // its capability while ceserver keeps its own, so ask then as well.
      if (ptraceScope > 0 && (
        !(ceServer.pid !== undefined && await (o.hasPtraceCapFn ?? hasPtraceCap)(ceServer.pid))
        || await (o.engineNeedsPtraceGrantFn?.() ?? false)
      )) {
        await ceServer.stop();
        throw new Error(PTRACE_MESSAGE);
      }
    } catch (err) {
      await bridge.close().catch(() => {});
      throw err;
    }
    await mkdir(runner!.prefixDir, { recursive: true });
    launch = { command: runner!.command, args: runner!.args, env: runner!.env, winCeExe: detect.winCeExe, winCeDir: detect.winCeDir };
  }

  // The control script loads the table itself (dialogs muted first), from the
  // Wine `Z:\…` path.
  const controlScript = generateControlScript({
    bridgeUrl: bridge.url,
    ctPath: ctPath === null ? undefined : toWinePath(ctPath),
    ...(ceServer
      ? { openProcessPid: effectivePid, ceServer: { host: '127.0.0.1', port: ceServer.port } }
      : { openProcessName: processName }),
  });

  let ceProcess: CeProcessHandle;
  // `proton run` / `wine` keep running for as long as CE does, so an early
  // exit means CE never started: stop waiting for it.
  let launcherExited = false;
  try {
    const raw = await spawnCeProcess({
      launch,
      controlScript,
      sessionId,
      runtimeRoot: o.runtimeRoot,
      onExit: () => {
        launcherExited = true;
        void ceServer?.stop();
        // If this session was active, drop it.
        o.onLauncherExit();
      },
    });
    ceProcess = ceServer
      ? { ...raw, kill: async (signal) => { await raw.kill(signal); await ceServer!.stop(); } }
      : raw;
  } catch (err) {
    await bridge.close().catch(() => {});
    await ceServer?.stop();
    throw err;
  }

  // Windows CE cold-boots under Proton/Wine. The first native session also
  // creates Starlight's prefix, which takes longer still.
  const defaultTimeout = proton ? 45_000 : 90_000;
  const deadline = Date.now() + (o.pingTimeoutMs ?? defaultTimeout);
  let online = false;
  let ready = false;
  while (Date.now() < deadline && !launcherExited) {
    try {
      const pong = await Promise.race([
        bridge.send({ method: 'ping' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timed out')), 500)),
      ]) as { ready?: boolean } | null;
      online = true;
      ready = pong?.ready !== false;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!online) {
    const exitedEarly = launcherExited;   // read before kill() sets it
    await bridge.close().catch(() => {});
    await ceProcess.kill('SIGTERM').catch(() => {});
    throw new Error(exitedEarly
      ? `Cheat Engine closed while starting (${runner?.kind === 'wine' ? 'Wine' : 'Proton'} could not run it).`
      : 'CE process spawned but timed out waiting for ping');
  }

  return {
    kind: 'ce',
    ready,
    launcherExited: () => launcherExited,
    // Windows CE reads files through Wine's Z: drive.
    send: (cmd: BackendCommand) => {
      if (cmd.method === 'load_table') {
        const p = cmd.params as { path?: unknown } | undefined;
        if (p && typeof p.path === 'string') return bridge.send({ method: cmd.method, params: { ...p, path: toWinePath(p.path) } });
      }
      return bridge.send(cmd);
    },
    // Callers send `shutdown` first (it puts the game back); this only stops CE.
    close: async () => {
      try { await bridge.close(); } catch { /* ignore */ }
      try { await ceProcess.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}
