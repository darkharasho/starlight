// apps/desktop/src/main/agent/tools-library.ts
//
// save_cheat and list_cheats: the agent's route into the player's cheat
// library. save_cheat refuses anything that doesn't match the running game
// and stamps the cheat with where it came from.
import { z } from 'zod';
import { verifyCheat } from '@starlight/engine';
import type { VerifyResult } from '@starlight/engine';
import { validateAgentCheat } from '@starlight/ct-importer';
import type { StarlightCheat, StarlightProvenance, StarlightTrainer } from '@starlight/ct-importer';
import { loadUserTrainer, saveUserCheat } from '../user-cheats.js';
import type { GameIdentity } from '../game-identity.js';
import { ToolError, live, need, type ToolDef } from './tools.js';

export interface LibraryToolsDeps {
  dir: string;
  catalogTrainerFor(game: GameIdentity): Promise<StarlightTrainer | null>;
  /** Tells the game page its library changed (`userCheats:changed`). */
  onSaved(key: string): void;
  verify?: typeof verifyCheat;
  now?(): Date;
}

const UNVERIFIED: VerifyResult = { status: 'unverified', reasons: [] };

const isUnsupported = (c: StarlightCheat): c is Extract<StarlightCheat, { unsupported: true }> =>
  'unsupported' in c && c.unsupported === true;

function addressText(c: StarlightCheat): string | undefined {
  if (isUnsupported(c)) return undefined;
  const a = c.type === 'patch' ? c.site : c.address;
  switch (a.kind) {
    case 'absolute': return a.address;
    case 'module': return `${a.module}+${a.offset}`;
    case 'aob': return `aob ${a.module} ${a.pattern}${a.offset ? ` +${a.offset}` : ''}`;
    case 'pointer': return `${a.module ?? 'target'}+${a.baseOffset} → ${a.offsets.join(' → ')}`;
  }
}

export function libraryTools(deps: LibraryToolsDeps): ToolDef<any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const verify = deps.verify ?? verifyCheat;
  const now = deps.now ?? (() => new Date());

  const saveInput = {
    cheat: z.record(z.string(), z.unknown()).describe('A value or patch cheat (Starlight format, without id). Value cheats need verify.range.'),
    replaces: z.string().optional().describe('The id of a cheat in the library to repair in place.'),
    category: z.string().max(40).optional().describe('The category to file it under; default "My cheats".'),
  };
  const saveTool: ToolDef<typeof saveInput> = {
    name: 'save_cheat',
    title: 'Save a cheat',
    description:
      "Saves a cheat to the player's library for this game, after checking it against the running game. " +
      'Test it first with test_cheat. Use replaces to repair a cheat that stopped working.',
    tier: 'attached', readOnly: false, input: saveInput,
    async run(args, ctx) {
      const checked = validateAgentCheat(args.cheat);
      if (!checked.ok) throw new ToolError(checked.errors.join('\n'));
      let a = need(ctx);
      const draft = { ...checked.cheat, id: 'agent-draft' } as unknown as StarlightCheat;
      const result = await verify(a.session, draft);
      if (result.status === 'needs-update') {
        throw new ToolError("This cheat doesn't match the running game: " + result.reasons.join('; '));
      }
      a = live(ctx);
      const g = a.game;
      const provenance: StarlightProvenance = {
        kind: 'agent',
        agent: `${a.client.name} ${a.client.version}`,
        createdAt: now().toISOString(),
        game: {
          ...(g.steamAppId !== null ? { steamAppId: g.steamAppId } : {}),
          ...(g.buildId !== null ? { buildId: g.buildId } : {}),
          ...(g.exeHash !== null ? { exeHash: g.exeHash } : {}),
        },
      };
      const o: { category?: string; replaces?: string } = {};
      if (args.category !== undefined) o.category = args.category;
      if (args.replaces !== undefined) o.replaces = args.replaces;
      let id: string;
      try {
        ({ id } = await saveUserCheat(
          deps.dir, g.key,
          { name: g.name, exeName: g.exeName, proton: g.proton, steamAppId: g.steamAppId },
          { ...checked.cheat, provenance }, o,
        ));
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      deps.onSaved(g.key);
      return { saved: { id, name: checked.cheat.name, game: g.name }, verify: result };
    },
    summarize: (args, result) => {
      const r = result as { saved: { name: string; game: string } };
      return `save_cheat "${r.saved?.name ?? String((args.cheat as { name?: unknown }).name ?? '')}" → ${r.saved?.game ?? ''}`;
    },
  };

  const listInput = {
    source: z.enum(['all', 'library', 'catalog']).optional().describe('Which cheats to list; default all.'),
    offset: z.number().int().min(0).optional().describe('Paging offset, applied to each list; default 0.'),
    limit: z.number().int().min(1).max(200).optional().describe('Cheats per list; default 50.'),
  };
  const listTool: ToolDef<typeof listInput> = {
    name: 'list_cheats',
    title: 'List cheats',
    description: "Lists the cheats the player has saved for this game and the catalog's cheats for it, each checked against the running game.",
    tier: 'attached', readOnly: true, input: listInput,
    async run(args, ctx) {
      const a = need(ctx);
      const source = args.source ?? 'all';
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const flat = (t: StarlightTrainer | null): StarlightCheat[] => (t ? t.categories.flatMap((c) => c.cheats) : []);
      const page = (all: StarlightCheat[]): StarlightCheat[] => all.slice(offset, offset + limit);
      const check = async (c: StarlightCheat): Promise<VerifyResult> => {
        if (isUnsupported(c)) return UNVERIFIED;
        try { return await verify(a.session, c); } catch { return UNVERIFIED; }
      };

      const libAll = source === 'catalog' ? [] : flat(await loadUserTrainer(deps.dir, a.game.key));
      const catAll = source === 'library' ? [] : flat(await deps.catalogTrainerFor(a.game).catch(() => null));

      const library = await Promise.all(page(libAll).map(async (c) => ({
        id: c.id, name: c.name, type: isUnsupported(c) ? 'unsupported' : c.type, verify: await check(c), cheat: c,
      })));
      const catalog = await Promise.all(page(catAll).map(async (c) => {
        if (isUnsupported(c)) return { id: c.id, name: c.name, unsupported: c.unsupportedReason, verify: UNVERIFIED };
        const address = addressText(c);
        return { id: c.id, name: c.name, type: c.type, ...(address !== undefined ? { address } : {}), verify: await check(c) };
      }));
      return {
        game: { key: a.game.key, name: a.game.name, buildId: a.game.buildId },
        library: { count: libAll.length, cheats: library },
        catalog: { count: catAll.length, cheats: catalog },
      };
    },
    summarize: (_args, result) => {
      const r = result as { library: { count: number }; catalog: { count: number } };
      return `list_cheats → ${r.library.count} saved, ${r.catalog.count} catalog`;
    },
  };

  return [saveTool, listTool];
}
