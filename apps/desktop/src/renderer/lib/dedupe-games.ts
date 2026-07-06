/**
 * The trainer catalog is auto-generated from many forum threads, so the same
 * game shows up under several title variants ("7 Days To Die" / "7 Days to
 * Die", "A Plague Tale Innocence" / "A Plague Tale: Innocence"). This collapses
 * each set of variants to a single, best-titled entry for display.
 */

export interface DedupableGame {
  name: string;
  trainerUpdatedAt?: string | undefined;
  trainerPath?: string | undefined;
}

// Tokens that mark a "junk" title (a raw table/trainer/version label rather
// than a clean game name), e.g. "10,000,000 table v: 1.0 CT".
const JUNK = [/\btable\b/i, /\bcheat\b/i, /\btrainer\b/i, /\bct\b/i, /\.ct\b/i, /\bv[.:]?\s*\d+(?:\.\d+)*\b/i, /\bversion\b/i];

/** Removes junk tokens so title variants with a trailing table/version label group together. */
function stripJunk(name: string): string {
  let s = name;
  for (const re of JUNK) s = s.replace(new RegExp(re.source, 'gi'), ' ');
  return s;
}

/**
 * Grouping key: junk tokens stripped, then lowercase alphanumerics only — so
 * "10,000,000" and "10,000,000 table v: 1.0 CT" collapse together. Falls back
 * to the raw normalized name if stripping leaves nothing (a game literally
 * named e.g. "Table").
 */
function normKey(name: string): string {
  const raw = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const stripped = stripJunk(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  return stripped || raw;
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
    const key = normKey(g.name) || `__raw__${i}`;
    const cur = best.get(key);
    if (cur === undefined) { best.set(key, g); order.push(key); }
    else if (isBetter(g, cur)) best.set(key, g);
  });
  return order.map((k) => best.get(k)!);
}
