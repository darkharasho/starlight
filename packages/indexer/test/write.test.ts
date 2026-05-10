import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTrainer, writeIndex } from '../src/write.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-write-test-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const sampleTrainer = {
  schemaVersion: 1 as const,
  id: 'demo',
  game: { name: 'Demo', processName: ['demo.exe'], platform: ['windows'] as ('windows'|'linux'|'macos')[] },
  metadata: { source: { convertedFrom: '.CT' as const, url: 'https://example.com/demo' }, convertedAt: '2026-05-09T00:00:00Z' },
  categories: [{ name: 'Player', cheats: [] }],
};

describe('writeTrainer', () => {
  it('writes trainer JSON to <dir>/trainers/<id>.json', async () => {
    await writeTrainer(dir, 'demo', sampleTrainer);
    const text = await readFile(join(dir, 'trainers', 'demo.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ id: 'demo' });
  });

  it('rejects writes that fail schema validation', async () => {
    const bad = { ...sampleTrainer, schemaVersion: 99 } as never;
    await expect(writeTrainer(dir, 'demo', bad)).rejects.toThrow();
  });
});

describe('writeIndex', () => {
  it('writes index.json with sorted games + generatedAt', async () => {
    await writeIndex(dir, [
      { id: 'b', name: 'B', steamAppId: 2, processName: ['b.exe'], platform: ['windows'],
        trainerPath: 'trainers/b.json' },
      { id: 'a', name: 'A', steamAppId: 1, processName: ['a.exe'], platform: ['windows'],
        trainerPath: 'trainers/a.json' },
    ]);
    const text = await readFile(join(dir, 'index.json'), 'utf8');
    const idx = JSON.parse(text);
    expect(idx.schemaVersion).toBe(1);
    expect(typeof idx.generatedAt).toBe('string');
    expect(idx.games.map((g: { id: string }) => g.id)).toEqual(['a', 'b']);
  });

  it('rejects entries that fail schema validation', async () => {
    await expect(writeIndex(dir, [
      { id: '', name: '', steamAppId: null, processName: [], platform: [], trainerPath: 'bad' } as never,
    ])).rejects.toThrow();
  });
});
