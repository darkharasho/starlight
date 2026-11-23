/**
 * Finds every cheat table on offer for a game.
 *
 * A forum thread rarely has just one table: the author re-uploads per game
 * version, and other people post their own further down (often pages later).
 * Tables break whenever the game updates, so which one works depends on the
 * build the user has installed. Rather than silently betting on one, we list
 * them all (newest upload first) and let the session switch between them.
 */

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'starlight-desktop/0.0 (+https://github.com/darkharasho/starlight)';
const CACHE_TTL_MS = 30 * 60_000;
/** Beyond page 1 we read the newest pages only — that's where current tables get posted. */
const EXTRA_RECENT_PAGES = 2;

export interface CtTable {
  /** Forum attachment id (monotonic: a higher id is a newer upload). 0 for a direct .CT link. */
  id: number;
  filename: string;
  /** Direct download URL. */
  url: string;
  /** The thread it came from, or the URL itself for a direct link. */
  topicUrl: string;
}

export type FetchText = (url: string) => Promise<string | null>;

export function isViewtopicUrl(url: string): boolean {
  try { return new URL(url).pathname.endsWith('/viewtopic.php'); }
  catch { return false; }
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Extracts the .CT/.zip attachments linked on one page of a phpBB thread. */
export function parseAttachments(html: string, topicUrl: string): CtTable[] {
  let origin: string;
  try { origin = new URL(topicUrl).origin; } catch { return []; }
  const out: CtTable[] = [];
  const re = /<a[^>]*href="[^"]*download\/file\.php\?id=(\d+)[^"]*"[^>]*>([^<]+\.(?:ct|zip))\s*<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const id = Number(m[1]);
    out.push({
      id,
      filename: decodeEntities(m[2]!.trim()),
      url: `${origin}/download/file.php?id=${id}`,
      topicUrl,
    });
  }
  return out;
}

/**
 * Reads a thread page's pagination and returns the `start=` offsets of its
 * most recent pages (newest first), excluding the first page. Empty for a
 * single-page thread.
 */
export function recentPageStarts(html: string, topicUrl?: string, max = EXTRA_RECENT_PAGES): number[] {
  let topicId: string | null = null;
  try { if (topicUrl) topicId = new URL(topicUrl).searchParams.get('t'); } catch { /* match any */ }
  const starts = new Set<number>();
  for (const m of html.matchAll(/viewtopic\.php\?([^"'\s>]*)/g)) {
    const query = m[1]!.replace(/&amp;/g, '&');
    const params = new URLSearchParams(query);
    // Only this thread's own pagination — not links to other topics.
    if (topicId && params.get('t') !== topicId) continue;
    const n = Number(params.get('start'));
    if (Number.isFinite(n) && n > 0) starts.add(n);
  }
  if (starts.size === 0) return [];
  // phpBB elides middle pages ("1 2 3 … 29"), so derive the newest pages from
  // the page size (smallest offset) and the last page (largest offset).
  const pageSize = Math.min(...starts);
  const last = Math.max(...starts);
  const out: number[] = [];
  for (let s = last; s > 0 && out.length < max; s -= pageSize) out.push(s);
  return out;
}

function withStart(topicUrl: string, start: number): string {
  const u = new URL(topicUrl);
  u.searchParams.set('start', String(start));
  return u.toString();
}

async function defaultFetchText(url: string): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: ac.signal, redirect: 'follow' });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const cache = new Map<string, { at: number; tables: CtTable[] }>();

/** Test hook. */
export function clearTableCache(): void { cache.clear(); }

async function tablesForSource(source: string, fetchText: FetchText, now: number): Promise<CtTable[]> {
  if (!isViewtopicUrl(source)) {
    // A direct link to a table file.
    let filename = source;
    try { filename = decodeURIComponent(new URL(source).pathname.split('/').pop() || source); } catch { /* keep raw */ }
    return [{ id: 0, filename, url: source, topicUrl: source }];
  }
  const hit = cache.get(source);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.tables;

  const first = await fetchText(source);
  if (first === null) return [];
  const tables = parseAttachments(first, source);
  const more = await Promise.all(recentPageStarts(first, source).map((s) => fetchText(withStart(source, s))));
  for (const html of more) if (html) tables.push(...parseAttachments(html, source));

  cache.set(source, { at: now, tables });
  return tables;
}

/**
 * Lists the tables available across a game's threads, newest upload first.
 * Real .CT files are preferred; .zip attachments are only offered when a game
 * has no bare .CT at all. Unreachable threads are skipped, so the result can be
 * empty when offline.
 */
export async function listTables(
  sources: string[],
  opts: { fetchText?: FetchText; now?: number } = {},
): Promise<CtTable[]> {
  const fetchText = opts.fetchText ?? defaultFetchText;
  const now = opts.now ?? Date.now();
  const perSource = await Promise.all([...new Set(sources)].map((s) => tablesForSource(s, fetchText, now).catch(() => [])));

  const seen = new Set<string>();
  const all: CtTable[] = [];
  for (const t of perSource.flat()) {
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    all.push(t);
  }
  const cts = all.filter((t) => /\.ct$/i.test(t.filename) || t.id === 0);
  const pool = cts.length > 0 ? cts : all;
  // Newest first, but tables built for another storefront's executable (Game
  // Pass / Microsoft Store) go last: on Linux the game is the Steam build.
  return pool.sort((a, b) => Number(isOtherStoreBuild(a.filename)) - Number(isOtherStoreBuild(b.filename)) || b.id - a.id);
}

/** True for tables that target the Game Pass / Microsoft Store executable. */
export function isOtherStoreBuild(filename: string): boolean {
  return /wingdk|game\s?pass|xbox|ms\s?store|microsoft\s?store|\buwp\b/i.test(filename);
}
