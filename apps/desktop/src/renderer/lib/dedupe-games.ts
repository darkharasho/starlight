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
  trainerUpdatedAt?: string | undefined;
  trainerPath?: string | undefined;
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
  const sa = nameScore(a.name), sb = nameScore(b.name);
  if (sa !== sb) return sa > sb;
  const ta = a.trainerUpdatedAt ?? '', tb = b.trainerUpdatedAt ?? '';
  if (ta !== tb) return ta > tb;                         // prefer the more recent trainer
  if (!!a.trainerPath !== !!b.trainerPath) return !!a.trainerPath;  // prefer a pre-built static trainer
  return false;                                          // otherwise keep the earlier one (stable)
}

/**
 * Collapses title-variant duplicates to one entry each, keeping the best-titled
 * variant per group and preserving first-appearance order.
 */
export function dedupeGames<T extends DedupableGame>(games: T[]): T[] {
  const best = new Map<string, T>();
  const order: string[] = [];
  games.forEach((g, i) => {
    // Names that normalize to nothing (pure punctuation) can't be grouped —
    // keep each as-is under a unique key.
    const key = gameKey(g.name) || `__raw__${i}`;
    const cur = best.get(key);
    if (cur === undefined) { best.set(key, g); order.push(key); }
    else if (isBetter(g, cur)) best.set(key, g);
  });
  return order.map((k) => best.get(k)!);
}
