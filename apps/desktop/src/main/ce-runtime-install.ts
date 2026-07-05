import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fromBuffer as openZipFromBuffer, type Entry } from 'yauzl';

export type ProgressEvent =
  | { phase: 'downloading'; current: number; total: number }
  | { phase: 'verifying' }
  | { phase: 'extracting'; current: number; total: number }
  | { phase: 'done' };

export interface InstallOpts {
  url: string;
  sha256: string;
  runtimeRoot: string;
  onProgress: (e: ProgressEvent) => void;
  /** Path of the binary inside the extracted root, chmod +x'd. Default: CheatEngineLinux766-4/cheatengine-x86_64. */
  binaryRelative?: string;
}

/** Streams a URL to disk, verifying its sha256, and returns the bytes. */
async function downloadVerified(
  url: string, sha256: string, tmpPath: string, onProgress: (e: ProgressEvent) => void,
): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw new Error(`runtime download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    await rm(tmpPath, { force: true });
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body) throw new Error('no response body');

  const out = createWriteStream(tmpPath);
  const hasher = createHash('sha256');
  let received = 0;
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
    received += value.length;
    onProgress({ phase: 'downloading', current: received, total });
    await new Promise<void>((resolve, reject) => out.write(value, (err) => err ? reject(err) : resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((err: unknown) => err ? reject(err as Error) : resolve()));

  onProgress({ phase: 'verifying' });
  const got = hasher.digest('hex');
  if (got.toLowerCase() !== sha256.toLowerCase()) {
    await rm(tmpPath, { force: true });
    throw new Error(`sha256 mismatch: expected ${sha256}, got ${got}`);
  }
  return readFile(tmpPath);
}

export async function installCeRuntime(opts: InstallOpts): Promise<void> {
  await mkdir(opts.runtimeRoot, { recursive: true });
  const tmpZip = join(opts.runtimeRoot, `.download-${process.pid}-${Date.now()}.zip`);

  const buf = await downloadVerified(opts.url, opts.sha256, tmpZip, opts.onProgress);
  await extractZipTo(buf, opts.runtimeRoot, opts.onProgress);
  await rm(tmpZip, { force: true });

  const binaryRel = opts.binaryRelative ?? 'CheatEngineLinux766-4/cheatengine-x86_64';
  await chmod(join(opts.runtimeRoot, binaryRel), 0o755).catch(() => {});

  opts.onProgress({ phase: 'done' });
}

export interface InstallWindowsCeOpts {
  url: string;
  sha256: string;
  /** The Linux CE install dir (…/CheatEngineLinux766-4); the zip extracts into its windowsbin/. */
  installDir: string;
  onProgress: (e: ProgressEvent) => void;
}

/**
 * Downloads + extracts the Windows Cheat Engine build into `<installDir>/windowsbin/`
 * so Proton games can be cheated by running Windows CE inside their prefix. The
 * zip is expected to contain the CE app files at its root (incl. lua/json.lua).
 */
export async function installWindowsCe(opts: InstallWindowsCeOpts): Promise<void> {
  const windowsbin = join(opts.installDir, 'windowsbin');
  await mkdir(windowsbin, { recursive: true });
  const tmpZip = join(opts.installDir, `.wince-${process.pid}-${Date.now()}.zip`);
  const buf = await downloadVerified(opts.url, opts.sha256, tmpZip, opts.onProgress);
  await extractZipTo(buf, windowsbin, opts.onProgress);
  await rm(tmpZip, { force: true });
  opts.onProgress({ phase: 'done' });
}

function extractZipTo(buf: Buffer, dest: string, onProgress: (e: ProgressEvent) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    openZipFromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      const total = zip.entryCount;
      let i = 0;
      zip.on('entry', (entry: Entry) => {
        const target = join(dest, entry.fileName);
        const isDir = /\/$/.test(entry.fileName);
        if (isDir) {
          mkdir(target, { recursive: true })
            .then(() => { i += 1; onProgress({ phase: 'extracting', current: i, total }); zip.readEntry(); })
            .catch(reject);
          return;
        }
        zip.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) return reject(err2 ?? new Error('failed to open zip entry'));
          mkdir(join(target, '..'), { recursive: true }).then(() => {
            const w = createWriteStream(target);
            stream.pipe(w);
            w.on('finish', () => { i += 1; onProgress({ phase: 'extracting', current: i, total }); zip.readEntry(); });
            w.on('error', reject);
          }).catch(reject);
        });
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
