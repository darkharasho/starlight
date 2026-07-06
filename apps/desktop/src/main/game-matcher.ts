// apps/desktop/src/main/game-matcher.ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DetectedProcess, DetectedGame } from '../shared/ipc.js';
import { detectProton } from './proton-detect.js';
import { EXE_SUFFIX } from './proc-exe-name.js';

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');
}

export interface MatchableGame { id: string; name: string; steamAppId?: number | null }

export interface MatchDeps {
  processes: DetectedProcess[];
  detectedGames: DetectedGame[];
  readExeNames?: (installDir: string) => Promise<string[]>;
  readProtonAppId?: (pid: number) => Promise<number | null>;
}

export type MatchResult = { pid: number; name: string } | null | 'ambiguous';

function uniqueByPid(procs: DetectedProcess[]): DetectedProcess[] {
  const seen = new Set<number>();
  return procs.filter((p) => (seen.has(p.pid) ? false : (seen.add(p.pid), true)));
}

function resolve(hits: DetectedProcess[]): MatchResult {
  const u = uniqueByPid(hits);
  if (u.length === 1) return { pid: u[0]!.pid, name: u[0]!.name };
  if (u.length > 1) return 'ambiguous';
  return null;
}

export async function matchGameToProcess(game: MatchableGame, deps: MatchDeps): Promise<MatchResult> {
  const readExe = deps.readExeNames ?? defaultReadExeNames;
  const readAppId = deps.readProtonAppId ?? defaultReadProtonAppId;
  const gnorm = normalizeName(game.name);

  // The installed game this catalog entry maps to. Matched by Steam id when the
  // catalog carries one, else by normalized name. Its `appId` is the exact Steam
  // app id even when the catalog's steamAppId is null.
  const linked = deps.detectedGames.find((g) =>
    (game.steamAppId != null && g.appId === String(game.steamAppId)) ||
    normalizeName(g.name) === gnorm);

  // Layer 1: Proton compatdata appid. This is the most reliable signal and, via
  // the linked installed game's appId, works even when the catalog has no
  // steamAppId. Restrict to exe-like processes so the Wine/Proton wrapper
  // processes (reaper, proton, pv-adverb, …) that share the same compatdata
  // prefix don't turn a clean match into a false "ambiguous".
  const appId = game.steamAppId ?? (linked?.appId != null ? Number(linked.appId) : null);
  if (appId != null && Number.isFinite(appId)) {
    const hits: DetectedProcess[] = [];
    for (const p of deps.processes) {
      if (!EXE_SUFFIX.test(p.name)) continue;
      if ((await readAppId(p.pid)) === appId) hits.push(p);
    }
    const hit = resolve(hits);
    if (hit) return hit;
  }

  // Layer 2: Steam install-dir exe names (exact even for odd exe names).
  if (linked) {
    const exeNorms = (await readExe(linked.installDir)).map(normalizeName);
    const hit = resolve(deps.processes.filter((p) => exeNorms.includes(normalizeName(p.name))));
    if (hit) return hit;
  }

  // Layer 3: normalized name (min length 3)
  if (gnorm.length >= 3) {
    const hit = resolve(deps.processes.filter((p) => normalizeName(p.name) === gnorm));
    if (hit) return hit;
  }

  return null;
}

export interface CatalogEntry { id: string; name: string; steamAppId: number | null; trainerSource?: string | undefined }

export interface IdentifyDeps {
  catalogIndex: Map<string, CatalogEntry>;
  detectedGames: DetectedGame[];
  readProtonAppId?: (pid: number) => Promise<number | null>;
}

export async function identifyProcess(proc: DetectedProcess, deps: IdentifyDeps): Promise<CatalogEntry | null> {
  const readAppId = deps.readProtonAppId ?? defaultReadProtonAppId;

  const appId = await readAppId(proc.pid);
  if (appId != null) {
    const lib = deps.detectedGames.find((g) => g.appId === String(appId));
    if (lib) {
      const e = deps.catalogIndex.get(normalizeName(lib.name));
      if (e) return e;
    }
    for (const e of deps.catalogIndex.values()) if (e.steamAppId === appId) return e;
  }
  return deps.catalogIndex.get(normalizeName(proc.name)) ?? null;
}

export function buildCatalogIndex(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const idx = new Map<string, CatalogEntry>();
  for (const e of entries) {
    if (!e.trainerSource) continue;
    const key = normalizeName(e.name);
    if (key.length < 3) continue;
    if (!idx.has(key)) idx.set(key, e);
  }
  return idx;
}

async function defaultReadExeNames(installDir: string): Promise<string[]> {
  const out: string[] = [];
  const top = await readdir(installDir, { withFileTypes: true }).catch(() => []);
  for (const e of top) {
    if (e.isFile() && /\.exe$/i.test(e.name)) out.push(e.name);
    else if (e.isDirectory()) {
      const sub = await readdir(join(installDir, e.name)).catch(() => []);
      for (const f of sub) if (/\.exe$/i.test(f)) out.push(f);
    }
  }
  return out;
}

async function defaultReadProtonAppId(pid: number): Promise<number | null> {
  const info = await detectProton({ pid });
  if (!info) return null;
  const m = info.compatDataPath.match(/compatdata\/(\d+)/);
  return m ? Number(m[1]) : null;
}
