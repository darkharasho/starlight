// Community cheats: the approved files under packages/catalog/community/, the
// index the Pages build publishes for them, catalog entries for games that
// only have community cheats, and the check a submission pull request must pass.
import {
  checkShareRules, shareFlags, shareHash, shareSummary, type CommunityCheatFile, type SharePlatform,
} from '@starlight/ct-importer';
import { z } from 'zod';
import type { CatalogIndex, CatalogIndexEntry } from './schema.js';
import { allocateId } from './slug.js';

export const COMMUNITY_DIR = 'packages/catalog/community/';
export const SUMMARY_START = '<!-- starlight-summary -->';
export const SUMMARY_END = '<!-- /starlight-summary -->';

const CommunityCheatMeta = z.object({
  file: z.string(),
  hash: z.string().regex(/^[0-9a-f]{12}$/),
  name: z.string(),
  platform: z.enum(['linux', 'windows']),
  bits: z.union([z.literal(32), z.literal(64)]),
  buildId: z.string().optional(),
  submittedAt: z.string(),
  credit: z.string().optional(),
  /** A repair: the community cheat it is based on, and that cheat's credit. */
  derivedFrom: z.string().optional(),
  derivedCredit: z.string().optional(),
});

export const CommunityIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  games: z.array(z.object({ steamAppId: z.number().int(), name: z.string(), cheats: z.array(CommunityCheatMeta) })),
});
export type CommunityIndex = z.infer<typeof CommunityIndexSchema>;
export type CommunityCheatMeta = z.infer<typeof CommunityCheatMeta>;

/** Checks one file, given its path relative to the community folder ("<appId>/<hash12>.json"). */
async function checkFile(path: string, text: string): Promise<{ ok: true; file: CommunityCheatFile; hash: string } | { ok: false; error: string }> {
  const m = /^(\d+)\/([0-9a-f]{12})\.json$/.exec(path);
  if (!m) return { ok: false, error: `${path}: must be <steamAppId>/<hash12>.json` };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: `${path}: not valid JSON` }; }
  const checked = checkShareRules(raw);
  if (!checked.ok) return { ok: false, error: `${path}: ${checked.errors.join('; ')}` };
  const f = checked.file;
  if (String(f.game.steamAppId) !== m[1]) return { ok: false, error: `${path}: folder doesn't match the game's Steam app id ${f.game.steamAppId}` };
  const hash = (await shareHash(f)).slice(0, 12);
  if (hash !== m[2]) return { ok: false, error: `${path}: file name doesn't match the cheat's hash ${hash}` };
  return { ok: true, file: f, hash };
}

export async function buildCommunity(
  files: Array<{ path: string; text: string }>,
  catalog: CatalogIndex,
  now: Date,
): Promise<{ index: CommunityIndex; catalog: CatalogIndex; errors: string[] }> {
  const errors: string[] = [];
  const games = new Map<number, { steamAppId: number; name: string; cheats: CommunityCheatMeta[] }>();
  for (const { path, text } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const r = await checkFile(path, text);
    if (!r.ok) { errors.push(r.error); continue; }
    const f = r.file;
    let g = games.get(f.game.steamAppId);
    if (!g) { g = { steamAppId: f.game.steamAppId, name: f.game.name, cheats: [] }; games.set(g.steamAppId, g); }
    g.cheats.push({
      file: path, hash: r.hash, name: f.cheat.name, platform: f.game.platform, bits: f.game.bits,
      ...(f.game.buildId ? { buildId: f.game.buildId } : {}),
      submittedAt: f.submittedAt,
      ...(f.credit ? { credit: f.credit } : {}),
      ...(f.derivedFrom ? { derivedFrom: f.derivedFrom } : {}),
      ...(f.derivedCredit ? { derivedCredit: f.derivedCredit } : {}),
    });
  }

  const taken = new Set(catalog.games.map((g) => g.id));
  const known = new Set(catalog.games.map((g) => g.steamAppId).filter((id): id is number => id !== null));
  const added: CatalogIndexEntry[] = [];
  for (const g of [...games.values()].sort((a, b) => a.steamAppId - b.steamAppId)) {
    if (known.has(g.steamAppId)) continue;
    const id = allocateId(g.name, taken);
    taken.add(id);
    const platforms: SharePlatform[] = [];
    for (const c of g.cheats) if (!platforms.includes(c.platform)) platforms.push(c.platform);
    const platform = (['windows', 'linux'] as const).filter((p) => platforms.includes(p));
    added.push({ id, name: g.name, steamAppId: g.steamAppId, processName: [], platform: [...platform], communityOnly: true });
  }

  return {
    index: { schemaVersion: 1, generatedAt: now.toISOString(), games: [...games.values()].sort((a, b) => a.steamAppId - b.steamAppId) },
    catalog: { ...catalog, games: [...catalog.games, ...added] },
    errors,
  };
}

/** Problems with a community submission pull request; empty when it may be merged. */
export async function checkCommunityPr(
  changes: Array<{ status: string; path: string }>,
  files: Map<string, string>,
  prBody: string,
): Promise<string[]> {
  if (changes.length !== 1) return [`a community submission adds exactly one file (this pull request changes ${changes.length})`];
  const [c] = changes as [{ status: string; path: string }];
  if (c.status !== 'A') return [`${c.path}: community cheats are only ever added, never changed`];
  if (!c.path.startsWith(COMMUNITY_DIR)) return [`${c.path}: only files under ${COMMUNITY_DIR} can be submitted`];
  const text = files.get(c.path);
  if (text === undefined) return [`${c.path}: file not found`];
  const r = await checkFile(c.path.slice(COMMUNITY_DIR.length), text);
  if (!r.ok) return [r.error];
  const start = prBody.indexOf(SUMMARY_START);
  const end = prBody.indexOf(SUMMARY_END);
  if (start < 0 || end < start) return ['the pull request description has no summary'];
  const shown = prBody.slice(start + SUMMARY_START.length, end).replace(/\r\n/g, '\n').trim();
  const expected = shareSummary(r.file, shareFlags(r.file)).trim();
  return shown === expected ? [] : ["the pull request's summary doesn't match the cheat file; it must describe exactly this file"];
}
