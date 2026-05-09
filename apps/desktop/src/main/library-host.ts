import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseVdf } from './vdf.js';
import type { DetectedGame } from '../shared/ipc.js';

const execFileAsync = promisify(execFile);

export interface LibraryScanner {
  readonly source: DetectedGame['source'];
  scan(): Promise<DetectedGame[]>;       // never throws
}

export interface SteamScannerOpts {
  rootResolver?: () => Promise<string | null>;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function defaultSteamRoot(): Promise<string | null> {
  const home = homedir();
  const candidates: string[] = [];
  switch (platform()) {
    case 'linux':
      candidates.push(
        join(home, '.steam', 'steam'),
        join(home, '.local', 'share', 'Steam'),
        join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam'),
      );
      break;
    case 'darwin':
      candidates.push(join(home, 'Library', 'Application Support', 'Steam'));
      break;
    case 'win32': {
      const pf86 = process.env['ProgramFiles(x86)'];
      if (pf86) candidates.push(join(pf86, 'Steam'));
      // Registry fallback: query HKCU first, then HKLM
      const queries: Array<[string, string]> = [
        ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
        ['HKLM\\Software\\Valve\\Steam', 'InstallPath'],
      ];
      for (const [key, value] of queries) {
        try {
          const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', value]);
          const m = stdout.match(/(?:SteamPath|InstallPath)\s+REG_SZ\s+(.+)\s*$/m);
          if (m?.[1]) { candidates.push(m[1].trim()); break; }
        } catch { /* registry miss is fine */ }
      }
      break;
    }
  }
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

export class SteamScanner implements LibraryScanner {
  readonly source = 'steam' as const;
  private readonly resolver: () => Promise<string | null>;
  constructor(opts: SteamScannerOpts = {}) {
    this.resolver = opts.rootResolver ?? defaultSteamRoot;
  }
  async scan(): Promise<DetectedGame[]> {
    try {
      const root = await this.resolver();
      if (!root) return [];
      const lfPath = join(root, 'steamapps', 'libraryfolders.vdf');
      if (!(await exists(lfPath))) return [];
      const lfXml = await readFile(lfPath, 'utf8');
      const lf = parseVdf(lfXml);
      const folders = (lf['libraryfolders'] && typeof lf['libraryfolders'] === 'object')
        ? lf['libraryfolders'] as Record<string, { path?: string } | string>
        : null;
      if (!folders) return [];
      const libraryPaths: string[] = [];
      for (const v of Object.values(folders)) {
        if (typeof v === 'object' && v && typeof (v as { path?: unknown }).path === 'string') {
          libraryPaths.push((v as { path: string }).path);
        }
      }
      const games: DetectedGame[] = [];
      for (const lib of libraryPaths) {
        const sa = join(lib, 'steamapps');
        if (!(await exists(sa))) continue;
        let entries: string[];
        try { entries = await readdir(sa); } catch { continue; }
        for (const f of entries) {
          if (!f.startsWith('appmanifest_') || !f.endsWith('.acf')) continue;
          try {
            const m = parseVdf(await readFile(join(sa, f), 'utf8'));
            const state = m['AppState'];
            if (typeof state !== 'object' || !state) continue;
            const appId = (state as Record<string, unknown>)['appid'];
            const name = (state as Record<string, unknown>)['name'];
            const installdir = (state as Record<string, unknown>)['installdir'];
            if (typeof appId !== 'string' || typeof name !== 'string' || typeof installdir !== 'string') continue;
            games.push({
              source: 'steam',
              appId,
              name,
              installDir: join(lib, 'steamapps', 'common', installdir),
            });
          } catch { /* skip bad manifest */ }
        }
      }
      return games;
    } catch {
      return [];
    }
  }
}

// Phase 5 stubs — interface conforms; scan returns []. Do not delete; the registry below
// exercises the pluggability and these will be filled in later phases.
class EpicScanner implements LibraryScanner {
  readonly source = 'steam' as const;  // TODO: Phase 5 — change union and add 'epic'
  async scan(): Promise<DetectedGame[]> { return []; }
}
class HeroicScanner implements LibraryScanner {
  readonly source = 'steam' as const;  // TODO: Phase 5
  async scan(): Promise<DetectedGame[]> { return []; }
}
class LutrisScanner implements LibraryScanner {
  readonly source = 'steam' as const;  // TODO: Phase 5
  async scan(): Promise<DetectedGame[]> { return []; }
}

const defaultScanners: LibraryScanner[] = [
  new SteamScanner(),
  new EpicScanner(),
  new HeroicScanner(),
  new LutrisScanner(),
];

export async function scanAll(scanners: LibraryScanner[] = defaultScanners): Promise<DetectedGame[]> {
  const settled = await Promise.all(scanners.map(s => s.scan().catch(() => [] as DetectedGame[])));
  return settled.flat();
}
