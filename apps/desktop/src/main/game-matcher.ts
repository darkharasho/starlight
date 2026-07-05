// apps/desktop/src/main/game-matcher.ts
import type { DetectedProcess, DetectedGame } from '../shared/ipc.js';

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

  // Layer 1: Steam install-dir exe names (exact even for odd exe names)
  const linked = deps.detectedGames.find((g) =>
    (game.steamAppId != null && g.appId === String(game.steamAppId)) ||
    normalizeName(g.name) === gnorm);
  if (linked) {
    const exeNorms = (await readExe(linked.installDir)).map(normalizeName);
    const hit = resolve(deps.processes.filter((p) => exeNorms.includes(normalizeName(p.name))));
    if (hit) return hit;
  }

  // Layer 2: Proton compatdata appid
  if (game.steamAppId != null) {
    const hits: DetectedProcess[] = [];
    for (const p of deps.processes) {
      if ((await readAppId(p.pid)) === game.steamAppId) hits.push(p);
    }
    const hit = resolve(hits);
    if (hit) return hit;
  }

  // Layer 3: normalized name (min length 3)
  if (gnorm.length >= 3) {
    const hit = resolve(deps.processes.filter((p) => normalizeName(p.name) === gnorm));
    if (hit) return hit;
  }

  return null;
}

// Default signal readers (Task 2 fills these in). Placeholders throw so tests
// that forget to inject a reader fail loudly rather than hit the real system.
async function defaultReadExeNames(_installDir: string): Promise<string[]> { return []; }
async function defaultReadProtonAppId(_pid: number): Promise<number | null> { return null; }
