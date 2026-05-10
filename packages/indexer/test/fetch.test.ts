import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchTrainer } from '../src/fetch.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
