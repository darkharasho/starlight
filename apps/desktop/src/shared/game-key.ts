// Tokens that mark a "junk" title (a raw table/trainer/version label rather
// than a clean game name), e.g. "10,000,000 table v: 1.0 CT".
export const JUNK = [/\btable\b/i, /\bcheat\b/i, /\btrainer\b/i, /\bct\b/i, /\.ct\b/i, /\bv[.:]?\s*\d+(?:\.\d+)*\b/i, /\bversion\b/i];

/** Removes junk tokens so title variants with a trailing table/version label group together. */
function stripJunk(name: string): string {
  let s = name;
  for (const re of JUNK) s = s.replace(new RegExp(re.source, 'gi'), ' ');
  return s;
}

/**
 * Grouping key (also the stable per-game identity used for table choices and
 * table caching): junk tokens stripped, then lowercase alphanumerics only — so
 * "10,000,000" and "10,000,000 table v: 1.0 CT" collapse together. Falls back
 * to the raw normalized name if stripping leaves nothing (a game literally
 * named e.g. "Table").
 */
export function gameKey(name: string): string {
  const raw = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const stripped = stripJunk(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  return stripped || raw;
}

/** The user-cheats key for a game page cache key: no leading `tools-`, at most 80 chars. */
export function userCheatsKey(cacheKey: string): string {
  return cacheKey.replace(/^tools-/, '').slice(0, 80);
}
