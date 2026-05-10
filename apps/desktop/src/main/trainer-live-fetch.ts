import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fromBuffer as openZipFromBuffer, type Entry } from 'yauzl';
import { importCt } from '@starlight/ct-importer';
import { StarlightTrainerSchema, type StarlightTrainer } from '@starlight/catalog/schema';

const USER_AGENT = 'starlight-desktop/0.0 (+https://github.com/darkharasho/starlight)';
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedTrainer {
  fetchedAt: string;
  source: string;
  trainer: StarlightTrainer;
}

function cacheFileFor(cacheDir: string, source: string): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 32);
  return join(cacheDir, `${hash}.json`);
}

async function readCache(path: string): Promise<CachedTrainer | null> {
  try {
    const text = await readFile(path, 'utf8');
    const obj = JSON.parse(text) as CachedTrainer;
    if (typeof obj.fetchedAt === 'string' && obj.trainer) return obj;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(path: string, payload: CachedTrainer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function extractCtFromZip(buf: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    openZipFromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      let foundEntry: Entry | null = null;
      zip.on('entry', (entry: Entry) => {
        if (foundEntry === null && /\.ct$/i.test(entry.fileName)) {
          foundEntry = entry;
          zip.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) return reject(err2 ?? new Error('failed to open zip entry'));
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => {
        if (foundEntry === null) reject(new Error('zip contains no .CT file'));
      });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function isViewtopicUrl(url: string): boolean {
  try { return new URL(url).pathname.endsWith('/viewtopic.php'); }
  catch { return false; }
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: ac.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveViewtopicAttachment(topicUrl: string): Promise<string | null> {
  const res = await fetchWithTimeout(topicUrl, 'text/html');
  if (!res.ok) return null;
  const html = await res.text();
  const matches = [...html.matchAll(
    /<a[^>]*href="\.?\/?download\/file\.php\?id=(\d+)[^"]*"[^>]*>([^<]+\.(?:CT|ct|zip))<\/a>/g,
  )];
  if (matches.length === 0) return null;
  const candidates = matches.map((m) => ({ id: Number(m[1]), filename: m[2]! }));
  const cts = candidates.filter((c) => /\.(?:CT|ct)$/.test(c.filename));
  const pool = cts.length > 0 ? cts : candidates;
  const pick = pool.reduce((a, b) => (a.id >= b.id ? a : b));
  const base = new URL(topicUrl);
  return new URL(`/download/file.php?id=${pick.id}`, `${base.protocol}//${base.host}`).toString();
}

async function downloadCtBuffer(directOrTopicUrl: string): Promise<Buffer> {
  let url = directOrTopicUrl;
  if (isViewtopicUrl(url)) {
    const direct = await resolveViewtopicAttachment(url);
    if (!direct) throw new Error(`no .CT attachment found in ${url}`);
    url = direct;
  }
  const res = await fetchWithTimeout(url, '*/*');
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return looksLikeZip(buf) ? extractCtFromZip(buf) : buf;
}

export interface FetchLiveOpts {
  /** Hints copied from the catalog entry — applied to the imported trainer. */
  id: string;
  name: string;
  processName: string[];
  platform: ('windows' | 'linux' | 'macos')[];
  /** Force a refresh even if a cached copy is fresh. */
  refresh?: boolean;
}

/**
 * Fetch a trainer .CT live from a fearlessrevolution viewtopic (or direct
 * download) URL, run the .CT through ct-importer, and cache the resulting
 * StarlightTrainer JSON in the user's userData directory.
 */
export async function fetchTrainerLive(source: string, opts: FetchLiveOpts): Promise<StarlightTrainer> {
  const cacheDir = join(app.getPath('userData'), 'live-trainers');
  await mkdir(cacheDir, { recursive: true });
  const cachePath = cacheFileFor(cacheDir, source);

  if (!opts.refresh) {
    const cached = await readCache(cachePath);
    if (cached) {
      const ageMs = Date.now() - Date.parse(cached.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < CACHE_TTL_MS) {
        return cached.trainer;
      }
    }
  }

  let buf: Buffer;
  try {
    buf = await downloadCtBuffer(source);
  } catch (err) {
    // Network/parse failure → fall back to stale cache if any.
    const cached = await readCache(cachePath);
    if (cached) return cached.trainer;
    throw err;
  }

  const xml = buf.toString('utf8');
  const out = importCt(xml, {
    gameName: opts.name,
    processName: opts.processName,
    platform: opts.platform,
  });
  const trainer: StarlightTrainer = StarlightTrainerSchema.parse({ ...out.trainer, id: opts.id });
  await writeCache(cachePath, {
    fetchedAt: new Date().toISOString(),
    source,
    trainer,
  });
  return trainer;
}
