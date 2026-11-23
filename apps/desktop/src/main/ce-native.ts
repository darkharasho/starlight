import { spawn } from 'node:child_process';
import { access, constants, readdir, readFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseVdf } from './vdf.js';

// Native Linux games are cheated by Windows CE 7.5 running in Starlight's own
// Wine prefix, connected to ceserver (Cheat Engine's Linux memory server),
// which reads and writes the game's memory. This file finds something to run
// Windows CE with and manages ceserver.

/** How to start a Windows program in Starlight's own prefix. */
export interface WineRunner {
  kind: 'proton' | 'wine';
  /** The program to run; Windows CE's path is appended to `args`. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The prefix (or Proton compat data) directory; must exist before launching. */
  prefixDir: string;
}

export const NO_WINE_MESSAGE =
  'Native Linux games need Proton or Wine to run Cheat Engine. Install Proton from Steam (any version), or install Wine.';

export const PTRACE_MESSAGE =
  'Linux is blocking Starlight from reading other programs\' memory (ptrace_scope is on). '
  + 'Run "sudo sysctl kernel.yama.ptrace_scope=0" and try again (it resets on reboot).';

async function exists(p: string): Promise<boolean> {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * The Steam install whose Proton can run Windows CE. Not Flatpak Steam: its
 * Proton needs the Flatpak sandbox.
 */
export async function findSteamRoot(home = homedir()): Promise<string | null> {
  for (const c of [join(home, '.steam', 'steam'), join(home, '.local', 'share', 'Steam')]) {
    if (await exists(join(c, 'steamapps'))) return c;
  }
  return null;
}

/** Steam library folders (each holds steamapps/), the Steam root first. */
async function steamLibraries(steamRoot: string): Promise<string[]> {
  const libs = [steamRoot];
  try {
    const lf = parseVdf(await readFile(join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const folders = lf['libraryfolders'];
    if (folders && typeof folders === 'object') {
      for (const v of Object.values(folders)) {
        const path = typeof v === 'object' && v ? (v as Record<string, unknown>)['path'] : undefined;
        if (typeof path === 'string' && !libs.includes(path)) libs.push(path);
      }
    }
  } catch { /* no library list: just the root */ }
  return libs;
}

/**
 * Orders Proton builds best first: the newest numbered release, then
 * Experimental, then anything else (hotfix, betas).
 */
export function rankProtonDirs(names: string[]): string[] {
  const version = (n: string): number[] | null => {
    const m = /^Proton (\d+)\.(\d+)(?:-(\d+))?$/.exec(n);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  };
  const rank = (n: string): number => (version(n) ? 0 : n === 'Proton - Experimental' ? 1 : 2);
  return [...names].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const va = version(a);
    const vb = version(b);
    if (va && vb) {
      for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i]! - va[i]!;
    }
    return a.localeCompare(b);
  });
}

/** The best installed Proton's `proton` script, or null. */
export async function findProton(steamRoot: string): Promise<string | null> {
  const found: { name: string; bin: string }[] = [];
  for (const lib of await steamLibraries(steamRoot)) {
    const common = join(lib, 'steamapps', 'common');
    const names = await readdir(common).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.startsWith('Proton')) continue;
      const bin = join(common, name, 'proton');
      if (await exists(bin)) found.push({ name, bin });
    }
  }
  const best = rankProtonDirs(found.map((f) => f.name))[0];
  return best ? found.find((f) => f.name === best)!.bin : null;
}

async function onPath(cmd: string): Promise<string | null> {
  for (const d of (process.env['PATH'] ?? '').split(':')) {
    if (!d) continue;
    const p = join(d, cmd);
    try { await access(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

export interface FindWineRunnerOpts {
  /** Directory for Starlight's own prefix (created on first use). */
  prefixRoot: string;
  steamRoot: string | null;
  findProtonFn?: (steamRoot: string) => Promise<string | null>;
  which?: (cmd: string) => Promise<string | null>;
}

/**
 * Proton from Steam when there is one (it sets up a prefix without asking
 * anything), else the system's Wine. Null when neither is installed.
 */
export async function findWineRunner(opts: FindWineRunnerOpts): Promise<WineRunner | null> {
  const proton = opts.steamRoot ? await (opts.findProtonFn ?? findProton)(opts.steamRoot) : null;
  if (proton && opts.steamRoot) {
    const prefixDir = join(opts.prefixRoot, 'proton');
    return {
      prefixDir,
      kind: 'proton',
      command: proton,
      args: ['run'],
      env: {
        STEAM_COMPAT_DATA_PATH: prefixDir,
        STEAM_COMPAT_CLIENT_INSTALL_PATH: opts.steamRoot,
      },
    };
  }
  const wine = await (opts.which ?? onPath)('wine');
  if (wine) {
    const prefixDir = join(opts.prefixRoot, 'wine');
    return {
      prefixDir,
      kind: 'wine',
      command: wine,
      args: [],
      env: {
        WINEPREFIX: prefixDir,
        // A new prefix would otherwise offer to install Wine Mono and Gecko.
        WINEDLLOVERRIDES: 'mscoree,mshtml=',
        WINEDEBUG: '-all',
      },
    };
  }
  return null;
}

/** kernel.yama.ptrace_scope, or 0 when the kernel has no Yama. */
export async function readPtraceScope(): Promise<number> {
  try {
    return Number((await readFile('/proc/sys/kernel/yama/ptrace_scope', 'utf8')).trim()) || 0;
  } catch {
    return 0;
  }
}

export interface CeServerHandle {
  port: number;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * Starts ceserver on a free localhost port and waits until it accepts
 * connections. Starlight's build only listens on 127.0.0.1.
 */
export async function startCeServer(opts: { bin: string; readyTimeoutMs?: number }): Promise<CeServerHandle> {
  const port = await freePort();
  // Run from its own directory: it loads its extension from there.
  const child = spawn(opts.bin, ['-p', String(port)], {
    cwd: dirname(opts.bin),
    stdio: 'ignore',
    detached: false,
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });
  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 2000);
    await exit;
    clearTimeout(timer);
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 5000);
  while (Date.now() < deadline && !exited) {
    if (await canConnect(port)) return { port, stop };
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop();
  throw new Error(exited ? 'ceserver exited during startup' : 'ceserver did not start listening');
}
