import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything needed to relaunch a Windows program (Cheat Engine) inside the
 * same Proton prefix + runtime as a running game, so it sees the game as a
 * native Windows process.
 */
export interface ProtonInfo {
  /** STEAM_COMPAT_DATA_PATH — the game's compatdata dir (holds the wine prefix). */
  compatDataPath: string;
  /** STEAM_COMPAT_CLIENT_INSTALL_PATH — the Steam client install dir. */
  clientInstallPath: string;
  /** Directory containing the `proton` launcher script. */
  protonDir: string;
  /** Full path to the `proton` launcher script. */
  protonBin: string;
}

export interface DetectProtonOpts {
  pid: number;
  /** Injectable for tests. Returns the raw NUL-separated /proc/<pid>/environ. */
  readEnviron?: (pid: number) => Promise<string>;
  /** Injectable for tests. Resolves true if the path is accessible. */
  fileExists?: (p: string) => Promise<boolean>;
}

async function defaultReadEnviron(pid: number): Promise<string> {
  return readFile(`/proc/${pid}/environ`, 'utf8');
}

async function defaultFileExists(p: string): Promise<boolean> {
  try { await access(p, constants.F_OK); return true; }
  catch { return false; }
}

function parseEnviron(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split('\0')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return map;
}

/**
 * Inspects a running process's environment to decide whether it is a
 * Proton/Steam game and, if so, how to launch a Windows binary into the same
 * prefix. Returns null for non-Proton (native) processes.
 */
export async function detectProton(opts: DetectProtonOpts): Promise<ProtonInfo | null> {
  const readEnviron = opts.readEnviron ?? defaultReadEnviron;
  const fileExists = opts.fileExists ?? defaultFileExists;

  let raw: string;
  try { raw = await readEnviron(opts.pid); }
  catch { return null; }

  const env = parseEnviron(raw);
  const compatDataPath = env.get('STEAM_COMPAT_DATA_PATH');
  // A Proton game always has a compatdata path. STEAM_COMPAT_PROTON=1 is a
  // secondary signal but not always present in every layer.
  if (!compatDataPath) return null;

  const clientInstallPath = env.get('STEAM_COMPAT_CLIENT_INSTALL_PATH') ?? '';

  // Find the directory that holds the `proton` launcher. Prefer the explicit
  // tool-paths, fall back to parsing PATH (which contains `<protonDir>/files/bin`).
  const protonDir = await resolveProtonDir(env, fileExists);
  if (!protonDir) return null;

  return {
    compatDataPath,
    clientInstallPath,
    protonDir,
    protonBin: join(protonDir, 'proton'),
  };
}

async function resolveProtonDir(
  env: Map<string, string>,
  fileExists: (p: string) => Promise<boolean>,
): Promise<string | null> {
  const candidates: string[] = [];

  // STEAM_COMPAT_TOOL_PATHS / MOUNTS are ':'-separated dir lists; the proton
  // tool dir is whichever contains a `proton` script.
  for (const key of ['STEAM_COMPAT_TOOL_PATHS', 'STEAM_COMPAT_MOUNTS']) {
    const val = env.get(key);
    if (val) for (const p of val.split(':')) if (p) candidates.push(p);
  }

  // PATH holds `<protonDir>/files/bin` — map back to `<protonDir>`.
  const path = env.get('PATH');
  if (path) {
    for (const p of path.split(':')) {
      const idx = p.indexOf('/files/bin');
      if (idx !== -1) candidates.push(p.slice(0, idx));
    }
  }

  for (const dir of candidates) {
    if (await fileExists(join(dir, 'proton'))) return dir;
  }
  return null;
}
