import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { LutrisScanner } from '../../src/main/library-host.js';

let dbDir: string;
let dbPath: string;

beforeAll(async () => {
  dbDir = join(tmpdir(), `starlight-lutris-${Date.now()}`);
  await mkdir(dbDir, { recursive: true });
  dbPath = join(dbDir, 'lutris.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      name TEXT,
      runner TEXT,
      directory TEXT,
      installed INTEGER,
      slug TEXT
    );
    INSERT INTO games (id, name, runner, directory, installed, slug) VALUES
      (1, 'Stardew Valley', 'wine', '/games/StardewValley', 1, 'stardew-valley'),
      (2, 'Hollow Knight', 'wine', '/games/HollowKnight', 1, 'hollow-knight'),
      (3, 'Uninstalled Game', 'wine', '', 0, 'uninstalled-game');
  `);
  db.close();
});

afterAll(async () => {
  await rm(dbDir, { recursive: true, force: true });
});

describe('LutrisScanner', () => {
  it('reads installed games from the games table', async () => {
    const s = new LutrisScanner({ dbPathResolver: async () => dbPath });
    const games = await s.scan();
    expect(games).toHaveLength(2);
    const byName = Object.fromEntries(games.map(g => [g.name, g]));
    expect(byName['Stardew Valley']).toMatchObject({
      source: 'lutris',
      name: 'Stardew Valley',
      installDir: '/games/StardewValley',
      appId: 'stardew-valley',
    });
    expect(byName['Hollow Knight']).toMatchObject({
      source: 'lutris',
      installDir: '/games/HollowKnight',
      appId: 'hollow-knight',
    });
  });

  it('skips uninstalled games (installed=0 or empty directory)', async () => {
    const s = new LutrisScanner({ dbPathResolver: async () => dbPath });
    const games = await s.scan();
    expect(games.find(g => g.name === 'Uninstalled Game')).toBeUndefined();
  });

  it('returns [] when DB does not exist', async () => {
    const s = new LutrisScanner({ dbPathResolver: async () => '/nonexistent/lutris.db' });
    expect(await s.scan()).toEqual([]);
  });

  it('returns [] when DB cannot be resolved', async () => {
    const s = new LutrisScanner({ dbPathResolver: async () => null });
    expect(await s.scan()).toEqual([]);
  });
});
