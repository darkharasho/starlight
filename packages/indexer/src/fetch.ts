import { fromBuffer as openZipFromBuffer, type Entry } from 'yauzl';

const USER_AGENT = 'starlight-indexer/0.0 (+https://github.com/darkharasho/starlight)';
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchTrainer(url: string): Promise<Buffer> {
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
