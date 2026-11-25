import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  StarlightTrainerSchema,
  type StarlightCheat, type StarlightPatchCheat, type StarlightTrainer, type StarlightValueCheat,
} from '@starlight/ct-importer';

/** The player's own cheats, one trainer file per game: `<dir>/<key>.json`. */
export function userCheatsDir(userData: string): string {
  return join(userData, 'user-cheats');
}

const KEY = /^[a-z0-9-]{1,80}$/;
export const USER_CATEGORY = 'My cheats';

function fileFor(dir: string, key: string): string {
  if (!KEY.test(key)) throw new Error('bad game key');
  return join(dir, `${key}.json`);
}

type Loaded = { status: 'missing' } | { status: 'bad'; file: string } | { status: 'ok'; trainer: StarlightTrainer };

async function readTrainer(dir: string, key: string): Promise<Loaded> {
  const file = fileFor(dir, key);
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'bad', file };
  }
  try {
    const parsed = StarlightTrainerSchema.safeParse(JSON.parse(text));
    return parsed.success ? { status: 'ok', trainer: parsed.data } : { status: 'bad', file };
  } catch { return { status: 'bad', file }; }
}

/** A game the player has their own cheats for: what Search, Browse and Library list. */
export interface UserCheatGameSummary {
  key: string;
  name: string;
  steamAppId: number | null;
  processName: string[];
  proton: boolean;
  cheats: number;
}

/** Every game with at least one cheat in the player's library. Unreadable files are skipped. */
export async function listUserCheatGames(dir: string): Promise<UserCheatGameSummary[]> {
  let files: string[];
  try { files = await readdir(dir); } catch { return []; }
  const out: UserCheatGameSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const key = f.slice(0, -'.json'.length);
    if (!KEY.test(key)) continue;
    const t = await loadUserTrainer(dir, key);
    if (!t) continue;
    const cheats = t.categories.reduce((n, c) => n + c.cheats.length, 0);
    if (cheats === 0) continue;
    out.push({
      key,
      name: t.game.name,
      steamAppId: t.game.steamAppId ?? null,
      processName: t.game.processName ?? [],
      proton: (t.game.platform ?? []).includes('linux-proton'),
      cheats,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadUserTrainer(dir: string, key: string): Promise<StarlightTrainer | null> {
  const r = await readTrainer(dir, key);
  return r.status === 'ok' ? r.trainer : null;
}

async function loadForWrite(dir: string, key: string): Promise<StarlightTrainer | null> {
  const r = await readTrainer(dir, key);
  if (r.status === 'bad') throw new Error(`your cheat library for this game can't be read (${r.file}); not overwriting it. Fix or move the file and try again`);
  return r.status === 'ok' ? r.trainer : null;
}

async function writeTrainer(dir: string, key: string, t: StarlightTrainer): Promise<void> {
  const file = fileFor(dir, key);
  if (!StarlightTrainerSchema.safeParse(t).success) throw new Error("that cheat isn't valid, so it wasn't saved");
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(t, null, 2), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Saves and removals for one game run one at a time, so two quick edits can't lose each other. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(dir: string, key: string, fn: () => Promise<T>): Promise<T> {
  const k = `${dir}\0${key}`;
  const run = (queues.get(k) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(k, tail);
  void tail.then(() => { if (queues.get(k) === tail) queues.delete(k); });
  return run;
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return s || 'cheat';
}

export interface UserCheatGame { name: string; exeName: string; proton: boolean; steamAppId: number | null }
export type UserCheatDraft = (Omit<StarlightValueCheat, 'id'> | Omit<StarlightPatchCheat, 'id'>) & { id?: string };

export async function saveUserCheat(
  dir: string,
  key: string,
  game: UserCheatGame,
  cheat: UserCheatDraft,
  o: { category?: string; replaces?: string } = {},
): Promise<{ id: string }> {
  fileFor(dir, key); // throws synchronously-in-promise for a bad key, before queueing
  return await serial(dir, key, async () => {
    const existing = await loadForWrite(dir, key);
    const trainer: StarlightTrainer = existing ?? {
      schemaVersion: 2,
      id: `user-${key}`,
      game: {
        name: game.name,
        ...(game.steamAppId !== null ? { steamAppId: game.steamAppId } : {}),
        processName: [game.exeName],
        platform: [game.proton ? 'linux-proton' : 'linux'],
      },
      metadata: { source: { convertedFrom: 'starlight' } },
      categories: [],
    };

    const taken = new Set(trainer.categories.flatMap((c) => c.cheats.map((x) => x.id)));
    let id: string;
    if (o.replaces !== undefined) {
      if (!taken.has(o.replaces)) throw new Error(`no cheat "${o.replaces}" in your library for this game`);
      id = o.replaces;
    } else {
      const base = slug(cheat.name);
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    }
    const stored = { ...cheat, id } as StarlightCheat;

    if (o.replaces !== undefined) {
      for (const c of trainer.categories) {
        const i = c.cheats.findIndex((x) => x.id === id);
        if (i !== -1) { c.cheats[i] = stored; break; }
      }
    } else {
      const name = o.category ?? USER_CATEGORY;
      let cat = trainer.categories.find((c) => c.name === name);
      if (!cat) { cat = { name, cheats: [] }; trainer.categories.push(cat); }
      cat.cheats.push(stored);
    }
    await writeTrainer(dir, key, trainer);
    return { id };
  });
}

export async function removeUserCheat(dir: string, key: string, id: string): Promise<boolean> {
  fileFor(dir, key);
  return await serial(dir, key, async () => {
    const t = await loadForWrite(dir, key);
    if (!t) return false;
    let removed = false;
    for (const c of t.categories) {
      const next = c.cheats.filter((x) => x.id !== id);
      if (next.length !== c.cheats.length) { c.cheats = next; removed = true; }
    }
    if (removed) await writeTrainer(dir, key, t);
    return removed;
  });
}
