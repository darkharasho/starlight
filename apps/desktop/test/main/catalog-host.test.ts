import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchCatalogFrom, fetchTrainerFrom } from '../../src/main/catalog-host.js';

let server: Server;
let port: number;
let cacheDir: string;
let etag = '"v1"';
let body = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '2026-05-09T00:00:00Z',
  games: [
    { id: 'a', name: 'A', steamAppId: 1, processName: ['a.exe'], platform: ['windows'],
      trainerPath: 'trainers/a.json' },
  ],
});

function startServer(handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

beforeEach(async () => {
  cacheDir = join(tmpdir(), `starlight-catalog-cache-${Date.now()}-${Math.random()}`);
  await mkdir(cacheDir, { recursive: true });
});

afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await rm(cacheDir, { recursive: true, force: true });
});

describe('catalog-host fetchCatalogFrom', () => {
  it('fetches and caches on first call (200)', async () => {
    let hits = 0;
    await startServer((req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
      res.end(body);
    });

    const idx = await fetchCatalogFrom(`http://127.0.0.1:${port}/index.json`, cacheDir);
    expect(idx.games).toHaveLength(1);
    expect(hits).toBe(1);
    const cached = JSON.parse(await readFile(join(cacheDir, 'index.json'), 'utf8'));
    expect(cached.games[0].id).toBe('a');
    const meta = JSON.parse(await readFile(join(cacheDir, 'meta.json'), 'utf8'));
    expect(meta.etag).toBe(etag);
  });

  it('uses If-None-Match and falls through 304 to cache', async () => {
    let lastRequestEtag: string | undefined;
    await startServer((req, res) => {
      lastRequestEtag = req.headers['if-none-match'];
      if (lastRequestEtag === etag) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
      res.end(body);
    });
    await fetchCatalogFrom(`http://127.0.0.1:${port}/index.json`, cacheDir);
    const idx = await fetchCatalogFrom(`http://127.0.0.1:${port}/index.json`, cacheDir);
    expect(lastRequestEtag).toBe(etag);
    expect(idx.games[0]!.id).toBe('a');
  });

  it('falls back to cache on network failure', async () => {
    await writeFile(join(cacheDir, 'index.json'), body);
    await writeFile(join(cacheDir, 'meta.json'), JSON.stringify({ etag, lastFetchedAt: 'x' }));
    // No server started: the host must hit a closed port and fall back.
    const idx = await fetchCatalogFrom(`http://127.0.0.1:1/index.json`, cacheDir);
    expect(idx.games[0]!.id).toBe('a');
  });

  it('throws when network fails AND no cache exists', async () => {
    await expect(fetchCatalogFrom(`http://127.0.0.1:1/index.json`, cacheDir))
      .rejects.toThrow(/catalog unavailable/i);
  });

  it('rejects malformed JSON via Zod', async () => {
    await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"schemaVersion":1,"games":"not an array"}');
    });
    await expect(fetchCatalogFrom(`http://127.0.0.1:${port}/index.json`, cacheDir))
      .rejects.toThrow();
  });
});

describe('catalog-host fetchTrainerFrom', () => {
  it('fetches a trainer and caches it', async () => {
    const trainer = {
      schemaVersion: 1,
      id: 'a',
      game: { name: 'A', processName: ['a.exe'], platform: ['windows'] },
      metadata: { author: 't', source: { convertedFrom: '.CT' }, convertedAt: '2026-05-09T00:00:00Z' },
      categories: [{ name: 'X', cheats: [] }],
    };
    await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"t1"' });
      res.end(JSON.stringify(trainer));
    });
    const got = await fetchTrainerFrom(`http://127.0.0.1:${port}`, 'trainers/a.json', cacheDir);
    expect(got.id).toBe('a');
    expect(got.categories[0]!.name).toBe('X');
  });
});
