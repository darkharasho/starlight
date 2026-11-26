// Sharing a cheat from the player's library: build the community file the
// player previews, then send exactly that to the share relay. The relay opens
// a pull request; nothing reaches other players until the maintainer merges it.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkShareRules, isPatchCheat, isValueCheat, shareFlags, shareHash, sharePlatformOf, shareSummary,
  type CommunityCheatFile, type StarlightCheat, type StarlightPatchCheat, type StarlightValueCheat,
} from '@starlight/ct-importer';
import type { SharePreview, ShareSent } from '../shared/ipc.js';
import { loadUserTrainer } from './user-cheats.js';

/** Set to the deployed relay when it goes live. */
export const SHARE_RELAY_URL = 'https://starlight-share.invalid/submit';

export interface ShareHostDeps {
  dir: string;
  userData: string;
  appVersion: string;
  /** Defaults to SHARE_RELAY_URL; the local end-to-end check points it at `wrangler dev`. */
  relayUrl?: string;
  fetch?: typeof fetch;
  /** The running game's code bitness, for cheats saved before bits were recorded. */
  liveBits?(pid: number): Promise<32 | 64 | null>;
  /** The player's login name; a cheat containing it isn't shared. */
  username?: string;
  now?(): Date;
}

export interface ShareRequest { key: string; id: string; pid: number | null; credit?: string }

export interface ShareHost {
  preview(req: ShareRequest): Promise<SharePreview>;
  send(req: ShareRequest): Promise<ShareSent>;
}

interface ShareState { installId: string; shared: Record<string, string> }

const NO_BITS = "Start the game once so Starlight can tell whether it's 32- or 64-bit.";
const UNREACHABLE = "Couldn't reach the sharing service.";

export function createShareHost(deps: ShareHostDeps): ShareHost {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const stateFile = join(deps.userData, 'share.json');

  async function readState(): Promise<ShareState> {
    try {
      const s = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<ShareState>;
      if (typeof s.installId === 'string' && s.shared && typeof s.shared === 'object') return s as ShareState;
    } catch { /* missing or unreadable: start fresh */ }
    const fresh = { installId: randomUUID(), shared: {} };
    await writeState(fresh);
    return fresh;
  }
  async function writeState(s: ShareState): Promise<void> {
    await mkdir(deps.userData, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
    await rename(tmp, stateFile);
  }

  type Built = { ok: true; file: CommunityCheatFile; hash12: string } | { ok: false; reason: string };

  async function build(req: ShareRequest): Promise<Built> {
    const trainer = await loadUserTrainer(deps.dir, req.key);
    const found: StarlightCheat | undefined = trainer?.categories.flatMap((c) => c.cheats).find((c) => c.id === req.id);
    if (!trainer || !found) return { ok: false, reason: 'That cheat is no longer in your library.' };
    if (!isValueCheat(found) && !isPatchCheat(found)) return { ok: false, reason: "This cheat can't run, so it can't be shared." };
    const cheat: StarlightValueCheat | StarlightPatchCheat = found;
    const prov = cheat.provenance;
    if (!prov) return { ok: false, reason: "Starlight doesn't know where this cheat came from, so it can't be shared." };
    if (prov.kind === 'ct-import') {
      return { ok: false, reason: "Cheats from a Cheat Engine table belong to the table's author, so they can't be shared." };
    }
    const steamAppId = trainer.game.steamAppId;
    if (typeof steamAppId !== 'number') return { ok: false, reason: "Starlight doesn't know this game's Steam id, so it can't be shared." };

    let bits = prov.bits ?? null;
    if (bits === null && req.pid !== null && deps.liveBits) bits = await deps.liveBits(req.pid).catch(() => null);
    if (bits === null) return { ok: false, reason: NO_BITS };

    // The cheat as it runs: no library id, provenance or the player's hotkeys.
    const { id: _id, provenance: _p, hotkeys: _h, unsupported: _u, ...draft } = cheat;
    const credit = req.credit?.trim();
    const file = {
      schemaVersion: 1,
      cheat: draft,
      game: {
        steamAppId,
        name: trainer.game.name,
        platform: sharePlatformOf(trainer.game.platform?.[0] ?? 'linux'),
        bits,
        ...(prov.game.buildId ? { buildId: prov.game.buildId } : {}),
        ...(prov.game.exeHash ? { exeHash: prov.game.exeHash } : {}),
      },
      ...(prov.agent ? { agent: prov.agent } : {}),
      ...(credit ? { credit } : {}),
      ...(prov.derivedFrom ? { derivedFrom: prov.derivedFrom } : {}),
      submittedAt: now().toISOString().slice(0, 10),
    };
    const checked = checkShareRules(file);
    if (!checked.ok) return { ok: false, reason: `This cheat can't be shared: ${checked.errors.join('; ')}` };
    const user = deps.username?.toLowerCase();
    if (user && user.length >= 3 && JSON.stringify(file).toLowerCase().includes(user)) {
      return { ok: false, reason: 'This cheat contains your user name. Remove it before sharing.' };
    }
    return { ok: true, file: checked.file, hash12: (await shareHash(checked.file)).slice(0, 12) };
  }

  return {
    async preview(req) {
      const b = await build(req);
      if (!b.ok) return b;
      const flags = shareFlags(b.file);
      const url = (await readState()).shared[b.hash12];
      return {
        ok: true,
        json: JSON.stringify(b.file, null, 2),
        summary: shareSummary(b.file, flags),
        flags,
        already: url ? { url } : null,
      };
    },

    async send(req) {
      const b = await build(req);
      if (!b.ok) return b;
      const state = await readState();
      let res: Response;
      try {
        res = await fetchFn(deps.relayUrl ?? SHARE_RELAY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: b.file, installId: state.installId, appVersion: deps.appVersion }),
        });
      } catch {
        return { ok: false, reason: UNREACHABLE };
      }
      const body = await res.json().catch(() => null) as { url?: unknown; state?: unknown; duplicate?: unknown; error?: unknown } | null;
      if (!res.ok || !body || typeof body.url !== 'string') {
        const reason = typeof body?.error === 'string' ? body.error : `The sharing service couldn't take it (error ${res.status}).`;
        return { ok: false, reason };
      }
      const st = body.state === 'merged' || body.state === 'declined' ? body.state : 'open';
      await writeState({ ...state, shared: { ...state.shared, [b.hash12]: body.url } });
      return { ok: true, url: body.url, state: st, duplicate: body.duplicate === true };
    },
  };
}
