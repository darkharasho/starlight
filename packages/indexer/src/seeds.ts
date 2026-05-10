import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

export interface SeedEntry {
  url: string;
  name: string;
  steamAppId: number | null;
  processName: string[];
  platform: ('windows' | 'linux' | 'macos')[];
  tags?: string[];
}

interface RawSeed {
  url?: unknown;
  name?: unknown;
  steamAppId?: unknown;
  processName?: unknown;
  platform?: unknown;
  tags?: unknown;
}

export async function readSeeds(path: string): Promise<SeedEntry[]> {
  const text = await readFile(path, 'utf8');
  const doc: unknown = parseYaml(text);
  if (!doc || typeof doc !== 'object') throw new Error('seeds.yaml: top-level must be an object');
  const games = (doc as { games?: unknown }).games;
  if (!Array.isArray(games)) throw new Error('seeds.yaml: "games" must be an array');
  return games.map((raw, i) => validateEntry(raw, i));
}

function validateEntry(raw: unknown, index: number): SeedEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`seeds.yaml: entry ${index} is not an object`);
  }
  const r = raw as RawSeed;
  if (typeof r.url !== 'string' || r.url.length === 0) {
    throw new Error(`seeds.yaml: entry ${index} missing required "url"`);
  }
  if (typeof r.name !== 'string' || r.name.length === 0) {
    throw new Error(`seeds.yaml: entry ${index} missing required "name"`);
  }
  if (!Array.isArray(r.processName) || r.processName.some(p => typeof p !== 'string' || p.length === 0)) {
    throw new Error(`seeds.yaml: entry ${index} ("${r.name}") missing/invalid "processName"`);
  }
  if (!Array.isArray(r.platform) || r.platform.some(p => p !== 'windows' && p !== 'linux' && p !== 'macos')) {
    throw new Error(`seeds.yaml: entry ${index} ("${r.name}") "platform" must be array of windows|linux|macos`);
  }
  const out: SeedEntry = {
    url: r.url,
    name: r.name,
    steamAppId: typeof r.steamAppId === 'number' ? r.steamAppId : null,
    processName: r.processName as string[],
    platform: r.platform as SeedEntry['platform'],
  };
  if (Array.isArray(r.tags) && r.tags.every(t => typeof t === 'string')) {
    out.tags = r.tags as string[];
  }
  return out;
}
