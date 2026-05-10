import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchTrainer } from '../src/fetch.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let server: Server;
let port: number;
let serveBytes: Buffer = Buffer.alloc(0);
let serveStatus = 200;
let serveContentType = 'application/octet-stream';

function start(handler?: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler ?? ((_req, res) => {
      res.writeHead(serveStatus, { 'Content-Type': serveContentType });
      res.end(serveBytes);
    }));
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

beforeEach(() => { serveBytes = Buffer.alloc(0); serveStatus = 200; serveContentType = 'application/octet-stream'; });
afterEach(async () => { await new Promise<void>(r => server?.close(() => r())); });

const SAMPLE_CT = Buffer.from(
  `<?xml version="1.0" encoding="utf-8"?>\n<CheatTable CheatEngineTableVersion="42">\n<CheatEntries></CheatEntries>\n</CheatTable>\n`,
  'utf8',
);

describe('fetchTrainer (direct .CT)', () => {
  it('returns body when content is direct XML', async () => {
    serveBytes = SAMPLE_CT;
    await start();
    const buf = await fetchTrainer(`http://127.0.0.1:${port}/file.CT`);
    expect(buf.toString('utf8')).toContain('<CheatTable');
  });

  it('throws on 404', async () => {
    serveStatus = 404;
    await start();
    await expect(fetchTrainer(`http://127.0.0.1:${port}/missing.CT`)).rejects.toThrow(/HTTP 404/);
  });

  it('throws on connection refused', async () => {
    await expect(fetchTrainer('http://127.0.0.1:1/x.CT')).rejects.toThrow();
  });
});

describe('fetchTrainer (zip)', () => {
  it('extracts first .CT file from a zip', async () => {
    // Build a real zip on the fly using yauzl's writer? yauzl is read-only. Use yazl? Or assemble manually with 'archiver'?
    // Simpler: hand-craft a tiny zip using yazl. Add yazl as devDep if not present.
    const yazl = await import('yazl');
    const z = new yazl.ZipFile();
    z.addBuffer(SAMPLE_CT, 'trainer.CT');
    z.end();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      z.outputStream.on('data', (c: Buffer) => chunks.push(c));
      z.outputStream.on('end', () => resolve());
      z.outputStream.on('error', reject);
    });
    serveBytes = Buffer.concat(chunks);
    await start();
    const buf = await fetchTrainer(`http://127.0.0.1:${port}/trainer.zip`);
    expect(buf.toString('utf8')).toContain('<CheatTable');
  });

  it('throws when zip contains no .CT', async () => {
    const yazl = await import('yazl');
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('not a trainer'), 'readme.txt');
    z.end();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      z.outputStream.on('data', (c: Buffer) => chunks.push(c));
      z.outputStream.on('end', () => resolve());
      z.outputStream.on('error', reject);
    });
    serveBytes = Buffer.concat(chunks);
    await start();
    await expect(fetchTrainer(`http://127.0.0.1:${port}/empty.zip`)).rejects.toThrow(/no \.CT/i);
  });
});

const VIEWTOPIC_FIXTURE_PATH = join(__dirname, 'fixtures', 'viewtopic-with-attachments.html');

describe('fetchTrainer (viewtopic.php)', () => {
  it('extracts latest .CT attachment via two-step fetch', async () => {
    const viewtopicHtml = await readFile(VIEWTOPIC_FIXTURE_PATH, 'utf8');
    let phase = 'topic';
    await start((req, res) => {
      if (phase === 'topic') {
        if (!req.url || !req.url.includes('viewtopic')) { res.writeHead(400); res.end(); return; }
        phase = 'attachment';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(viewtopicHtml);
      } else {
        if (!req.url || !req.url.includes('id=75166')) { res.writeHead(400); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(SAMPLE_CT);
      }
    });
    const buf = await fetchTrainer(`http://127.0.0.1:${port}/viewtopic.php?f=4&t=13576`);
    expect(buf.toString('utf8')).toContain('<CheatTable');
  });

  it('throws when no attachment is found', async () => {
    await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>No attachments here.</p></body></html>');
    });
    await expect(
      fetchTrainer(`http://127.0.0.1:${port}/viewtopic.php?f=4&t=999`),
    ).rejects.toThrow(/no \.CT attachment/i);
  });

  it('prefers .CT over .zip when both present', async () => {
    const html = `
      <a class="postlink" href="./download/file.php?id=100">a.ct</a>
      <a class="postlink" href="./download/file.php?id=200">b.zip</a>
    `;
    let phase = 'topic';
    let pickedId = '';
    await start((_req, res) => {
      if (phase === 'topic') {
        phase = 'attachment';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        const url = _req.url ?? '';
        pickedId = url.match(/id=(\d+)/)?.[1] ?? '';
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(SAMPLE_CT);
      }
    });
    const buf = await fetchTrainer(`http://127.0.0.1:${port}/viewtopic.php?f=4&t=1`);
    expect(buf.toString('utf8')).toContain('<CheatTable');
    expect(pickedId).toBe('100');  // .ct id was chosen
  });
});
