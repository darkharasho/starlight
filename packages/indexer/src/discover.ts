import { writeFile, rename, mkdir, readFile, unlink } from 'node:fs/promises';
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
  /** Path to persist mid-walk state for resume. Skipped if undefined. */
  resumePath?: string;
}

interface DiscoverResumeState {
  schemaVersion: 1;
  nextStartByForum: Record<string, number>;
  seeds: DiscoveredSeed[];
}

async function readResumeState(path: string): Promise<DiscoverResumeState | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion?: unknown; nextStartByForum?: unknown; seeds?: unknown };
    if (raw.schemaVersion !== 1) return null;
    if (typeof raw.nextStartByForum !== 'object' || raw.nextStartByForum === null) return null;
    if (!Array.isArray(raw.seeds)) return null;
    return raw as DiscoverResumeState;
  } catch {
    return null;
  }
}

async function writeResumeState(path: string, state: DiscoverResumeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await writeFile(tmp, JSON.stringify(state) + '\n', 'utf8');
    await rename(tmp, path);
  } catch {
    /* best effort — never fail the run for resume bookkeeping */
  }
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
  const nextStartByForum: Record<string, number> = {};

  // Resume from a prior interrupted walk if the state file exists.
  let resumed = false;
  if (opts.resumePath) {
    const prior = await readResumeState(opts.resumePath);
    if (prior) {
      for (const s of prior.seeds) {
        seeds.push(s);
        const m = s.url.match(/[?&]f=(\d+)&t=(\d+)/);
        if (m) seenKeys.add(`${m[1]}:${m[2]}`);
      }
      for (const [k, v] of Object.entries(prior.nextStartByForum)) {
        if (typeof v === 'number') nextStartByForum[k] = v;
      }
      resumed = true;
    }
  }

  const progress = new Progress({
    phase: 'discover',
    statusPath: opts.statusPath ?? null,
    lineEvery: 1,
  });
  if (resumed) {
    progress.bump('added', seeds.length);
    await progress.update(`resumed from ${opts.resumePath} · ${seeds.length} seeds carried over`);
  }

  const persistResume = async (): Promise<void> => {
    if (!opts.resumePath) return;
    await writeResumeState(opts.resumePath, {
      schemaVersion: 1,
      nextStartByForum,
      seeds,
    });
  };

  for (const forumId of opts.forums) {
    let start = nextStartByForum[String(forumId)] ?? 0;
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
      if (threads.length === 0) {
        // Forum exhausted; clear its resume cursor so a future re-run starts fresh.
        delete nextStartByForum[String(forumId)];
        await persistResume();
        break;
      }
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
      nextStartByForum[String(forumId)] = start;
      await persistResume();
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

  // Walk completed successfully — clean up the resume marker.
  if (opts.resumePath) await unlink(opts.resumePath).catch(() => {});

  await progress.done(`${seeds.length} games (${withId} with Steam IDs) → ${opts.seedsPath}`);
}
