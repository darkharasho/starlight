import { parseCt, type CtEntry } from './xml-parser.js';
import { convertEntry } from './entry-converter.js';
import { emptyStats, type ImportStats } from './stats.js';
import type {
  StarlightTrainer,
  StarlightCategory,
  StarlightCheat,
} from './starlight-format.js';

export interface ImportOptions {
  gameName: string;
  processName: string[];
  steamAppId?: number;
  version?: string;
  platform?: ('windows' | 'linux' | 'linux-proton' | 'macos')[];
  sourceUrl?: string;
}

export interface ImportResult {
  trainer: StarlightTrainer;
  stats: ImportStats;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function importCt(xml: string, opts: ImportOptions): ImportResult {
  const root = parseCt(xml);
  const top = asArray(root.CheatTable.CheatEntries.CheatEntry);
  const stats = emptyStats();
  const categories: StarlightCategory[] = [];
  const generalCheats: StarlightCheat[] = [];

  function walkAt(entry: CtEntry, intoCheats: StarlightCheat[]): void {
    const r = convertEntry(entry);
    if (r.kind === 'category') {
      const childCheats: StarlightCheat[] = [];
      for (const c of r.children) walkAt(c, childCheats);
      categories.push({ name: r.name, cheats: childCheats });
      stats.categories += 1;
    } else {
      intoCheats.push(r.cheat);
      stats.total += 1;
      if ('unsupported' in r.cheat && r.cheat.unsupported) stats.unsupported += 1;
      else stats.supported += 1;
    }
  }

  for (const entry of top) walkAt(entry, generalCheats);

  if (generalCheats.length > 0) {
    categories.unshift({ name: 'General', cheats: generalCheats });
    stats.categories += 1;
  }

  const trainer: StarlightTrainer = {
    schemaVersion: 1,
    id: `starlight-${slugify(opts.gameName)}-${Date.now()}`,
    game: {
      name: opts.gameName,
      processName: opts.processName,
      platform: opts.platform ?? ['windows'],
      ...(opts.steamAppId !== undefined ? { steamAppId: opts.steamAppId } : {}),
      ...(opts.version ? { version: opts.version } : {}),
    },
    metadata: {
      source: {
        convertedFrom: '.CT',
        ...(opts.sourceUrl ? { url: opts.sourceUrl } : {}),
      },
      convertedAt: new Date().toISOString(),
    },
    categories,
  };

  return { trainer, stats };
}
