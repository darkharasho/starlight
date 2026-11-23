import { randomUUID } from 'node:crypto';
import { readFile, copyFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { detectCeRuntime, type DetectResult } from './ce-runtime-detect.js';
import { createBridge, type Bridge } from './ce-bridge.js';
import { generateControlScript } from './ce-control-script.js';
import { spawnCeProcess, type CeProcessHandle, type CeWineLaunch } from './ce-process.js';
import {
  findWineRunner, findSteamRoot, readPtraceScope, startCeServer, hasPtraceCap, NO_WINE_MESSAGE, PTRACE_MESSAGE, PTRACE_LOCKED_MESSAGE,
  type CeServerHandle, type WineRunner,
} from './ce-native.js';
import { downloadCtToDisk } from './ct-cache.js';
import { referencedModules, waitForGameReady } from './game-ready.js';
import { listTables, type CtTable } from './ct-tables.js';
import { detectProton, type ProtonInfo } from './proton-detect.js';
import { readExeName } from './proc-exe-name.js';
import { matchGameToProcess, type MatchableGame } from './game-matcher.js';
import { detectAntiCheat, antiCheatMessage } from './anti-cheat.js';
import { listCtRecords } from '@starlight/ct-importer';
import type { DetectedGame, DetectedProcess } from '../shared/ipc.js';
import { findPrerequisites, isJunk } from '../shared/cheat-list.js';

/** Convert a Linux path to the Wine drive-Z form CE understands (Z:\a\b). */
export function toWinePath(linuxPath: string): string {
  return 'Z:' + linuxPath.replace(/\//g, '\\');
}

/**
 * The control script does `require("json")`. The Windows CE runtime ships
 * `lua/json.lua`; a Windows CE that older installs put inside the Linux CE
 * (`…/windowsbin`) may lack it, so copy the Linux CE's next to it.
 */
export async function ensureWinCeJson(winCeDir: string): Promise<void> {
  const dest = join(winCeDir, 'lua', 'json.lua');
  try { await access(dest, constants.F_OK); return; } catch { /* missing — copy it */ }
  await mkdir(join(winCeDir, 'lua'), { recursive: true });
  await copyFile(join(winCeDir, '..', 'lua', 'json.lua'), dest).catch(() => {});
}

export interface CeRecord {
  id: number;
  name: string;
  isActive: boolean;
  isGroupHeader: boolean;
  /** `script` = on/off cheat, `value` = editable address, `header` = section. */
  kind?: 'script' | 'value' | 'header';
  /** Nesting level in the table (0 = top). */
  depth?: number;
  /** Current value (value records, attached sessions only). "??" when unreadable. */
  value?: string;
  /** Named choices for a value record, when the table defines a dropdown. */
  options?: { value: string; label: string }[];
  /** CE option flags, e.g. "[moHideChildren]". */
  opts?: string;
  /** Hotkey the table itself binds to toggling this record, e.g. "F2". */
  hotkey?: string;
}

/** How a table fared against the running game. */
export type TableVerdict = 'works' | 'broken' | 'unknown';

export interface TableAttempt {
  id: number;
  filename: string;
  verdict: TableVerdict;
}

/** What preparing a loaded table produced. */
export interface PreparedTable {
  records: CeRecord[];
  /** Prerequisite scripts that were switched on automatically (hidden in the UI). */
  hiddenIds: number[];
  /** Prerequisite scripts that refused to switch on, with the table's own reason. */
  prereqErrors: Record<number, string>;
  verdict: TableVerdict;
  tableError?: string | undefined;
}

/**
 * Turns Cheat Engine's raw failure text into something worth showing: drops
 * the Lua chunk/line prefix and collapses the blank lines CE pads errors with.
 */
export function cleanCeError(raw: string): string {
  return raw
    .replace(/Lua error in the script at line \d+\s*:/gi, '')
    .replace(/\[string "[^\]]*"\]:\d+:\s*/g, '')
    .replace(/\r/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .trim();
}

/** True when an enable failed because the table no longer matches the game build. */
export function isStaleTableError(msg: string): boolean {
  return /aob|not all results found|0 matches|no hook|failure determining what|not found|game build|version/i.test(msg);
}

export interface SessionState {
  sessionId: string;
  /** null for a tools-only session (no table for this game). */
  ctPath: string | null;
  /** null in a preview session (records parsed from the CT, no CE launched). */
  bridge: Bridge | null;
  ceProcess: CeProcessHandle | null;
  records: CeRecord[];
  /** What's needed to try the game's other tables without restarting Cheat Engine. */
  pick?: PickContext | undefined;
  /** Stops watching for the game to exit. */
  stopWatch?: (() => void) | undefined;
}

interface PickContext {
  tables: CtTable[];
  tableId: number | null;
  cacheKey: string;
  ctCacheDir: string;
  autoPick: boolean;
  tableReadyTimeoutMs: number;
  onProgress?: ((message: string) => void) | undefined;
  onSteps?: ((steps: PickStep[]) => void) | undefined;
}

/** One table in the queue being checked against the game, for the connecting screen. */
export interface PickStep { id: number; filename: string; state: 'waiting' | 'checking' | TableVerdict }

/** Reads the cheat list straight from the .CT — no Cheat Engine needed. */
async function recordsFromCt(ctPath: string): Promise<CeRecord[]> {
  const xml = await readFile(ctPath, 'utf8');
  return listCtRecords(xml).map((r) => ({ ...r, isActive: false }));
}

let active: SessionState | null = null;

export interface StartSessionOpts {
  /** URL of the .CT or viewtopic page. Omit (with no `sources`) for a tools-only session. */
  source?: string | undefined;
  /** Every thread/.CT URL known for this game; their tables are offered as alternatives. */
  sources?: string[] | undefined;
  /** Attachment id of the table to load (or try first). Defaults to the newest one found. */
  tableId?: number | undefined;
  /**
   * When the loaded table doesn't match the game build, move on to the game's
   * other tables until one does. Default true; pass false for an explicit pick.
   */
  autoPick?: boolean | undefined;
  /** Progress lines for the UI ("Trying table 2 of 4…"). */
  onProgress?: ((message: string) => void) | undefined;
  /** The tables queued for checking and how each fared so far. */
  onSteps?: ((steps: PickStep[]) => void) | undefined;
  /** Unsolicited messages from Cheat Engine (hotkey presses). */
  onEvent?: ((event: Record<string, unknown>) => void) | undefined;
  cacheKey: string;     // unique key per catalog entry id
  listTablesFn?: typeof listTables | undefined;
  runtimeRoot: string;
  ctCacheDir: string;
  pingTimeoutMs?: number;
  /** How long to wait for the table to finish loading once CE is reachable. */
  tableReadyTimeoutMs?: number | undefined;
  /** Target game process (Linux pid). Enables attach + Proton detection. */
  pid?: number | undefined;
  /** Target process name (e.g. "9Kings.exe"). Derived from /proc/<pid>/comm if omitted. */
  processName?: string | undefined;
  // Auto-attach via game identity:
  game?: MatchableGame | undefined;
  detectedGames?: DetectedGame[] | undefined;
  processes?: DetectedProcess[] | undefined;
  resolveMatch?: typeof matchGameToProcess | undefined;
  /**
   * Called when the attached game exits. The session has already been ended
   * (Cheat Engine closed) — under Proton, CE shares the game's wineserver and
   * would otherwise keep Steam thinking the game is still running.
   */
  onGameExit?: ((sessionId: string) => void) | undefined;
  // Injectables for tests:
  detectAntiCheatFn?: typeof detectAntiCheat | undefined;
  isGameAlive?: ((pid: number) => boolean) | undefined;
  gameWatchMs?: number | undefined;
  detectProtonFn?: typeof detectProton;
  readComm?: (pid: number) => Promise<string>;
  /** Native games: what runs Windows CE (default: Steam's Proton, else Wine). */
  findWineRunnerFn?: (() => Promise<WineRunner | null>) | undefined;
  startCeServerFn?: ((opts: { bin: string }) => Promise<CeServerHandle>) | undefined;
  readPtraceScopeFn?: (() => Promise<number>) | undefined;
  hasPtraceCapFn?: ((pid: number) => Promise<boolean>) | undefined;
  /** Waits until a just-started game has loaded what the table needs. */
  waitForGameFn?: ((pid: number, modules: string[]) => Promise<unknown>) | undefined;
  /**
   * Makes sure the trainer engine is installed, downloading what's missing
   * (default: only checks). Only an attach needs it; a preview doesn't.
   */
  ensureRuntime?: (() => Promise<{ ok: true; status: Extract<DetectResult, { status: 'ready' }> } | { ok: false; error: string }>) | undefined;
}

function defaultIsGameAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Polls the game's pid; calls `onGone` once when it disappears. Returns a stop function. */
function watchGame(pid: number, isAlive: (pid: number) => boolean, everyMs: number, onGone: () => void): () => void {
  const timer = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function defaultReadComm(pid: number): Promise<string> {
  // Prefer the full exe name from cmdline: Windows CE's openProcess needs the
  // untruncated name (e.g. "RSDragonwilds.exe"), but /proc/<pid>/comm is clipped
  // to 15 chars ("RSDragonwilds.e"), which CE can't match. Fall back to comm.
  const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
  return (await readExeName(pid, comm)) ?? comm;
}

export interface StartSessionResult {
  sessionId: string;
  records: CeRecord[];
  proton: boolean;
  needsPicker: boolean;
  /** True when Cheat Engine is running and attached to the game. */
  attached: boolean;
  /** Every table found for this game, newest first (empty for tools-only). */
  tables: CtTable[];
  /** Attachment id of the loaded table, or null when none is loaded. */
  tableId: number | null;
  /** Set when the table file itself failed to load in Cheat Engine. */
  tableError?: string | undefined;
  /** The game process the session targets (given or auto-resolved), if any. */
  process?: { pid: number; name?: string | undefined } | undefined;
  /** False when the game was looked for and isn't running (the session is a preview). */
  running: boolean;
  /** Prerequisite scripts switched on automatically; the UI hides them. */
  hiddenIds: number[];
  /** Prerequisite scripts that refused to switch on, with the reason. */
  prereqErrors: Record<number, string>;
  /** How the loaded table fared against the running game. */
  verdict: TableVerdict;
  /** Every table tried this time, in order. */
  attempts: TableAttempt[];
}

const FORUM_ATTACHMENT_URL = 'https://fearlessrevolution.com/download/file.php?id=';

/** Picks the table to load and fetches it (cached per attachment — uploads are immutable). */
async function resolveTable(opts: StartSessionOpts): Promise<{ ctPath: string | null; tables: CtTable[]; tableId: number | null }> {
  const sources = opts.sources ?? (opts.source ? [opts.source] : []);
  if (sources.length === 0) return { ctPath: null, tables: [], tableId: null };

  const tables = await (opts.listTablesFn ?? listTables)(sources).catch(() => [] as CtTable[]);
  const chosen = (opts.tableId !== undefined ? tables.find((t) => t.id === opts.tableId) : undefined) ?? tables[0];

  if (chosen) {
    // Direct links (id 0) keep the plain cache key; attachments get one each.
    const cacheKey = chosen.id === 0 ? opts.cacheKey : `${opts.cacheKey}-a${chosen.id}`;
    const { ctPath } = await downloadCtToDisk({ source: chosen.url, cacheDir: opts.ctCacheDir, cacheKey });
    return { ctPath, tables, tableId: chosen.id };
  }
  if (opts.tableId) {
    // Listing failed (offline?) but we know which table was wanted — it may be cached.
    const { ctPath } = await downloadCtToDisk({ source: `${FORUM_ATTACHMENT_URL}${opts.tableId}`, cacheDir: opts.ctCacheDir, cacheKey: `${opts.cacheKey}-a${opts.tableId}` });
    return { ctPath, tables, tableId: opts.tableId };
  }
  // Nothing listed: fall back to resolving the first source directly (legacy
  // cache key), which also serves a table cached by an older version.
  const { ctPath } = await downloadCtToDisk({ source: sources[0]!, cacheDir: opts.ctCacheDir, cacheKey: opts.cacheKey });
  return { ctPath, tables, tableId: null };
}

async function ensureRuntime(opts: StartSessionOpts): Promise<Extract<DetectResult, { status: 'ready' }>> {
  const now = await detectCeRuntime({ runtimeRoot: opts.runtimeRoot });
  if (now.status === 'ready') return now;
  if (!opts.ensureRuntime) throw new Error('The trainer engine isn\'t installed yet.');
  opts.onProgress?.('Downloading the trainer engine…');
  const r = await opts.ensureRuntime();
  if (!r.ok) throw new Error(`Couldn't download the trainer engine: ${r.error}`);
  return r.status;
}

export async function startSession(opts: StartSessionOpts): Promise<StartSessionResult> {
  // One game at a time: a game Cheat Engine is connected to is only replaced by
  // reconnecting to that same game; it ends when the game quits.
  if (active?.bridge && active.pick && active.pick.cacheKey !== opts.cacheKey) {
    throw new Error('Another game is still connected. Quit it first.');
  }
  if (active) await endSession({ sessionId: active.sessionId }).catch(() => {});

  const { ctPath, tables, tableId } = await resolveTable(opts);

  // Reactive auto-attach: if no explicit pid but a game identity is given, resolve it.
  let effectivePid = opts.pid;
  let needsPicker = false;
  let running = true;
  if (effectivePid === undefined && opts.game) {
    const match = await (opts.resolveMatch ?? matchGameToProcess)(opts.game, {
      processes: opts.processes ?? [],
      detectedGames: opts.detectedGames ?? [],
    });
    if (match === null) running = false;
    else if (match === 'ambiguous') { needsPicker = true; }
    else { effectivePid = match.pid; }
  }

  // No attach target (ambiguous match, or a plain load with no process): show
  // the cheat list parsed straight from the .CT and DON'T launch Cheat Engine
  // (booting it just to preview is slow). The user attaches (which re-runs
  // this with a pid) when they pick a process.
  if (effectivePid === undefined) {
    const sessionId = randomUUID();
    const records = ctPath ? await recordsFromCt(ctPath) : [];
    active = { sessionId, ctPath, bridge: null, ceProcess: null, records };
    return {
      sessionId, records, proton: false, needsPicker: true, attached: false, tables, tableId, running,
      // Nothing can be switched on yet, so show the list as it will look once
      // the prerequisites are on.
      hiddenIds: findPrerequisites(records).map((p) => p.id),
      prereqErrors: {}, verdict: 'unknown', attempts: [],
    };
  }

  // Refuse before anything is launched when anti-cheat is loaded in the game.
  const antiCheat = await (opts.detectAntiCheatFn ?? detectAntiCheat)(effectivePid);
  if (antiCheat) throw new Error(antiCheatMessage(antiCheat));

  // Attaching needs the trainer engine. It's normally downloaded in the
  // background at startup; if that hasn't finished, wait for it here.
  const detect = await ensureRuntime(opts);

  // Resolve the target process name and whether it's a Proton game.
  let processName = opts.processName;
  let proton: ProtonInfo | null = null;
  if (effectivePid !== undefined) {
    if (!processName) {
      processName = await (opts.readComm ?? defaultReadComm)(effectivePid).catch(() => undefined);
    }
    proton = await (opts.detectProtonFn ?? detectProton)({ pid: effectivePid });
  }

  // Every game is cheated by Windows CE: inside the game's prefix for a Proton
  // game, or in Starlight's own prefix connected to ceserver for a native one.
  let runner: WineRunner | null = null;
  let ptraceScope = 0;
  if (!proton) {
    ptraceScope = await (opts.readPtraceScopeFn ?? readPtraceScope)();
    if (ptraceScope >= 3) throw new Error(PTRACE_LOCKED_MESSAGE);
    runner = await (opts.findWineRunnerFn ?? (async () => findWineRunner({
      prefixRoot: join(opts.runtimeRoot, 'prefix'),
      steamRoot: await findSteamRoot(),
    })))();
    if (!runner) throw new Error(NO_WINE_MESSAGE);
  }

  // Short poll: Cheat Engine's Lua runs on its UI thread, so a long-poll would
  // stall its timers (value freezing, scan completion, window hiding) for the
  // whole wait. Quick empty replies keep CE responsive.
  const bridge = await createBridge({ pollTimeoutMs: 25, onEvent: opts.onEvent });
  const sessionId = randomUUID();
  await ensureWinCeJson(detect.winCeDir);

  let ceServer: CeServerHandle | null = null;
  let launch: CeWineLaunch;
  if (proton) {
    launch = {
      command: proton.protonBin,
      args: ['run'],
      env: {
        ...proton.compatEnv,
        STEAM_COMPAT_DATA_PATH: proton.compatDataPath,
        STEAM_COMPAT_CLIENT_INSTALL_PATH: proton.clientInstallPath,
      },
      winCeExe: detect.winCeExe,
      winCeDir: detect.winCeDir,
    };
  } else {
    try {
      ceServer = await (opts.startCeServerFn ?? startCeServer)({ bin: detect.ceserver });
      // With ptrace restricted, ceserver can only read the game with
      // CAP_SYS_PTRACE (granted once from the UI).
      if (ptraceScope > 0 && !(ceServer.pid !== undefined && await (opts.hasPtraceCapFn ?? hasPtraceCap)(ceServer.pid))) {
        await ceServer.stop();
        throw new Error(PTRACE_MESSAGE);
      }
    } catch (err) {
      await bridge.close().catch(() => {});
      throw err;
    }
    await mkdir(runner!.prefixDir, { recursive: true });
    launch = { command: runner!.command, args: runner!.args, env: runner!.env, winCeExe: detect.winCeExe, winCeDir: detect.winCeDir };
  }

  // The control script loads the table itself (dialogs muted first), from the
  // Wine `Z:\…` path.
  const controlScript = generateControlScript({
    bridgeUrl: bridge.url,
    ctPath: ctPath === null ? undefined : toWinePath(ctPath),
    ...(ceServer
      ? { openProcessPid: effectivePid, ceServer: { host: '127.0.0.1', port: ceServer.port } }
      : { openProcessName: processName }),
  });

  let ceProcess: CeProcessHandle;
  // `proton run` / `wine` keep running for as long as CE does, so an early
  // exit means CE never started: stop waiting for it.
  let launcherExited = false;
  try {
    const raw = await spawnCeProcess({
      launch,
      controlScript,
      sessionId,
      runtimeRoot: opts.runtimeRoot,
      onExit: () => {
        launcherExited = true;
        void ceServer?.stop();
        // If this session was active, drop it.
        if (active?.sessionId === sessionId) { active.stopWatch?.(); active = null; }
      },
    });
    ceProcess = ceServer
      ? { ...raw, kill: async (signal) => { await raw.kill(signal); await ceServer!.stop(); } }
      : raw;
  } catch (err) {
    await bridge.close().catch(() => {});
    await ceServer?.stop();
    throw err;
  }

  // Windows CE cold-boots under Proton/Wine. The first native session also
  // creates Starlight's prefix, which takes longer still.
  const defaultTimeout = proton ? 45_000 : 90_000;
  const deadline = Date.now() + (opts.pingTimeoutMs ?? defaultTimeout);
  let online = false;
  let ready = false;
  while (Date.now() < deadline && !launcherExited) {
    try {
      const pong = await Promise.race([
        bridge.send({ method: 'ping' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timed out')), 500)),
      ]) as { ready?: boolean } | null;
      online = true;
      ready = pong?.ready !== false;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!online) {
    const exitedEarly = launcherExited;   // read before kill() sets it
    await bridge.close().catch(() => {});
    await ceProcess.kill('SIGTERM').catch(() => {});
    throw new Error(exitedEarly
      ? `Cheat Engine closed while starting (${runner?.kind === 'wine' ? 'Wine' : 'Proton'} could not run it).`
      : 'CE process spawned but timed out waiting for ping');
  }

  const pick: PickContext = {
    tables, tableId, cacheKey: opts.cacheKey, ctCacheDir: opts.ctCacheDir,
    autoPick: opts.autoPick !== false,
    tableReadyTimeoutMs: opts.tableReadyTimeoutMs ?? 20_000,
    onProgress: opts.onProgress,
    onSteps: opts.onSteps,
  };
  const session: SessionState = { sessionId, ctPath, bridge, ceProcess, records: [], pick };
  active = session;
  session.stopWatch = watchGame(effectivePid, opts.isGameAlive ?? defaultIsGameAlive, opts.gameWatchMs ?? 2000, () => {
    if (active !== session) return;
    active = null;
    // The game is gone, so there's nothing to undo — just close Cheat Engine.
    void bridge.close().catch(() => {});
    void ceProcess.kill('SIGTERM').catch(() => {});
    opts.onGameExit?.(sessionId);
  });

  // Cheat Engine booted while the game was loading. Before matching a table,
  // let the game finish loading the modules the table points at.
  if (ctPath) {
    const modules = referencedModules(await readFile(ctPath, 'utf8').catch(() => ''));
    const waitFn = opts.waitForGameFn ?? ((pid: number, mods: string[]) => waitForGameReady({ pid, modules: mods }));
    // Only say so when it's noticeable (an already-loaded game returns at once).
    const slow = setTimeout(() => opts.onProgress?.('Waiting for the game to finish loading…'), 800);
    try { await waitFn(effectivePid, modules); } finally { clearTimeout(slow); }
    if (active !== session) throw new Error('The game closed while it was loading.');
  }

  const status = await sendWithTimeout(bridge, { method: 'status' }, 5000).catch(() => ({})) as { attached?: boolean };
  const attached = status.attached !== false;
  let picked: Awaited<ReturnType<typeof pickTable>>;
  try {
    picked = await pickTable(session, { loaded: tableId, ready, attached });
  } catch (err) {
    await endSession({ sessionId }).catch(() => {});
    throw err;
  }

  return {
    sessionId, records: picked.records, proton: proton !== null, needsPicker,
    attached, running: true,
    tables, tableId: pick.tableId,
    process: { pid: effectivePid, name: processName },
    tableError: picked.tableError,
    hiddenIds: picked.hiddenIds, prereqErrors: picked.prereqErrors,
    verdict: picked.verdict, attempts: picked.attempts,
  };
}

/** Polls until the table load Cheat Engine is doing has finished (or the window closes). */
async function waitTableReady(bridge: Bridge, timeoutMs: number, alreadyReady = false): Promise<boolean> {
  let ready = alreadyReady;
  const deadline = Date.now() + timeoutMs;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const pong = await sendWithTimeout(bridge, { method: 'ping' }, 2000).catch(() => null) as { ready?: boolean } | null;
    ready = pong?.ready === true;
  }
  return ready;
}

/** Switches a record on and waits out scripts that finish asynchronously. */
async function enableRecord(bridge: Bridge, id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await sendWithTimeout(bridge, { method: 'set_active', params: { id, active: true } }, 45_000) as { ok?: boolean; error?: string; pending?: boolean };
    if (!r.ok) return { ok: false, error: cleanCeError(r.error ?? 'did not switch on') };
    if (!r.pending) return { ok: true };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 500));
      const s = await sendWithTimeout(bridge, { method: 'refresh' }, 8000).catch(() => null) as { states?: unknown } | null;
      const states = Array.isArray(s?.states) ? s.states as { id: number; a?: boolean }[] : [];
      if (states.find((x) => x.id === id)?.a) return { ok: true };
    }
    return { ok: false, error: 'still working after 30 seconds' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** How many plain cheats to inspect when a table has no prerequisite to judge it by. */
const LEAF_CHECKS = 4;

/**
 * Makes the loaded table usable and judges whether it matches the game: waits
 * for the load, switches on the scripts that only exist to unlock the rest,
 * and reads back the result.
 */
async function prepareTable(bridge: Bridge, opts: { readyTimeoutMs: number; ready?: boolean | undefined; hasTable: boolean; attached: boolean }): Promise<PreparedTable> {
  const ready = await waitTableReady(bridge, opts.readyTimeoutMs, opts.ready);
  const status = await sendWithTimeout(bridge, { method: 'status' }, 5000).catch(() => ({})) as { tableError?: string };
  const list = async (): Promise<CeRecord[]> => {
    const reply = await sendWithTimeout(bridge, { method: 'list_records' }, 10_000).catch(() => ({})) as { records?: unknown };
    // Cheat Engine's JSON encoder writes an empty Lua table as `{}`, not `[]`.
    return Array.isArray(reply.records) ? reply.records as CeRecord[] : [];
  };
  let records = await list();
  const tableError = status.tableError
    ? cleanCeError(status.tableError)
    : (!ready && opts.hasTable ? 'The table is taking unusually long to load.' : undefined);

  const hiddenIds: number[] = [];
  const prereqErrors: Record<number, string> = {};
  let verdict: TableVerdict = 'unknown';

  if (opts.attached && records.length > 0) {
    const prereqs = findPrerequisites(records);
    const on = new Set<number>();
    for (const p of prereqs) {
      if (p.parentId !== null && !on.has(p.parentId)) continue;   // its parent never came on
      const r = await enableRecord(bridge, p.id);
      if (r.ok) { on.add(p.id); hiddenIds.push(p.id); }
      else prereqErrors[p.id] = r.error ?? 'did not switch on';
    }
    if (prereqs.length > 0) {
      verdict = on.size > 0 ? 'works' : 'broken';
      records = await list();    // switching these on reveals values and child states
    } else {
      // No prerequisite to judge by: inspect a few plain cheats instead (never
      // run them — a cheat can be a one-shot action).
      const hasKids = (i: number): boolean => (records[i + 1]?.depth ?? 0) > (records[i]!.depth ?? 0);
      const leaves = records.filter((r, i) => r.kind === 'script' && !hasKids(i) && !isJunk(r.name)).slice(0, LEAF_CHECKS);
      // Each answers "are the byte signatures this script patches still in the
      // game?" — or declines when the script isn't signature-based.
      let found = 0;
      let missing = 0;
      for (const r of leaves) {
        const c = await sendWithTimeout(bridge, { method: 'check_script', params: { id: r.id } }, 60_000).catch(() => ({ unknown: true })) as { ok?: boolean; unknown?: boolean };
        if (c.unknown) continue;
        if (c.ok) found++; else missing++;
      }
      if (found > 0 && missing === 0) verdict = 'works';
      else if (missing > 0 && found === 0) verdict = 'broken';
    }
  }
  return { records, hiddenIds, prereqErrors, verdict, tableError };
}

/** Most tables worth trying in one go, and how long the whole search may take. */
const MAX_TABLES_TRIED = 5;
const PICK_BUDGET_MS = 90_000;

/**
 * Settles on a table for the session. Prepares the one already loaded; when it
 * doesn't match the game and auto-pick is on, swaps through the game's other
 * tables (in place — no Cheat Engine restart) until one does, falling back to
 * the best of what was tried.
 */
async function pickTable(s: SessionState, first: { loaded: number | null; ready?: boolean; attached?: boolean }): Promise<PreparedTable & { attempts: TableAttempt[] }> {
  const bridge = s.bridge!;
  const ctx = s.pick!;
  const hasTable = s.ctPath !== null;
  const attempts: TableAttempt[] = [];
  const note = (id: number | null, verdict: TableVerdict): void => {
    const t = ctx.tables.find((x) => x.id === id);
    if (t) attempts.push({ id: t.id, filename: t.filename, verdict });
  };

  const attached = first.attached !== false;
  // What the connecting screen shows: every table that may get checked, in order.
  const queue = hasTable && attached
    ? ctx.tables.filter((t) => t.id === first.loaded).concat(
        ctx.autoPick ? ctx.tables.filter((t) => t.id !== first.loaded).slice(0, MAX_TABLES_TRIED - 1) : [])
    : [];
  const states = new Map<number, PickStep['state']>();
  const step = (id: number | null, state: PickStep['state']): void => {
    if (id === null || queue.length === 0) return;
    states.set(id, state);
    ctx.onSteps?.(queue.map((t) => ({ id: t.id, filename: t.filename, state: states.get(t.id) ?? 'waiting' })));
  };

  step(first.loaded, 'checking');
  let current = await prepareTable(bridge, { readyTimeoutMs: ctx.tableReadyTimeoutMs, ready: first.ready, hasTable, attached });
  let currentId = first.loaded;
  note(currentId, current.verdict);
  step(currentId, current.verdict);

  const load = async (t: CtTable): Promise<boolean> => {
    const cacheKey = t.id === 0 ? ctx.cacheKey : `${ctx.cacheKey}-a${t.id}`;
    const { ctPath } = await downloadCtToDisk({ source: t.url, cacheDir: ctx.ctCacheDir, cacheKey });
    const r = await sendWithTimeout(bridge, { method: 'load_table', params: { path: toWinePath(ctPath) } }, 30_000) as { ok?: boolean };
    if (!r.ok) return false;
    s.ctPath = ctPath;
    return true;
  };

  if (hasTable && attached && ctx.autoPick && current.verdict !== 'works') {
    const others = ctx.tables.filter((t) => t.id !== currentId).slice(0, MAX_TABLES_TRIED - 1);
    const deadline = Date.now() + PICK_BUDGET_MS;
    const tried: { id: number | null; prepared: PreparedTable }[] = [{ id: currentId, prepared: current }];
    for (const [i, t] of others.entries()) {
      if (Date.now() > deadline) break;
      ctx.onProgress?.(`That table doesn't match your game version — trying another (${i + 2} of ${others.length + 1})…`);
      step(t.id, 'checking');
      try {
        if (!(await load(t))) { step(t.id, 'unknown'); continue; }
        current = await prepareTable(bridge, { readyTimeoutMs: ctx.tableReadyTimeoutMs, hasTable: true, attached: true });
        currentId = t.id;
        note(t.id, current.verdict);
        step(t.id, current.verdict);
        tried.push({ id: t.id, prepared: current });
        if (current.verdict === 'works') break;
      } catch { step(t.id, 'unknown'); /* unreachable or unloadable table: move on */ }
    }
    if (current.verdict !== 'works') {
      // Nothing verified. Prefer one we couldn't judge over one known not to
      // match, and the earliest (the remembered / newest) among equals.
      const best = tried.find((x) => x.prepared.verdict === 'unknown') ?? tried[0]!;
      if (best.id !== currentId) {
        const t = ctx.tables.find((x) => x.id === best.id);
        if (t && await load(t).catch(() => false)) {
          current = await prepareTable(bridge, { readyTimeoutMs: ctx.tableReadyTimeoutMs, hasTable: true, attached: true });
          currentId = best.id;
        }
      }
    }
  }

  ctx.tableId = currentId;
  s.records = current.records;
  return { ...current, attempts };
}

/**
 * Tries again to find a table that matches — for when the first attempt ran
 * before the game had finished loading. Reuses the running Cheat Engine.
 */
export async function retryTables(req: { sessionId: string }): Promise<({ ok: true } & PreparedTable & { attempts: TableAttempt[]; tableId: number | null }) | { ok: false; error: string }> {
  const s = active;
  if (!s || s.sessionId !== req.sessionId) return { ok: false, error: 'session not active' };
  if (!s.bridge || !s.pick) return { ok: false, error: 'not attached to a game process' };
  try {
    // Start from a clean table: reload the current one so half-applied
    // prerequisites from the last attempt don't linger.
    const cur = s.pick.tables.find((t) => t.id === s.pick!.tableId);
    if (cur && s.ctPath) {
      await sendWithTimeout(s.bridge, { method: 'load_table', params: { path: toWinePath(s.ctPath) } }, 30_000);
    }
    const picked = await pickTable(s, { loaded: s.pick.tableId });
    return { ok: true, ...picked, tableId: s.pick.tableId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Races a bridge command against a timeout. Without this a wedged Cheat Engine
 * (e.g. blocked on a table's load-time script) would leave the caller — and the
 * renderer button that awaits it — hanging forever with no feedback.
 */
async function sendWithTimeout(bridge: Bridge, cmd: { method: string; params?: unknown }, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cheat Engine did not respond (timed out)')), ms);
  });
  try {
    return await Promise.race([bridge.send(cmd), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function setActive(req: { sessionId: string; recordId: number; active: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (!active || active.sessionId !== req.sessionId) {
    return { ok: false, error: 'session not active' };
  }
  if (!active.bridge) {
    return { ok: false, error: 'not attached to a game process' };
  }
  try {
    // Enabling can run an AOB scan over the whole game, and a failure is
    // diagnosed by a second pass — allow for both.
    const r = await sendWithTimeout(active.bridge, { method: 'set_active', params: { id: req.recordId, active: req.active } }, 30_000) as { ok?: boolean; error?: string };
    if (r.ok) {
      const rec = active.records.find((x) => x.id === req.recordId);
      if (rec) rec.isActive = req.active;
      return { ok: true };
    }
    return { ok: false, error: cleanCeError(r.error ?? 'unknown error') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Bridge commands the renderer may issue directly, with how long each may take. */
const CALLABLE: Record<string, number> = {
  refresh: 8000,
  set_value: 8000,
  set_speed: 15_000,     // first use injects the speedhack module
  scan_first: 15_000,    // starts the scan; progress comes from scan_status
  scan_next: 15_000,
  scan_status: 5000,
  scan_results: 15_000,
  scan_reset: 8000,
  mem_read: 8000,
  mem_write: 8000,
  freeze_set: 8000,
  freeze_clear: 8000,
  set_hotkeys: 8000,
};

/**
 * Runs one of the allow-listed session commands (value edits, game speed,
 * memory scanner). Always resolves: failures come back as `{ ok: false, error }`.
 */
export async function callSession(req: { sessionId: string; method: string; params?: unknown }): Promise<Record<string, unknown>> {
  if (!active || active.sessionId !== req.sessionId) return { ok: false, error: 'session not active' };
  if (!active.bridge) return { ok: false, error: 'not attached to a game process' };
  const timeout = CALLABLE[req.method];
  if (timeout === undefined) return { ok: false, error: `unsupported command: ${req.method}` };
  try {
    const r = await sendWithTimeout(active.bridge, { method: req.method, params: req.params }, timeout);
    const out = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    if (typeof out['error'] === 'string') out['error'] = cleanCeError(out['error']);
    return out;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function endSession(req: { sessionId: string }): Promise<{ ok: boolean }> {
  const s = active;
  if (!s || s.sessionId !== req.sessionId) return { ok: true };
  active = null;
  s.stopWatch?.();
  // Put the game back first: disable active cheats (runs their [DISABLE]),
  // restore normal speed, release frozen values. Killing CE without this
  // leaves code patches in the game, and the next attach then fails because
  // the table no longer recognises the patched bytes.
  if (s.bridge) await sendWithTimeout(s.bridge, { method: 'shutdown' }, 5000).catch(() => {});
  try { await s.bridge?.close(); } catch { /* ignore */ }
  try { await s.ceProcess?.kill('SIGTERM'); } catch { /* ignore */ }
  return { ok: true };
}

export function getActiveSession(): SessionState | null {
  return active;
}
