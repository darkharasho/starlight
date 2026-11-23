// apps/desktop/src/main/agent/tools-library.ts
//
// save_cheat and list_cheats: the agent's route into the player's cheat
// library. save_cheat refuses anything that doesn't match the running game
// and stamps the cheat with where it came from.
import { z } from 'zod';
import { readMany, resolveCheatAddress, verifyCheat } from '@starlight/engine';
import type { Session, VerifyResult } from '@starlight/engine';
import { AgentCheatDraftSchema, validateAgentCheat } from '@starlight/ct-importer';
import { CHEAT_DRAFT_HELP } from './instructions.js';
import type { AgentCheatDraft, StarlightCheat, StarlightPatchCheat, StarlightProvenance, StarlightTrainer } from '@starlight/ct-importer';
import { loadUserTrainer, saveUserCheat } from '../user-cheats.js';
import type { GameIdentity } from '../game-identity.js';
import { ToolError, live, need, type ToolDef } from './tools.js';

export interface LibraryToolsDeps {
  dir: string;
  catalogTrainerFor(game: GameIdentity): Promise<StarlightTrainer | null>;
  /** Tells the game page its library changed (`userCheats:changed`). */
  onSaved(key: string): void;
  verify?: typeof verifyCheat;
  /** Engine calls save_cheat uses to record a patch's original bytes (tests replace them). */
  engine?: { resolveCheatAddress?: typeof resolveCheatAddress; readMany?: typeof readMany };
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

const SITE_EXPR = /^site(?:\s*([+-])\s*(?:0x)?([0-9a-f]+))?$/i;

export function libraryTools(deps: LibraryToolsDeps): ToolDef<any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const verify = deps.verify ?? verifyCheat;
  const now = deps.now ?? (() => new Date());
  const resolveSite = deps.engine?.resolveCheatAddress ?? resolveCheatAddress;
  const readBytes = deps.engine?.readMany ?? readMany;

  /**
   * D9: a saved patch carries the bytes it replaces, so verify notices when a game update moved the
   * code. Each writeBytes step at "site"/"site±hex" without an `original` gets the running game's
   * bytes. Runs only after verify said ok, so the AOB matched exactly once.
   */
  async function withOriginals(session: Session, cheat: Extract<AgentCheatDraft, { type: 'patch' }>): Promise<typeof cheat> {
    const todo = cheat.enable.some((st) => st.op === 'writeBytes' && st.original === undefined && SITE_EXPR.test(st.at.trim()));
    if (!todo) return cheat;
    const site = BigInt(await resolveSite(session, cheat.site));
    const enable: StarlightPatchCheat['enable'] = [];
    for (const step of cheat.enable) {
      const m = step.op === 'writeBytes' && step.original === undefined ? SITE_EXPR.exec(step.at.trim()) : null;
      if (step.op !== 'writeBytes' || !m) { enable.push(step); continue; }
      const off = m[2] ? BigInt('0x' + m[2]) : 0n;
      const address = '0x' + (m[1] === '-' ? site - off : site + off).toString(16);
      const got = (await readBytes(session, [{ address, length: step.bytes.length / 2 }]))[0];
      if (!got) throw new ToolError(`Can't read the code at ${step.at} to record its original bytes.`);
      const original = got.toString('hex');
      if (original === step.bytes.toLowerCase()) {
        throw new ToolError(
          `The code at ${step.at} already holds this patch's bytes, so Starlight can't record the original bytes. ` +
          'If a test_cheat of it is still on, revert it first, then save.');
      }
      enable.push({ ...step, original });
    }
    return { ...cheat, enable };
  }

  const saveInput = {
    cheat: AgentCheatDraftSchema.describe('A value or patch cheat (Starlight format, without id). Value cheats need verify.range.'),
    replaces: z.string().optional().describe('The id of a cheat in the library to repair in place.'),
    category: z.string().max(40).optional().describe('The category to file it under; default "My cheats".'),
  };
  const saveTool: ToolDef<typeof saveInput> = {
    name: 'save_cheat',
    title: 'Save a cheat',
    description:
      "Saves a cheat to the player's library for this game, after checking it against the running game. " +
      'Test it first with test_cheat. Use replaces to repair a cheat that stopped working. ' +
      CHEAT_DRAFT_HELP,
    tier: 'attached', readOnly: false, input: saveInput,
    async run(args, ctx) {
      const checked = validateAgentCheat(args.cheat);
      if (!checked.ok) throw new ToolError(checked.errors.join('\n'));
      let a = need(ctx);
      // D9 / R3: every saved cheat has a verify block, so it always gets the full check
      // (the AOB must match exactly once, originals must still be there).
      let cheat: AgentCheatDraft = { ...checked.cheat, verify: checked.cheat.verify ?? {} };
      const draft = { ...cheat, id: 'agent-draft' } as unknown as StarlightCheat;
      const result = await verify(a.session, draft);
      if (result.status === 'needs-update') {
        throw new ToolError("This cheat doesn't match the running game: " + result.reasons.join('; '));
      }
      a = live(ctx);
      if (cheat.type === 'patch') {
        cheat = await withOriginals(a.session, cheat);
        a = live(ctx);
      }
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
          { ...cheat, provenance }, o,
        ));
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      deps.onSaved(g.key);
      return { saved: { id, name: cheat.name, game: g.name }, verify: result };
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
