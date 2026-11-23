import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How to start Windows Cheat Engine: through the game's own Proton (`proton
 * run`, inside the game's prefix) for Proton games, or through Starlight's own
 * Proton/Wine prefix for native Linux games (CE then talks to ceserver).
 */
export interface CeWineLaunch {
  /** The launcher (`proton` or `wine`); `args` and then the CE exe follow it. */
  command: string;
  args: string[];
  /** Added to the environment (Steam compat settings, WINEPREFIX…). */
  env: Record<string, string>;
  /** Path to the Windows CE executable. */
  winCeExe: string;
  /** Directory holding Windows CE (its autorun/ receives the control script). */
  winCeDir: string;
}

export interface CeProcessOpts {
  launch: CeWineLaunch;
  controlScript: string;
  /** Tags the CE process so only this session's CE is ever killed. */
  sessionId: string;
  /** The runtime root, tagged too so a later run can reap orphans. */
  runtimeRoot: string;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
}

export interface CeProcessHandle {
  pid: number;
  kill: (signal?: NodeJS.Signals) => Promise<void>;
  /** Resolves when the child exits, regardless of how. */
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const AUTORUN_FILENAME = 'zzz-starlight.lua';
/** Environment tags on every CE Starlight starts (Wine passes them on to CE). */
export const SESSION_TAG = 'STARLIGHT_CE_SESSION';
export const ROOT_TAG = 'STARLIGHT_CE_ROOT';

export async function spawnCeProcess(opts: CeProcessOpts): Promise<CeProcessHandle> {
  const { launch } = opts;
  const autorunDir = join(launch.winCeDir, 'autorun');
  await mkdir(autorunDir, { recursive: true });
  const autorunPath = join(autorunDir, AUTORUN_FILENAME);
  await writeFile(autorunPath, opts.controlScript, 'utf8');

  // No CT on argv: the control script loads it after muting dialogs.
  const child: ChildProcess = spawn(launch.command, [...launch.args, launch.winCeExe], {
    cwd: launch.winCeDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...launch.env, [SESSION_TAG]: opts.sessionId, [ROOT_TAG]: opts.runtimeRoot },
  });
  if (!child.pid) throw new Error('CE failed to spawn (no pid)');

  if (opts.onStdoutLine) hookLines(child.stdout, opts.onStdoutLine);
  if (opts.onStderrLine) hookLines(child.stderr, opts.onStderrLine);

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      void rm(autorunPath, { force: true }).catch(() => {});
      opts.onExit?.(code, signal);
      resolve({ code, signal });
    });
  });

  return {
    pid: child.pid,
    kill: async (signal = 'SIGTERM') => {
      if (child.exitCode === null) child.kill(signal);
      // Wine reparents CE to the prefix's wineserver, so killing the launcher
      // leaves it running. Kill it directly. (Never the wineserver: for a
      // Proton game it's shared with the game.)
      await killWineProcess(opts.sessionId).catch(() => {});
      await exitPromise;
    },
    waitForExit: () => exitPromise,
  };
}

function hasTag(environ: string, name: string, value: string): boolean {
  return environ.split('\0').includes(`${name}=${value}`);
}

/**
 * Kills the Cheat Engine started for one session, found by its session tag,
 * without touching the wineserver, the game, or any other CE. Retries briefly
 * since the Wine process can still be coming up when the session ends.
 */
export async function killWineProcess(sessionId: string): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  for (let attempt = 0; attempt < 4; attempt++) {
    const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
    let killedAny = false;
    await Promise.all(pids.map(async (pid) => {
      try {
        // Linux truncates comm to 15 chars: "cheatengine-x86".
        const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
        if (!comm.startsWith('cheatengine')) return;
        const environ = await readFile(`/proc/${pid}/environ`, 'utf8');
        if (hasTag(environ, SESSION_TAG, sessionId)) { process.kill(Number(pid), 'SIGKILL'); killedAny = true; }
      } catch { /* process gone or unreadable — ignore */ }
    }));
    if (killedAny) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Kills any orphaned Cheat Engine and ceserver processes left behind by a
 * previous run that exited without cleaning up (e.g. a crash, which bypasses
 * the before-quit handler). Matches only processes Starlight started: tagged
 * with this runtime root, or whose command line is inside it. Cheat Engine the
 * user launched themselves is never touched. Safe to call on startup.
 */
export async function killStaleCeProcesses(runtimeRoot: string): Promise<number> {
  const { readdir, readFile } = await import('node:fs/promises');
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  let killed = 0;
  await Promise.all(pids.map(async (pid) => {
    try {
      const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      if (!comm.startsWith('cheatengine') && comm !== 'ceserver') return;
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      const environ = comm === 'ceserver' ? '' : await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
      if (cmdline.includes(runtimeRoot) || hasTag(environ, ROOT_TAG, runtimeRoot)) {
        process.kill(Number(pid), 'SIGKILL');
        killed++;
      }
    } catch { /* process gone or unreadable — ignore */ }
  }));
  return killed;
}

function hookLines(stream: NodeJS.ReadableStream | null | undefined, cb: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      cb(line);
      idx = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => { if (buffer.length > 0) cb(buffer); });
}
