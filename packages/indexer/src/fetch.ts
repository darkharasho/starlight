import { fromBuffer as openZipFromBuffer, type Entry } from 'yauzl';

const USER_AGENT = 'starlight-indexer/0.0 (+https://github.com/darkharasho/starlight)';
const FETCH_TIMEOUT_MS = 30_000;

function isViewtopicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.endsWith('/viewtopic.php');
  } catch {
    return false;
  }
}

async function resolveViewtopicAttachment(topicUrl: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(topicUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: ac.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;
  const html = await res.text();
  // Real fearlessrevolution links are `href="./download/file.php?id=N&amp;sid=..."`
  // — the `[^"]*` after the id absorbs any session token. We strip it when building
  // the absolute URL so the fetch is session-free and cacheable.
  const matches = [...html.matchAll(
    /<a[^>]*href="\.?\/?download\/file\.php\?id=(\d+)[^"]*"[^>]*>([^<]+\.(?:CT|ct|zip))<\/a>/g,
  )];
  if (matches.length === 0) return null;
  const candidates = matches.map((m) => ({ id: Number(m[1]), filename: m[2]! }));
  const cts = candidates.filter((c) => /\.(?:CT|ct)$/.test(c.filename));
  // Highest `id=` is the most recently uploaded attachment.
  const pool = cts.length > 0 ? cts : candidates;
  const pick = pool.reduce((a, b) => (a.id >= b.id ? a : b));
  const base = new URL(topicUrl);
  return new URL(`/download/file.php?id=${pick.id}`, `${base.protocol}//${base.host}`).toString();
}

export async function fetchTrainer(url: string): Promise<Buffer> {
  if (isViewtopicUrl(url)) {
    const direct = await resolveViewtopicAttachment(url);
    if (!direct) throw new Error(`viewtopic ${url}: no .CT attachment found`);
    return fetchTrainer(direct);
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: ac.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  return looksLikeZip(buf) ? extractCtFromZip(buf) : buf;
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
