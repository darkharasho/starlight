/**
 * The trainer catalog is auto-generated from many forum threads, so the same
 * game shows up under several title variants ("7 Days To Die" / "7 Days to
 * Die", "A Plague Tale Innocence" / "A Plague Tale: Innocence"). This collapses
 * each set of variants to a single, best-titled entry for display.
 */

import { JUNK, gameKey } from '../../shared/game-key.js';

export { gameKey };

export interface DedupableGame {
  name: string;
  steamAppId?: number | null | undefined;
  trainerUpdatedAt?: string | undefined;
  trainerPath?: string | undefined;
  trainerSource?: string | undefined;
}

/** The forum topic number of a thread URL — higher is a newer thread. */
function topicId(g: DedupableGame): number {
  const m = g.trainerSource ? /[?&]t=(\d+)/.exec(g.trainerSource) : null;
  return m ? Number(m[1]) : 0;
}

/** Higher = a cleaner, more canonical-looking title. */
export function nameScore(name: string): number {
  let s = 0;
  for (const re of JUNK) if (re.test(name)) s -= 5;
  if (/[:'’]/.test(name)) s += 2;                        // proper title punctuation
  if (/[a-z]/.test(name) && /[A-Z]/.test(name)) s += 1;  // mixed case (not ALLCAPS/alllower)
  return s;
}

/** True if `a` is a better representative of the group than `b`. */
function isBetter(a: DedupableGame, b: DedupableGame): boolean {
  const ida = a.steamAppId != null, idb = b.steamAppId != null;
  if (ida !== idb) return ida;                           // a Steam-matched entry has Steam's name and art
  const sa = nameScore(a.name), sb = nameScore(b.name);
  if (sa !== sb) return sa > sb;
  const ta = a.trainerUpdatedAt ?? '', tb = b.trainerUpdatedAt ?? '';
  if (ta !== tb) return ta > tb;                         // prefer the more recent trainer
  if (!!a.trainerPath !== !!b.trainerPath) return !!a.trainerPath;  // prefer a pre-built static trainer
  const pa = topicId(a), pb = topicId(b);
  if (pa !== pb) return pa > pb;                         // prefer the newer thread
  return false;                                          // otherwise keep the earlier one (stable)
}

/**
 * Group key for each game: its Steam app id when it has one, else its name
 * key — except a name key some Steam-matched entry also has, which joins that
 * entry's group (an unmatched variant of a matched game).
 */
export function groupKeys(games: readonly DedupableGame[]): string[] {
  const steamByName = new Map<string, string>();
  for (const g of games) {
    if (g.steamAppId == null) continue;
    const k = gameKey(g.name);
    if (k && !steamByName.has(k)) steamByName.set(k, `steam:${g.steamAppId}`);
  }
  return games.map((g, i) => {
    if (g.steamAppId != null) return `steam:${g.steamAppId}`;
    // Names that normalize to nothing (pure punctuation) can't be grouped —
    // keep each as-is under a unique key.
    const k = gameKey(g.name);
    return k ? (steamByName.get(k) ?? k) : `__raw__${i}`;
  });
}

/**
 * Collapses duplicates — the same Steam app, or title variants of one name —
 * to one entry each, keeping the best variant per group and preserving
 * first-appearance order.
 */
export function dedupeGames<T extends DedupableGame>(games: T[]): T[] {
  return dedupeGamesWithSources(games).games;
}

/**
 * dedupeGames, plus every thread URL known for each kept entry (its own
 * first), keyed by the kept entry's id-or-name key (see `sourcesKey`).
 */
export function dedupeGamesWithSources<T extends DedupableGame>(games: T[]): { games: T[]; sources: Map<string, string[]> } {
  const keys = groupKeys(games);
  const best = new Map<string, T>();
  const urls = new Map<string, string[]>();
  const order: string[] = [];
  games.forEach((g, i) => {
    const key = keys[i]!;
    const cur = best.get(key);
    if (cur === undefined) { best.set(key, g); order.push(key); }
    else if (isBetter(g, cur)) best.set(key, g);
    if (g.trainerSource) {
      const list = urls.get(key) ?? [];
      if (!list.includes(g.trainerSource)) list.push(g.trainerSource);
      urls.set(key, list);
    }
  });
  const sources = new Map<string, string[]>();
  for (const key of order) {
    const g = best.get(key)!;
    const list = urls.get(key) ?? [];
    const own = g.trainerSource;
    sources.set(sourcesKey(g), own ? [own, ...list.filter((u) => u !== own)] : list);
  }
  return { games: order.map((k) => best.get(k)!), sources };
}

/** The key a kept catalog entry's thread list is stored under. */
export function sourcesKey(g: Pick<DedupableGame, 'name' | 'steamAppId'>): string {
  return g.steamAppId != null ? `steam:${g.steamAppId}` : gameKey(g.name);
}

/**
 * Catalog entries matched to a Steam app — the ones with a real name and box
 * art — and how many were left out. Threads with no match (emulator builds,
 * hacks with no clear game, delisted games) still show in search. A catalog
 * with no Steam ids at all (built before matching) is returned whole.
 */
export function steamMatchedOnly<T extends DedupableGame>(games: T[]): { games: T[]; hidden: number } {
  if (!games.some((g) => g.steamAppId != null)) return { games, hidden: 0 };
  const matched = games.filter((g) => g.steamAppId != null);
  return { games: matched, hidden: games.length - matched.length };
}
