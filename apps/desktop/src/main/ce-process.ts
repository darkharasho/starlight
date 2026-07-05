import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * When present, Cheat Engine is launched as a *Windows* program inside the
 * game's Proton prefix (via `proton run`) so it sees the game's Windows modules.
 * Native Linux CE cannot resolve Windows module names for a Proton process.
 */
export interface CeProtonLaunch {
  /** Path to the Proton `proton` launcher script. */
  protonBin: string;
  /** Path to the Windows CE executable (…/windowsbin/cheatengine-x86_64.exe). */
  winCeExe: string;
  /** Directory holding the Windows CE (its autorun/ receives the control script). */
  winCeDir: string;
  /** The CT path in Wine form (e.g. `Z:\home\user\x.ct`). */
  ctWinPath: string;
  /** STEAM_COMPAT_DATA_PATH — the game's compatdata dir. */
  compatDataPath: string;
  /** STEAM_COMPAT_CLIENT_INSTALL_PATH — the Steam client install dir. */
  clientInstallPath: string;
}

export interface CeProcessOpts {
  binaryPath: string;
  installDir: string;
  ctPath: string;
  controlScript: string;
  /** If set, launch Windows CE inside the game's Proton prefix instead of Linux CE. */
  proton?: CeProtonLaunch | undefined;
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

export async function spawnCeProcess(opts: CeProcessOpts): Promise<CeProcessHandle> {
  // The control script goes into the autorun/ of whichever CE we're launching:
  // native Linux CE (installDir) or Windows CE inside the Proton prefix (winCeDir).
  const ceDir = opts.proton ? opts.proton.winCeDir : opts.installDir;
  const autorunDir = join(ceDir, 'autorun');
  await mkdir(autorunDir, { recursive: true });
  const autorunPath = join(autorunDir, AUTORUN_FILENAME);
  await writeFile(autorunPath, opts.controlScript, 'utf8');

  let child: ChildProcess;
  if (opts.proton) {
    // No CT on argv — the control script loads it after muting dialogs.
    child = spawn(
      opts.proton.protonBin,
      ['run', opts.proton.winCeExe],
      {
        cwd: opts.proton.winCeDir,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          STEAM_COMPAT_DATA_PATH: opts.proton.compatDataPath,
          STEAM_COMPAT_CLIENT_INSTALL_PATH: opts.proton.clientInstallPath,
        },
      },
    );
  } else {
    // No CT on argv — the control script loads it after muting dialogs.
    child = spawn(opts.binaryPath, [], {
      cwd: opts.installDir,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
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
      // Under Proton the Windows CE is reparented to the game's wineserver, so
      // killing the `proton run` launcher leaves it running. Kill it directly.
      // (We must NOT kill the wineserver — it's shared with the game.)
      if (opts.proton) await killWineProcess(opts.proton.winCeExe).catch(() => {});
      await exitPromise;
    },
    waitForExit: () => exitPromise,
  };
}

/**
 * Kills the specific Windows CE process without touching the shared wineserver
 * or the game. Matches on the process `comm` (the CE binary name) AND the exe
 * path in the command line, so unrelated processes that merely mention the path
 * are never touched. Retries briefly since the Wine process can still be coming
 * up when the session ends.
 */
export async function killWineProcess(winCeExe: string): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  const basename = winCeExe.split('/').pop() ?? winCeExe;
  for (let attempt = 0; attempt < 4; attempt++) {
    const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
    let killedAny = false;
    await Promise.all(pids.map(async (pid) => {
      try {
        // Linux truncates comm to 15 chars: "cheatengine-x86".
        const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
        if (!comm.startsWith('cheatengine')) return;
        const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
        if (cmdline.includes(basename)) { process.kill(Number(pid), 'SIGKILL'); killedAny = true; }
      } catch { /* process gone or unreadable — ignore */ }
    }));
    if (killedAny) return;
    await new Promise((r) => setTimeout(r, 300));
  }
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
