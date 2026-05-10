import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EpicScanner } from '../../src/main/library-host.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX = join(__dirname, '..', 'fixtures', 'epic');

let manifestsDir: string;

beforeAll(async () => {
  manifestsDir = join(tmpdir(), `starlight-epic-${Date.now()}`, 'Manifests');
  await mkdir(manifestsDir, { recursive: true });
  await copyFile(join(FIX, 'Manifests', 'tf2.item'), join(manifestsDir, 'tf2.item'));
  await copyFile(join(FIX, 'Manifests', 'csgo.item'), join(manifestsDir, 'csgo.item'));
});

afterAll(async () => {
  await rm(dirname(manifestsDir), { recursive: true, force: true });
});

describe('EpicScanner', () => {
  it('reads each manifest and yields a DetectedGame', async () => {
    const s = new EpicScanner({ manifestsResolver: async () => manifestsDir });
    const games = await s.scan();
    expect(games).toHaveLength(2);
    const byName = Object.fromEntries(games.map(g => [g.name, g]));
    expect(byName['Team Fortress 2']).toMatchObject({
      source: 'epic',
      name: 'Team Fortress 2',
      installDir: '/games/Team Fortress 2',
      appId: 'TeamFortress2',
    });
    expect(byName['Counter-Strike 2']).toMatchObject({
      source: 'epic',
      name: 'Counter-Strike 2',
      installDir: '/games/CSGO',
      appId: 'CounterStrike2',
    });
  });

  it('returns [] when manifests directory cannot be resolved', async () => {
    const s = new EpicScanner({ manifestsResolver: async () => null });
    expect(await s.scan()).toEqual([]);
  });

  it('returns [] when manifests directory does not exist', async () => {
    const fake = join(tmpdir(), `starlight-epic-missing-${Date.now()}`);
    const s = new EpicScanner({ manifestsResolver: async () => fake });
    expect(await s.scan()).toEqual([]);
  });

  it('skips files that are not valid JSON', async () => {
    const dir = join(tmpdir(), `starlight-epic-bad-${Date.now()}`, 'Manifests');
    await mkdir(dir, { recursive: true });
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(dir, 'good.item'), JSON.stringify({
      AppName: 'Good', DisplayName: 'Good', InstallLocation: '/g', LaunchExecutable: 'g.exe',
    }));
    await fs.writeFile(join(dir, 'bad.item'), 'not json {');
    const s = new EpicScanner({ manifestsResolver: async () => dir });
    const games = await s.scan();
    expect(games).toHaveLength(1);
    expect(games[0]!.name).toBe('Good');
    await rm(dirname(dir), { recursive: true, force: true });
  });

  it('skips manifests missing required fields', async () => {
    const dir = join(tmpdir(), `starlight-epic-incomplete-${Date.now()}`, 'Manifests');
    await mkdir(dir, { recursive: true });
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(dir, 'incomplete.item'), JSON.stringify({ AppName: 'NoName' }));
    const s = new EpicScanner({ manifestsResolver: async () => dir });
    expect(await s.scan()).toEqual([]);
    await rm(dirname(dir), { recursive: true, force: true });
  });
});
