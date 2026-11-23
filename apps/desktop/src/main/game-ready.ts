import { readFile } from 'node:fs/promises';

// A freshly started game needs a moment before a table can find its code.
// Instead of a fixed pause, watch what the game has loaded (/proc/<pid>/maps,
// which lists Proton games' DLLs too) and go as soon as the modules the table
// points at are in and loading has settled.

/** Module names a .CT refers to (`"GameAssembly.dll"+1234`, `aobscanmodule(x,Game.exe,…)`), lower-cased. */
export function referencedModules(ct: string): string[] {
  const found = new Set<string>();
  const name = String.raw`([A-Za-z_][\w.+-]*?\.(?:dll|exe|so(?:\.\d+)*))`;
  // Only where a table uses a module: as an address base ("Game.dll"+1F0, Game.dll+1F0)
  // or as the module of an AOB scan (aobscanmodule(sym, Game.dll, …)).
  const uses = [
    new RegExp(String.raw`"?\b${name}"?\s*\+`, 'gi'),
    new RegExp(String.raw`aobscanmodule\s*\(\s*[^,()]+,\s*"?${name}"?\s*,`, 'gi'),
  ];
  for (const re of uses) for (const m of ct.matchAll(re)) found.add(m[1]!.toLowerCase());
  return [...found];
}

/** File names (lower-cased) of everything mapped into a process. */
export async function mappedModules(pid: number, read = (p: string) => readFile(p, 'utf8')): Promise<Set<string>> {
  const out = new Set<string>();
  for (const line of (await read(`/proc/${pid}/maps`)).split('\n')) {
    // "addr perms offset dev inode   /path/to/file" — the path is the only part with a slash.
    const at = line.indexOf('/');
    if (at < 0) continue;
    const path = line.slice(at).trimEnd();
    out.add(path.slice(path.lastIndexOf('/') + 1).toLowerCase());
  }
  return out;
}

/** How long a process has been running, in ms (null if it can't be read). */
export async function processAgeMs(pid: number, read = (p: string) => readFile(p, 'utf8')): Promise<number | null> {
  try {
    const stat = await read(`/proc/${pid}/stat`);
    // Field 22 (starttime, in clock ticks since boot) comes after the
    // parenthesised command name, which may itself contain spaces.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = Number(fields[19]);
    const uptimeSec = Number((await read('/proc/uptime')).split(' ')[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSec)) return null;
    return Math.max(0, uptimeSec * 1000 - startTicks * 10);   // USER_HZ is 100 on Linux
  } catch {
    return null;
  }
}

export interface WaitForGameOpts {
  pid: number;
  /** Modules the table needs; empty = just wait for loading to settle. */
  modules: string[];
  /** A game running longer than this has long finished loading. */
  settledAfterMs?: number;
  /** Stop waiting once the game is this old, whatever has loaded by then. */
  maxAgeMs?: number;
  /** Ready once nothing new has been mapped for this long. */
  quietMs?: number;
  pollMs?: number;
  ageMs?: (pid: number) => Promise<number | null>;
  modulesOf?: (pid: number) => Promise<Set<string>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type GameReadyReason = 'running' | 'loaded' | 'timeout' | 'gone';

/** Resolves once the game looks loaded enough for a table to find its code. */
export async function waitForGameReady(opts: WaitForGameOpts): Promise<GameReadyReason> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const modulesOf = opts.modulesOf ?? ((pid: number) => mappedModules(pid));
  const quietMs = opts.quietMs ?? 1500;
  const pollMs = opts.pollMs ?? 500;

  const age = await (opts.ageMs ?? processAgeMs)(opts.pid);
  if (age === null || age >= (opts.settledAfterMs ?? 60_000)) return 'running';

  const deadline = now() + Math.max(0, (opts.maxAgeMs ?? 20_000) - age);
  let lastCount = -1;
  let quietSince = now();
  while (now() < deadline) {
    let mods: Set<string>;
    try { mods = await modulesOf(opts.pid); } catch { return 'gone'; }
    if (mods.size !== lastCount) { lastCount = mods.size; quietSince = now(); }
    const hasModules = opts.modules.every((m) => mods.has(m));
    if (hasModules && now() - quietSince >= quietMs) return 'loaded';
    await sleep(pollMs);
  }
  return 'timeout';
}
