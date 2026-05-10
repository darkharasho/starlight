import { describe, it, expect } from 'vitest';
import { readSeeds } from '../src/seeds.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX = join(__dirname, 'fixtures', 'seeds.yaml');

describe('readSeeds', () => {
  it('parses a valid seeds.yaml', async () => {
    const seeds = await readSeeds(FIX);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toMatchObject({
      url: 'https://example.com/elden-ring.zip',
      name: 'Elden Ring',
      steamAppId: 1245620,
      processName: ['eldenring.exe'],
      platform: ['windows'],
      tags: ['souls', 'rpg'],
    });
    expect(seeds[1]!.tags).toBeUndefined();
  });

  it('returns empty array when games is empty', async () => {
    const empty = join(__dirname, 'fixtures', 'empty-seeds.yaml');
    const fs = await import('node:fs/promises');
    await fs.writeFile(empty, 'games: []\n');
    try {
      expect(await readSeeds(empty)).toEqual([]);
    } finally {
      await fs.unlink(empty);
    }
  });

  it('rejects entry missing required fields', async () => {
    const bad = join(__dirname, 'fixtures', 'bad-seeds.yaml');
    const fs = await import('node:fs/promises');
    await fs.writeFile(bad, 'games:\n  - name: only-name\n');
    try {
      await expect(readSeeds(bad)).rejects.toThrow(/url/i);
    } finally {
      await fs.unlink(bad);
    }
  });

  it('rejects empty processName array', async () => {
    const bad = join(__dirname, 'fixtures', 'empty-pn.yaml');
    const fs = await import('node:fs/promises');
    await fs.writeFile(bad, 'games:\n  - url: https://x\n    name: x\n    processName: []\n    platform: [windows]\n');
    try {
      await expect(readSeeds(bad)).rejects.toThrow(/processName/i);
    } finally {
      await fs.unlink(bad);
    }
  });

  it('rejects empty platform array', async () => {
    const bad = join(__dirname, 'fixtures', 'empty-pl.yaml');
    const fs = await import('node:fs/promises');
    await fs.writeFile(bad, 'games:\n  - url: https://x\n    name: x\n    processName: [x.exe]\n    platform: []\n');
    try {
      await expect(readSeeds(bad)).rejects.toThrow(/platform/i);
    } finally {
      await fs.unlink(bad);
    }
  });

  it('rejects malformed YAML', async () => {
    const bad = join(__dirname, 'fixtures', 'malformed.yaml');
    const fs = await import('node:fs/promises');
    await fs.writeFile(bad, 'games:\n  - this is not: valid\n  bad indent: x\n');
    try {
      await expect(readSeeds(bad)).rejects.toThrow();
    } finally {
      await fs.unlink(bad);
    }
  });

  it('throws when file does not exist', async () => {
    await expect(readSeeds('/nonexistent/seeds.yaml')).rejects.toThrow();
  });
});
