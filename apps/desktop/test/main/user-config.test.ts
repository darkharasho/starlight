import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getConfigFrom, updateConfigFrom,
} from '../../src/main/user-config.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-config-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('user-config getConfigFrom', () => {
  it('returns defaults when file is missing', async () => {
    const c = await getConfigFrom(join(dir, 'config.json'));
    expect(c.schemaVersion).toBe(1);
    expect(c.recents).toEqual([]);
    expect(c.processNameOverrides).toEqual({});
    expect(c.preferences.pollIntervalMs).toBe(2000);
    expect(c.preferences.catalogRefreshOnLaunch).toBe(true);
    expect(c.preferences.theme).toBe('dark');
    expect(c.manualGames).toEqual([]);
    expect(c.hotkeyOverrides).toEqual({});
  });

  it('loads + validates an existing file', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      processNameOverrides: { 'elden-ring': ['eldenring.exe'] },
      recents: [{ id: 'a', name: 'A', openedAt: '2026-05-09T00:00:00Z', source: 'catalog' }],
      preferences: { theme: 'dark', pollIntervalMs: 5000, catalogRefreshOnLaunch: false },
      manualGames: [],
      hotkeyOverrides: {},
    }));
    const c = await getConfigFrom(path);
    expect(c.processNameOverrides['elden-ring']).toEqual(['eldenring.exe']);
    expect(c.recents).toHaveLength(1);
    expect(c.preferences.pollIntervalMs).toBe(5000);
    expect(c.preferences.catalogRefreshOnLaunch).toBe(false);
  });

  it('backs up corrupt file and returns defaults', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{ this is not json');
    const onCorrupt = vi.fn();
    const c = await getConfigFrom(path, { onCorrupt });
    expect(c.schemaVersion).toBe(1);
    expect(c.recents).toEqual([]);
    expect(onCorrupt).toHaveBeenCalledTimes(1);
    const arg = onCorrupt.mock.calls[0]![0]! as string;
    expect(arg).toMatch(/\.corrupt-/);
    const files = await readdir(dir);
    expect(files.find(f => f.includes('.corrupt-'))).toBeTruthy();
  });

  it('rejects schema-mismatched file by treating it as corrupt', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, recents: 'not-an-array' }));
    const onCorrupt = vi.fn();
    const c = await getConfigFrom(path, { onCorrupt });
    expect(c.recents).toEqual([]);
    expect(onCorrupt).toHaveBeenCalledOnce();
  });
});

describe('user-config updateConfigFrom', () => {
  it('deep-merges a partial patch', async () => {
    const path = join(dir, 'config.json');
    const next = await updateConfigFrom(path, {
      preferences: { pollIntervalMs: 1234 },
      processNameOverrides: { 'foo': ['foo.exe'] },
    });
    expect(next.preferences.pollIntervalMs).toBe(1234);
    expect(next.preferences.theme).toBe('dark');                 // untouched default
    expect(next.preferences.catalogRefreshOnLaunch).toBe(true);   // untouched default
    expect(next.processNameOverrides['foo']).toEqual(['foo.exe']);
  });

  it('writes the file atomically (no .tmp lingers on success)', async () => {
    const path = join(dir, 'config.json');
    await updateConfigFrom(path, { preferences: { pollIntervalMs: 3000 } });
    const files = await readdir(dir);
    expect(files).toContain('config.json');
    expect(files.find(f => f.startsWith('config.json.tmp-'))).toBeUndefined();
    const round = await getConfigFrom(path);
    expect(round.preferences.pollIntervalMs).toBe(3000);
  });

  it('replaces array fields rather than concatenating', async () => {
    const path = join(dir, 'config.json');
    await updateConfigFrom(path, {
      recents: [{ id: 'a', name: 'A', openedAt: '2026-05-09T00:00:00Z', source: 'catalog' }],
    });
    const next = await updateConfigFrom(path, {
      recents: [{ id: 'b', name: 'B', openedAt: '2026-05-09T00:01:00Z', source: 'catalog' }],
    });
    expect(next.recents.map(r => r.id)).toEqual(['b']);
  });

  it('rejects invalid pollIntervalMs (out of range)', async () => {
    const path = join(dir, 'config.json');
    await expect(updateConfigFrom(path, { preferences: { pollIntervalMs: 100 } }))
      .rejects.toThrow();
  });
});
