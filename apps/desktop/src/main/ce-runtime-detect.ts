import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

// Starlight cheats every game with Windows Cheat Engine 7.5: inside the game's
// prefix for Proton games, and connected to ceserver (CE's Linux memory
// server) for native Linux games. Linux CE 7.6.6 isn't used any more: it nags
// for Patreon and stops cheats after a trial period.

/** Where Windows CE is extracted, relative to the runtime root. */
export const WIN_CE_DIR = 'CheatEngineWindows75';
/** Where installs from before 0.3 keep Windows CE (inside the old Linux CE). */
export const LEGACY_WIN_CE_DIR = join('CheatEngineLinux766-4', 'windowsbin');
export const WIN_CE_EXE = 'cheatengine-x86_64.exe';
/** Where ceserver is extracted (the manifest's extractedDir), relative to the runtime root. */
export const CESERVER_DIR = 'ceserver-7.5';
export const CESERVER_BIN = 'ceserver';

export type RuntimePart = 'windows-ce' | 'ceserver';

export interface DetectOpts {
  runtimeRoot: string;
}

export type DetectResult =
  | { status: 'ready'; winCeDir: string; winCeExe: string; ceserver: string }
  | { status: 'not-installed'; missing: RuntimePart[] };

async function canAccess(p: string, mode: number): Promise<boolean> {
  try { await access(p, mode); return true; } catch { return false; }
}

/** The Windows CE directory in use: the current layout first, then the legacy one. */
export async function findWinCeDir(runtimeRoot: string): Promise<string | null> {
  for (const rel of [WIN_CE_DIR, LEGACY_WIN_CE_DIR]) {
    const d = join(runtimeRoot, rel);
    if (await canAccess(join(d, WIN_CE_EXE), constants.F_OK)) return d;
  }
  return null;
}

export async function detectCeRuntime(opts: DetectOpts): Promise<DetectResult> {
  const winCeDir = await findWinCeDir(opts.runtimeRoot);
  const ceserver = join(opts.runtimeRoot, CESERVER_DIR, CESERVER_BIN);
  const hasCeServer = await canAccess(ceserver, constants.X_OK);
  const missing: RuntimePart[] = [];
  if (!winCeDir) missing.push('windows-ce');
  if (!hasCeServer) missing.push('ceserver');
  if (missing.length > 0 || !winCeDir) return { status: 'not-installed', missing };
  return { status: 'ready', winCeDir, winCeExe: join(winCeDir, WIN_CE_EXE), ceserver };
}
