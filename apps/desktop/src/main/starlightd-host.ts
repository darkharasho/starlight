import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startEngine, type EngineClient, type StartedEngine } from '@starlight/engine';

export function bundledBinaryPath(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'starlightd')
    : resolve(opts.appPath, '../../packages/starlightd/target/release/starlightd');
}

async function sha256(path: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
  catch { return null; }
}

/**
 * Copies the bundled daemon to <runtimeRoot>/starlightd/starlightd (setcap can't
 * mark files on the AppImage's read-only squashfs). Only copies when the content
 * differs: replacing the file drops its ptrace capability.
 */
export async function installDaemon(opts: { bundled: string; runtimeRoot: string }): Promise<{ path: string; changed: boolean }> {
  const dir = join(opts.runtimeRoot, 'starlightd');
  const path = join(dir, 'starlightd');
  const [want, have] = await Promise.all([sha256(opts.bundled), sha256(path)]);
  if (want === null) throw new Error(`Bundled starlightd not found at ${opts.bundled}`);
  if (want === have) return { path, changed: false };
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await copyFile(opts.bundled, tmp);
    await chmod(tmp, 0o755);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { path, changed: true };
}

export function socketPath(env: NodeJS.ProcessEnv = process.env, uid: number = process.getuid!()): string {
  const dir = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, 'starlight')
    : join(tmpdir(), `starlight-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'starlightd.sock');
}

interface HostConfig {
  runtimeRoot: string;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  start: typeof startEngine;
}

let config: HostConfig | null = null;
let installed: Promise<string> | null = null;
let running: StartedEngine | null = null;
let starting: Promise<EngineClient> | null = null;

export function configureStarlightdHost(opts: Omit<HostConfig, 'start'> & { start?: typeof startEngine }): void {
  config = { ...opts, start: opts.start ?? startEngine };
  installed = null;
  running = null;
  starting = null;
}

function cfg(): HostConfig {
  if (!config) throw new Error('starlightd host is not configured');
  return config;
}

export function installedDaemonPath(): Promise<string> {
  const c = cfg();
  installed ??= installDaemon({ bundled: bundledBinaryPath(c), runtimeRoot: c.runtimeRoot })
    .then((r) => r.path)
    .catch((err) => { installed = null; throw err; });
  return installed;
}

export async function getEngineClient(): Promise<EngineClient> {
  if (running && !running.client.closed) return running.client;
  starting ??= (async () => {
    try {
      const c = cfg();
      const binary = await installedDaemonPath();
      const engine = await c.start({ binary, socketPath: socketPath() });
      running = engine;
      engine.client.onClose(() => { if (running === engine) running = null; });
      return engine.client;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

export async function stopEngine(): Promise<void> {
  if (starting) await starting.catch(() => undefined);
  const engine = running;
  running = null;
  if (engine) await engine.stop().catch(() => undefined);
}

/** After a ptrace grant: the running daemon predates the capability, so start a fresh one. */
export async function restartEngine(): Promise<void> {
  await stopEngine();
}

