import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { cleanTitle } from './title.js';
import { Progress } from './progress.js';

const TOPIC_RE = /<a href="\.\/viewtopic\.php\?f=(\d+)&amp;t=(\d+)[^"]*" class="topictitle"[^>]*>([^<]+)<\/a>/g;

interface RawThread { forumId: number; topicId: number; rawTitle: string }

interface DiscoveredSeed {
  url: string;
  name: string;
  rawTitle: string;
  steamAppId: number | null;
  processName: string[];
  platform: string[];
}

export interface DiscoverOpts {
  forumBase: string;
  forums: number[];
  seedsPath: string;
  sleepMs?: number;
  pageLimit?: number;
  loadSteamMap?: () => Promise<Map<string, number>>;
  fetch?: typeof fetch;
  /** Path to write a periodic JSON status snapshot. Skipped if undefined. */
  statusPath?: string;
}

const USER_AGENT = 'starlight-indexer/0.0 (+https://github.com/darkharasho/starlight)';
const PAGE_SIZE = 50;

function isStickyOrRequest(rawTitle: string): boolean {
  const t = rawTitle.toLowerCase().trim();
  return /^\[?(request|req)\]?[\s:]/i.test(t)
      || /^before you upload/i.test(t)
      || /^cheat engine download/i.test(t)
      || /^forum rules/i.test(t)
      || /^\[important\]/i.test(t);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractTopics(html: string): RawThread[] {
  const out: RawThread[] = [];
  TOPIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOPIC_RE.exec(html)) !== null) {
    out.push({
      forumId: Number(m[1]),
      topicId: Number(m[2]),
      rawTitle: decodeEntities(m[3]!),
    });
  }
  return out;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

async function fetchPage(url: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function discover(opts: DiscoverOpts): Promise<void> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const sleepMs = opts.sleepMs ?? 1000;
  const pageLimit = opts.pageLimit ?? Number.POSITIVE_INFINITY;
  const loadSteamMap = opts.loadSteamMap ?? (async () => new Map());

  const seeds: DiscoveredSeed[] = [];
  const dedupeKey = (forumId: number, topicId: number): string => `${forumId}:${topicId}`;
  const seenKeys = new Set<string>();

  const progress = new Progress({
    phase: 'discover',
    statusPath: opts.statusPath ?? null,
    lineEvery: 1,
  });

  for (const forumId of opts.forums) {
    let start = 0;
    let pages = 0;
    while (pages < pageLimit) {
      const url = `${opts.forumBase}?f=${forumId}&start=${start}`;
      let html: string;
      try { html = await fetchPage(url, fetchFn); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progress.bump('failed');
        progress.noteError(`fetch ${url}: ${msg}`);
        await progress.update(`fetch error · stopping forum f=${forumId}`);
        break;
      }
      const threads = extractTopics(html);
      if (threads.length === 0) break;
      let pageKept = 0;
      let pageFiltered = 0;
      for (const t of threads) {
        if (isStickyOrRequest(t.rawTitle)) { pageFiltered++; continue; }
        const key = dedupeKey(t.forumId, t.topicId);
        if (seenKeys.has(key)) { pageFiltered++; continue; }
        seenKeys.add(key);
        const cleaned = cleanTitle(t.rawTitle);
        seeds.push({
          url: `https://fearlessrevolution.com/viewtopic.php?f=${t.forumId}&t=${t.topicId}`,
          name: cleaned,
          rawTitle: t.rawTitle,
          steamAppId: null,
          processName: [],
          platform: ['windows'],
        });
        pageKept++;
      }
      progress.bump('added', pageKept);
      progress.bump('skipped', pageFiltered);
      pages += 1;
      start += PAGE_SIZE;
      await progress.tick(`f=${forumId} page ${pages} · ${seeds.length} seeds collected`);
      if (sleepMs > 0) await sleep(sleepMs);
    }
  }

  if (seeds.length === 0) {
    await progress.done('zero topics discovered; existing seeds.yaml preserved');
    return;
  }

  await progress.update(`enriching ${seeds.length} seeds with Steam IDs…`);
  const steamMap = await loadSteamMap();
  let withId = 0;
  for (const s of seeds) {
    const id = steamMap.get(s.name.toLowerCase());
    if (id !== undefined) { s.steamAppId = id; withId++; }
  }

  const yaml = yamlStringify({ games: seeds });
  await atomicWrite(opts.seedsPath, yaml);

  await progress.done(`${seeds.length} games (${withId} with Steam IDs) → ${opts.seedsPath}`);
}
