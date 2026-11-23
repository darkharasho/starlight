import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
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
  /** Path of the binary inside the extracted root, chmod +x'd. Default: ceserver-7.5/ceserver. */
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

/**
 * Downloads + extracts ceserver (Cheat Engine's Linux memory server, which
 * Windows CE connects to for native Linux games). The zip holds one top-level
 * directory (the manifest's extractedDir) with the binary and its extension.
 */
export async function installCeServer(opts: InstallOpts): Promise<void> {
  await mkdir(opts.runtimeRoot, { recursive: true });
  const tmpZip = join(opts.runtimeRoot, `.download-${process.pid}-${Date.now()}.zip`);

  const buf = await downloadVerified(opts.url, opts.sha256, tmpZip, opts.onProgress);
  await extractZipTo(buf, opts.runtimeRoot, opts.onProgress);
  await rm(tmpZip, { force: true });

  const binaryRel = opts.binaryRelative ?? 'ceserver-7.5/ceserver';
  await chmod(join(opts.runtimeRoot, binaryRel), 0o755).catch(() => {});

  opts.onProgress({ phase: 'done' });
}

export interface InstallWindowsCeOpts {
  url: string;
  sha256: string;
  /** Where the CE app files go (…/runtime/CheatEngineWindows75). */
  destDir: string;
  onProgress: (e: ProgressEvent) => void;
}

/**
 * Downloads + extracts the Windows Cheat Engine build into `destDir`. Starlight
 * runs it inside a Proton game's prefix, or in its own prefix (connected to
 * ceserver) for native games. The zip holds the CE app files at its root
 * (incl. lua/json.lua).
 */
export async function installWindowsCe(opts: InstallWindowsCeOpts): Promise<void> {
  await mkdir(opts.destDir, { recursive: true });
  const tmpZip = join(opts.destDir, `.wince-${process.pid}-${Date.now()}.zip`);
  const buf = await downloadVerified(opts.url, opts.sha256, tmpZip, opts.onProgress);
  await extractZipTo(buf, opts.destDir, opts.onProgress);
  await rm(tmpZip, { force: true });
  await neutralizeCePrank(opts.destDir);
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


/**
 * Strips Cheat Engine's built-in "prank" easter eggs from an extracted CE tree:
 * a random maniacal laugh (autorun/soundextension.lua + autorun/dlls/dnd.dat)
 * and a window-resize gag (autorun/eatme.lua). Called after every install so
 * the pranks never come back even when the runtime is re-downloaded. Missing
 * files are ignored; dnd.dat is zero-filled in place (deleting it makes CE exit).
 */
export async function neutralizeCePrank(ceDir: string): Promise<void> {
  const disabled = '-- disabled by starlight (CE prank easter egg)\n';
  const luaTargets = [
    join(ceDir, 'autorun', 'soundextension.lua'),
    join(ceDir, 'autorun', 'eatme.lua'),
  ];
  await Promise.all(luaTargets.map((f) => writeFile(f, disabled).catch(() => {})));

  const dnd = join(ceDir, 'autorun', 'dlls', 'dnd.dat');
  try {
    const buf = await readFile(dnd);
    await writeFile(dnd, Buffer.alloc(buf.length));
  } catch { /* not present; nothing to do */ }
}
