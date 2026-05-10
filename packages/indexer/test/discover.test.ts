import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { discover } from '../src/discover.js';
import { readSeeds } from '../src/seeds.js';

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

  it('persists a resume file after each page and deletes it on success', async () => {
    const html = await readFile(FORUM_FIXTURE, 'utf8');
    let calls = 0;
    await startServer((_req, res) => {
      calls++;
      // Page 1 → fixture (5 topics, 3 keepable). Page 2 → empty (terminates).
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(calls === 1 ? html : '<html><body>(empty)</body></html>');
    });
    const resumePath = join(dir, 'discover-progress.json');
    await discover({
      forumBase: `http://127.0.0.1:${port}/viewforum.php`,
      forums: [4],
      seedsPath,
      sleepMs: 0,
      resumePath,
      loadSteamMap: async () => new Map(),
    });
    // Successful walk must remove the resume marker.
    await expect(readFile(resumePath, 'utf8')).rejects.toThrow();
  });

  it('resumes from a prior progress file without re-walking earlier pages', async () => {
    const resumePath = join(dir, 'discover-progress.json');
    // Simulate a prior interrupted run: 2 seeds collected, next page = 100.
    const prior = {
      schemaVersion: 1,
      nextStartByForum: { '4': 100 },
      seeds: [
        { url: 'https://fearlessrevolution.com/viewtopic.php?f=4&t=1',
          name: 'Carryover One', rawTitle: 'Carryover One',
          steamAppId: null, processName: [], platform: ['windows'] },
        { url: 'https://fearlessrevolution.com/viewtopic.php?f=4&t=2',
          name: 'Carryover Two', rawTitle: 'Carryover Two',
          steamAppId: null, processName: [], platform: ['windows'] },
      ],
    };
    await writeFile(resumePath, JSON.stringify(prior));

    let firstUrl: string | null = null;
    await startServer((req, res) => {
      if (firstUrl === null) firstUrl = req.url ?? null;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>(empty)</body></html>');                // terminates immediately
    });
    await discover({
      forumBase: `http://127.0.0.1:${port}/viewforum.php`,
      forums: [4],
      seedsPath,
      sleepMs: 0,
      resumePath,
      loadSteamMap: async () => new Map(),
    });
    // The first request should have been at start=100, not start=0.
    expect(firstUrl).toContain('start=100');
    // The 2 carry-over seeds should be in the final seeds.yaml.
    const text = await readFile(seedsPath, 'utf8');
    expect(text).toContain('Carryover One');
    expect(text).toContain('Carryover Two');
  });

  it('writes seeds.yaml that readSeeds() accepts (round-trip contract)', async () => {
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
    const seeds = await readSeeds(seedsPath);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds[0]!.processName).toEqual([]);
    expect(seeds[0]!.platform).toEqual(['windows']);
  });
});
