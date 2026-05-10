import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { discover } from '../src/discover.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORUM_FIXTURE = join(__dirname, 'fixtures', 'forum-page.html');

let dir: string;
let seedsPath: string;
let server: Server;
let port: number;

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
  dir = join(tmpdir(), `starlight-discover-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  seedsPath = join(dir, 'seeds.yaml');
});
afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('discover', () => {
  it('walks forum pages, filters stickies/requests, writes seeds.yaml', async () => {
    const html = await readFile(FORUM_FIXTURE, 'utf8');
    let calls = 0;
    await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>(empty)</body></html>');
      }
    });
    await discover({
      forumBase: `http://127.0.0.1:${port}/viewforum.php`,
      forums: [4],
      seedsPath,
      sleepMs: 0,
      loadSteamMap: async () => new Map(),
    });
    const text = await readFile(seedsPath, 'utf8');
    expect(text).toContain('Europa Universalis 5');
    expect(text).toContain('Crusader Kings III');
    expect(text).toContain('WARNO');
    expect(text).not.toContain('Before you upload');
    expect(text).not.toMatch(/\[REQUEST\]/);
  });

  it('cleans titles before writing seeds', async () => {
    const html = await readFile(FORUM_FIXTURE, 'utf8');
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    await discover({
      forumBase: `http://127.0.0.1:${port}/viewforum.php`,
      forums: [4],
      seedsPath,
      sleepMs: 0,
      pageLimit: 1,
      loadSteamMap: async () => new Map(),
    });
    const text = await readFile(seedsPath, 'utf8');
    expect(text).toMatch(/name:\s*"?Crusader Kings III"?\s*$/m);
    expect(text).toMatch(/rawTitle:\s*["']?Crusader Kings III \| Steam v1\.18\.2/);
  });

  it('enriches with Steam IDs when loadSteamMap returns matches', async () => {
    const html = await readFile(FORUM_FIXTURE, 'utf8');
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    await discover({
      forumBase: `http://127.0.0.1:${port}/viewforum.php`,
      forums: [4],
      seedsPath,
      sleepMs: 0,
      pageLimit: 1,
      loadSteamMap: async () => new Map([
        ['warno', 999999],
      ]),
    });
    const text = await readFile(seedsPath, 'utf8');
    expect(text).toMatch(/steamAppId:\s*999999/);
  });

  it('preserves existing seeds.yaml when zero topics are discovered', async () => {
    await writeFile(seedsPath, `games:\n  - url: https://existing\n    name: Existing\n    processName: [x.exe]\n    platform: [windows]\n`);
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>(no topics)</body></html>');
    });
    await discover({
      forumBase: `http://127.0.0.1:${port}/viewforum.php`,
      forums: [4],
      seedsPath,
      sleepMs: 0,
      loadSteamMap: async () => new Map(),
    });
    const text = await readFile(seedsPath, 'utf8');
    expect(text).toContain('Existing');
    expect(text).toContain('https://existing');
  });
});
