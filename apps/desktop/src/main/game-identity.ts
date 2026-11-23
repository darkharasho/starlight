// apps/desktop/src/main/game-identity.ts
//
// Maps a running process to the identity the game page and saved user cheats
// use: a key/name, Steam app id, Steam build id and a hash of the exe.
import { createReadStream } from 'node:fs';
import { readFile, readlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, sep } from 'node:path';
import type { DetectedGame } from '../shared/ipc.js';
import { gameKey } from '../shared/game-key.js';
import { identifyProcess, type CatalogEntry } from './game-matcher.js';
import { readExeName } from './proc-exe-name.js';
import { parseVdf } from './vdf.js';

export const EXE_HASH_LIMIT = 1024 ** 3;

export interface GameIdentity {
  pid: number;
  name: string;
  key: string;
  exeName: string;
  proton: boolean;
  steamAppId: number | null;
  buildId: string | null;
  exeHash: string | null;
  catalogId: string | null;
}

export interface IdentityDeps {
  catalogIndex(): Map<string, CatalogEntry>;
  detectedGames(): DetectedGame[];
  readEnviron?(pid: number): Promise<string>;
  readText?(path: string): Promise<string>;
  readMaps?(pid: number): Promise<string>;
  exePath?(pid: number): Promise<string>;
  fileSize?(path: string): Promise<number>;
  hashFile?(path: string): Promise<string>;
  /** Full exe name of the process (defaults to /proc/<pid>/cmdline). */
  exeName?(pid: number): Promise<string | undefined>;
}

export function parseAppManifest(text: string): { appId: number; buildId: string } | null {
  const state = parseVdf(text)['AppState'];
  if (!state || typeof state === 'string') return null;
  const appId = Number(state['appid']);
  const buildId = state['buildid'];
  if (!Number.isInteger(appId) || appId <= 0 || typeof buildId !== 'string' || !buildId) return null;
  return { appId, buildId };
}

export function steamappsDirFor(o: { compatDataPath?: string; exePath?: string }): string | null {
  if (o.compatDataPath) {
    const parts = o.compatDataPath.replace(/\/+$/, '').split('/');
    if (parts.length >= 3 && parts[parts.length - 2] === 'compatdata' && parts[parts.length - 3] === 'steamapps') {
      return parts.slice(0, -2).join('/');
    }
  }
  if (o.exePath) {
    const parts = o.exePath.split(/[/\\]/);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (parts[i] === 'steamapps') return parts.slice(0, i + 1).join('/');
    }
  }
  return null;
}

function parseEnviron(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split('\0')) {
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return map;
}

function toAppId(v: string | undefined): number | null {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const defaultHashFile = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });

/** The mapped `.exe` file whose basename is the process exe name (Proton). */
function mappedExe(maps: string, exeName: string): string | null {
  const want = exeName.toLowerCase();
  for (const line of maps.split('\n')) {
    const i = line.indexOf('/');
    if (i === -1) continue;
    const path = line.slice(i).replace(/ \(deleted\)$/, '');
    if (/\.exe$/i.test(path) && basename(path).toLowerCase() === want) return path;
  }
  return null;
}

function within(dir: string, file: string): boolean {
  const d = dir.endsWith(sep) ? dir : dir + sep;
  return file.startsWith(d);
}

export async function identifyGame(pid: number, deps: IdentityDeps, o?: { hash?: boolean }): Promise<GameIdentity> {
  const readEnviron = deps.readEnviron ?? ((p: number) => readFile(`/proc/${p}/environ`, 'utf8'));
  const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'));
  const readMaps = deps.readMaps ?? ((p: number) => readFile(`/proc/${p}/maps`, 'utf8'));
  const exePathOf = deps.exePath ?? ((p: number) => readlink(`/proc/${p}/exe`));
  const fileSize = deps.fileSize ?? (async (p: string) => (await stat(p)).size);
  const hashFile = deps.hashFile ?? defaultHashFile;

  const env = await readEnviron(pid).then(parseEnviron, () => new Map<string, string>());
  const compatDataPath = env.get('STEAM_COMPAT_DATA_PATH');
  const procExe = await exePathOf(pid).catch(() => '');

  const exeName =
    (await (deps.exeName ? deps.exeName(pid) : readExeName(pid)).catch(() => undefined)) ||
    (procExe ? basename(procExe) : '') ||
    `pid-${pid}`;

  // The file that holds the game's code: the mapped .exe under Proton.
  // STEAM_COMPAT_DATA_PATH is also set for native games run through the Steam
  // Linux Runtime, so Proton needs a Windows exe or the wine loader mapped too.
  let proton = false;
  let exeFile: string | null = procExe || null;
  if (compatDataPath) {
    const maps = await readMaps(pid).catch(() => '');
    proton = /\.exe\s*$|\/wine(64)?(-preloader)?\s*$|ntdll\.(so|dll)\s*$/im.test(maps);
    if (proton) exeFile = mappedExe(maps, exeName);
  }

  const fromCompat = compatDataPath ? toAppId(basename(compatDataPath.replace(/\/+$/, ''))) : null;
  const steamAppId =
    fromCompat ?? toAppId(env.get('SteamAppId')) ?? toAppId(env.get('SteamGameId')) ?? toAppId(env.get('STEAM_COMPAT_APP_ID'));

  let buildId: string | null = null;
  if (steamAppId != null) {
    const dir = steamappsDirFor({
      ...(compatDataPath ? { compatDataPath } : {}),
      ...((exeFile ?? procExe) ? { exePath: (exeFile ?? procExe)! } : {}),
    });
    if (dir) {
      try {
        const m = parseAppManifest(await readText(join(dir, `appmanifest_${steamAppId}.acf`)));
        if (m && m.appId === steamAppId) buildId = m.buildId;
      } catch { /* no manifest */ }
    }
  }

  const games = deps.detectedGames();
  const catalog = await identifyProcess(
    { pid, name: exeName },
    { catalogIndex: deps.catalogIndex(), detectedGames: games, readProtonAppId: async () => steamAppId },
  ).catch(() => null);

  const installed = steamAppId != null ? games.find((g) => g.appId === String(steamAppId)) : undefined;
  const byDir = exeFile ? games.find((g) => g.installDir && within(g.installDir, exeFile!)) : undefined;
  const name = catalog?.name ?? installed?.name ?? byDir?.name ?? exeName.replace(/\.exe$/i, '');

  let exeHash: string | null = null;
  if (o?.hash !== false && exeFile) {
    try {
      if ((await fileSize(exeFile)) <= EXE_HASH_LIMIT) exeHash = await hashFile(exeFile);
    } catch { exeHash = null; }
  }

  return {
    pid,
    name,
    key: gameKey(name).slice(0, 80),
    exeName,
    proton,
    steamAppId,
    buildId,
    exeHash,
    catalogId: catalog?.id ?? null,
  };
}
