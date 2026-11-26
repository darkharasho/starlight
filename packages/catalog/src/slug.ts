export function slugify(name: string): string {
  const normalized = name
    // Remove punctuation and symbols, but preserve dash and underscore (treat as word chars temporarily)
    .replace(/[\p{P}\p{S}]/gu, (ch) => /[-_]/.test(ch) ? ch : '')
    .normalize('NFKD')
    .replace(/[\p{Mn}]/gu, '')        // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]+/g, '')       // keep only alphanumerics, hyphen, underscore, space
    .replace(/[\s_]+/g, '-')                 // spaces and underscores → hyphen
    .replace(/^-+|-+$/g, '')                  // trim leading/trailing hyphens
    .replace(/-+/g, '-');                     // collapse multiple hyphens
  return normalized.length > 0 ? normalized : 'untitled';
}

function extractYear(name: string): string | null {
  const m = name.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

/**
 * Allocate a unique id for `name` against a set of already-taken ids.
 * Strategy: bare slug → slug-<year> if collision and name contains a year → slug-2, slug-3, ...
 */
export function allocateId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;

  const year = extractYear(name);
  if (year) {
    const yearId = `${base}-${year}`;
    if (!taken.has(yearId)) return yearId;
  }

  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`allocateId: gave up after 1000 collisions for "${name}"`);
}
