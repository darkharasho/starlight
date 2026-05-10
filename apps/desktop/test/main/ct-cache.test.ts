// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { downloadCtToDisk } from '../../src/main/ct-cache.js';

let dir: string;
let server: Server;
let port: number;

async function startServer(handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  });
}

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-ct-cache-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('downloadCtToDisk', () => {
  it('downloads a direct .CT URL and writes it to disk', async () => {
    const body = '<?xml version="1.0"?>\n<CheatTable><CheatEntries/></CheatTable>';
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(body);
    });
    const r = await downloadCtToDisk({
      source: `http://127.0.0.1:${port}/x.CT`,
      cacheDir: dir,
      cacheKey: 'test-trainer',
    });
    expect(r.ctPath).toMatch(/test-trainer\.ct$/);
    const written = await readFile(r.ctPath, 'utf8');
    expect(written).toBe(body);
  });

  it('reuses the cached file if present', async () => {
    let calls = 0;
    await startServer((_req, res) => {
      calls += 1;
      res.writeHead(200);
      res.end('<CheatTable />');
    });
    await downloadCtToDisk({ source: `http://127.0.0.1:${port}/x.CT`, cacheDir: dir, cacheKey: 'k' });
    await downloadCtToDisk({ source: `http://127.0.0.1:${port}/x.CT`, cacheDir: dir, cacheKey: 'k' });
    expect(calls).toBe(1);
  });
});
