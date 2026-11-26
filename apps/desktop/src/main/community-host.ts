// Community cheats: approved shared cheats published with the catalog. This
// fetches and caches the community index and files, picks the versions that
// fit the player's game, and presents them as a trainer the user-cheats host
// can run like the player's own (verify check, anti-cheat refusal and all).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CommunityCheatFileSchema, type SharePlatform, type StarlightCheat, type StarlightTrainer } from '@starlight/ct-importer';
import { CommunityIndexSchema, type CommunityIndex, type CommunityCheatMeta } from '@starlight/catalog/community';
import type { IpcResult, UserCheatView } from '../shared/ipc.js';
import { saveUserCheat, type UserCheatDraft } from './user-cheats.js';

export const COMMUNITY_BASE = 'https://darkharasho.github.io/starlight/catalog/';
const PREFIX = 'community-';

export type CommunityView = NonNullable<UserCheatView['community']>;
export interface CommunityContext { platform: SharePlatform | null; bits: 32 | 64 | null; buildId: string | null }

export const communityKey = (steamAppId: number): string => `${PREFIX}${steamAppId}`;
export const isCommunityKey = (key: string): boolean => key.startsWith(PREFIX) && /^\d+$/.test(key.slice(PREFIX.length));
export const communityAppId = (key: string): number => Number(key.slice(PREFIX.length));

/** One version per cheat (name, platform, bits) for this game; the rest are older versions, newest first. */
export function pickCommunityCheats(cheats: CommunityCheatMeta[], ctx: CommunityContext): { current: CommunityCheatMeta[]; older: CommunityCheatMeta[] } {
  const fits = cheats.filter((c) => (ctx.platform === null || c.platform === ctx.platform) && (ctx.bits === null || c.bits === ctx.bits));
  const groups = new Map<string, CommunityCheatMeta[]>();
  for (const c of fits) {
    const k = `${c.name}\0${c.platform}\0${c.bits}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const current: CommunityCheatMeta[] = [];
  const older: CommunityCheatMeta[] = [];
  for (const g of groups.values()) {
    const newest = [...g].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.hash.localeCompare(a.hash));
    const pick = (ctx.buildId !== null ? newest.find((c) => c.buildId === ctx.buildId) : undefined) ?? newest[0]!;
    current.push(pick);
    older.push(...newest.filter((c) => c !== pick));
  }
  return { current, older };
}

export interface CommunityHost {
  index(): Promise<CommunityIndex>;
  trainer(steamAppId: number, ctx: CommunityContext): Promise<{ trainer: StarlightTrainer; meta: Map<string, CommunityView> } | null>;
}

const EMPTY: CommunityIndex = { schemaVersion: 1, generatedAt: '1970-01-01T00:00:00.000Z', games: [] };

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

export function createCommunityHost(deps: { cacheDir: string; baseUrl?: string; fetch?: typeof fetch; minRefreshMs?: number; now?(): number }): CommunityHost {
  const base = (deps.baseUrl ?? COMMUNITY_BASE).replace(/\/?$/, '/');
  const fetchFn = deps.fetch ?? fetch;
  const minRefresh = deps.minRefreshMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const dir = join(deps.cacheDir, 'community');
  let memo: { at: number; index: CommunityIndex } | null = null;

  async function cachedIndex(): Promise<CommunityIndex | null> {
    try { return CommunityIndexSchema.parse(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))); } catch { return null; }
  }

  async function index(): Promise<CommunityIndex> {
    if (memo && now() - memo.at < minRefresh) return memo.index;
    let idx: CommunityIndex | null = null;
    try {
      const res = await fetchFn(`${base}community/index.json`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const text = await res.text();
        idx = CommunityIndexSchema.parse(JSON.parse(text));
        await writeAtomic(join(dir, 'index.json'), text);
      }
    } catch { /* offline or bad: fall back to the cache */ }
    idx ??= (await cachedIndex()) ?? memo?.index ?? EMPTY;
    memo = { at: now(), index: idx };
    return idx;
  }

  /** Files are named by their content hash, so a cached copy never goes stale. */
  async function file(path: string): Promise<StarlightCheat | null> {
    if (!/^\d+\/[0-9a-f]{12}\.json$/.test(path)) return null;
    const local = join(dir, path);
    let text = await readFile(local, 'utf8').catch(() => null);
    if (text === null) {
      try {
        const res = await fetchFn(`${base}community/${path}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        text = await res.text();
      } catch { return null; }
    }
    const parsed = CommunityCheatFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    await writeAtomic(local, text).catch(() => undefined);
    const f = parsed.data;
    const hash = path.slice(path.indexOf('/') + 1, -'.json'.length);
    return {
      ...f.cheat,
      id: `c-${hash}`,
      provenance: {
        kind: 'manual',
        ...(f.agent ? { agent: f.agent } : {}),
        createdAt: `${f.submittedAt}T00:00:00.000Z`,
        game: {
          steamAppId: f.game.steamAppId,
          ...(f.game.buildId ? { buildId: f.game.buildId } : {}),
          ...(f.game.exeHash ? { exeHash: f.game.exeHash } : {}),
        },
        bits: f.game.bits,
        derivedFrom: hash,
        ...(f.credit ? { derivedCredit: f.credit } : {}),
      },
    } as StarlightCheat;
  }

  return {
    index,
    async trainer(steamAppId, ctx) {
      const game = (await index()).games.find((g) => g.steamAppId === steamAppId);
      if (!game) return null;
      const { current, older } = pickCommunityCheats(game.cheats, ctx);
      const cheats: StarlightCheat[] = [];
      const meta = new Map<string, CommunityView>();
      for (const [list, isOlder] of [[current, false], [older, true]] as const) {
        for (const m of list) {
          const c = await file(m.file);
          if (!c) continue;
          cheats.push(c);
          meta.set(c.id, {
            credit: m.credit ?? null, buildId: m.buildId ?? null, platform: m.platform, bits: m.bits, older: isOlder,
            ...(m.derivedFrom ? { basedOn: { credit: m.derivedCredit ?? null } } : {}),
          });
        }
      }
      const platforms = [...new Set(game.cheats.map((c) => (c.platform === 'windows' ? 'linux-proton' : 'linux') as 'linux' | 'linux-proton'))];
      const trainer: StarlightTrainer = {
        schemaVersion: 2,
        id: communityKey(steamAppId),
        game: { name: game.name, steamAppId, processName: [], platform: platforms.length ? platforms : ['linux'] },
        metadata: { source: { convertedFrom: 'starlight' } },
        categories: [{ name: 'Community', cheats }],
      };
      return { trainer, meta };
    },
  };
}

/** "Save to my cheats": copies a community cheat into the player's library, marked as based on it. */
export async function saveCommunityCheat(
  deps: { dir: string; community: CommunityHost },
  req: { key: string; id: string; userKey: string; exeName?: string },
): Promise<IpcResult> {
  if (!isCommunityKey(req.key)) return { ok: false, error: 'That community cheat is no longer available.' };
  const r = await deps.community.trainer(communityAppId(req.key), { platform: null, bits: null, buildId: null });
  const cheat = r?.trainer.categories.flatMap((c) => c.cheats).find((c) => c.id === req.id);
  const m = r?.meta.get(req.id);
  if (!r || !cheat || !m || !('provenance' in cheat) || !cheat.provenance) return { ok: false, error: 'That community cheat is no longer available.' };
  const { id: _id, ...rest } = cheat;
  try {
    await saveUserCheat(deps.dir, req.userKey, {
      name: r.trainer.game.name,
      exeName: req.exeName ?? '',
      proton: m.platform === 'windows',
      steamAppId: r.trainer.game.steamAppId ?? null,
    }, { ...rest, provenance: { ...cheat.provenance, kind: 'manual' } } as UserCheatDraft);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}
