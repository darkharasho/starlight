import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CeProcessOpts {
  binaryPath: string;
  installDir: string;
  ctPath: string;
  controlScript: string;
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
  const autorunDir = join(opts.installDir, 'autorun');
  await mkdir(autorunDir, { recursive: true });
  const autorunPath = join(autorunDir, AUTORUN_FILENAME);
  await writeFile(autorunPath, opts.controlScript, 'utf8');

  const child: ChildProcess = spawn(opts.binaryPath, [opts.ctPath], {
    cwd: opts.installDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
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
      await exitPromise;
    },
    waitForExit: () => exitPromise,
  };
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
