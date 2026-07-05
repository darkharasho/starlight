import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fromBuffer as openZipFromBuffer, type Entry } from 'yauzl';

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'starlight-desktop/0.0 (+https://github.com/darkharasho/starlight)';

export interface DownloadOpts {
  source: string;
  cacheDir: string;
  cacheKey: string;
  refresh?: boolean;
}

/**
 * Highest CheatTable version the bundled Cheat Engine understands. Tables saved
 * by a newer CE trigger a blocking "made in a newer version" dialog on load,
 * which stalls the headless session. We currently bundle CE 7.5 (table v45).
 * (Bundling a newer CE would let us raise/remove this.)
 */
const MAX_CT_VERSION = 45;

/**
 * Clamps CheatEngineTableVersion down to what the bundled CE supports so the
 * table loads silently. Leaves already-supported tables untouched.
 */
export function clampCtVersion(ct: string, maxVersion = MAX_CT_VERSION): string {
  return ct.replace(/(CheatEngineTableVersion=")(\d+)(")/i, (whole, pre, num, post) => {
    return Number(num) > maxVersion ? `${pre}${maxVersion}${post}` : whole;
  });
}

export async function downloadCtToDisk(opts: DownloadOpts): Promise<{ ctPath: string }> {
  await mkdir(opts.cacheDir, { recursive: true });
  const ctPath = join(opts.cacheDir, `${opts.cacheKey}.ct`);
  if (!opts.refresh) {
    try { await stat(ctPath); return { ctPath }; }
    catch { /* miss — proceed */ }
  }
  const buf = await fetchCtBytes(opts.source);
  await writeFile(ctPath, clampCtVersion(buf.toString('utf8')), 'utf8');
  return { ctPath };
}

async function fetchCtBytes(directOrTopicUrl: string): Promise<Buffer> {
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

function isViewtopicUrl(url: string): boolean {
  try { return new URL(url).pathname.endsWith('/viewtopic.php'); }
  catch { return false; }
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

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: ac.signal, redirect: 'follow',
    });
  } finally { clearTimeout(t); }
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
        } else { zip.readEntry(); }
      });
      zip.on('end', () => { if (foundEntry === null) reject(new Error('zip contains no .CT file')); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
