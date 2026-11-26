import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { detectCeRuntime, type DetectResult } from './ce-runtime-detect.js';
import { readPtraceScope, PTRACE_MESSAGE, PTRACE_LOCKED_MESSAGE, type CeServerHandle, type WineRunner } from './ce-native.js';
import { launchCeBackend } from './ce-backend.js';
import { createNativeBackend } from './native-backend.js';
import { routeTable, routeSummary, outsideRoute, ceRunningLine, checkAllAssemble, ROUTE_CE_RUNNING, type RouteDecision } from './ct-runner.js';
import type { TableBackend } from './table-backend.js';
import { downloadCtToDisk } from './ct-cache.js';
import { referencedModules, waitForGameReady } from './game-ready.js';
import { listTables, type CtTable } from './ct-tables.js';
import { detectProton, type ProtonInfo } from './proton-detect.js';
import { readExeName } from './proc-exe-name.js';
import { matchGameToProcess, type MatchableGame } from './game-matcher.js';
import { detectAntiCheat, antiCheatMessage } from './anti-cheat.js';
import { createScannerHost, SCANNER_METHODS } from './scanner-host.js';
import { getEngineClient } from './starlightd-host.js';
import { listCtRecords, compileTable, reasonCopy, type CompiledTable } from '@starlight/ct-importer';
import { attach, processInfo, checkAssembles, type Session } from '@starlight/engine';
import type { DetectedGame, DetectedProcess, RouteSummary, SessionMode } from '../shared/ipc.js';
import { findPrerequisites, isJunk } from '../shared/cheat-list.js';
import type { Holder } from './game-owner.js';

export { toWinePath, ensureWinCeJson } from './ce-backend.js';

export type { SessionMode } from '../shared/ipc.js';

/** The engine name the renderer sees for a session mode. */
export function engineOf(mode: SessionMode): 'ce' | 'starlightd' {
  return mode === 'ce' ? 'ce' : 'starlightd';
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
  /**
   * Who runs the game's cheats: Cheat Engine, Starlight's own engine, or
   * nobody while starlightd owns the game (paused: no backend).
   */
  mode: SessionMode;
  /** null for a tools-only session (no table for this game). */
  ctPath: string | null;
  /** null in a preview or paused session (records parsed from the CT, no CE launched). */
  backend: TableBackend | null;
  records: CeRecord[];
  /** The game this session is attached to; null for a preview with no process. */
  pid: number | null;
  /** What's needed to try the game's other tables without restarting Cheat Engine. */
  pick?: PickContext | undefined;
  /** Stops watching for the game to exit. */
  stopWatch?: (() => void) | undefined;
  /** Where the loaded table was routed (null without a table). */
  route?: RouteSummary | null | undefined;
  /** Native sessions: detaches starlightd's session and releases the table hold (once). */
  endNative?: (() => Promise<void>) | undefined;
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
  /** How each table tried was routed, by attachment id. */
  routes: Map<number | null, RouteSummary | null>;
  /** Routes a downloaded candidate (native sessions; cached per path). */
  route?: ((ctPath: string, tableId: number) => Promise<RouteDecision | null>) | undefined;
  /**
   * Native sessions, during the startup pick only: puts the native backend away
   * and starts Cheat Engine on `ctPath` (D17). False when it can't now
   * (starlightd is held), and the candidate is skipped. Cleared once the
   * startup pick is done, so a retry never moves a native session to CE.
   */
  switchToCe?: ((ctPath: string) => Promise<boolean>) | undefined;
}

/** Cheat Engine couldn't start in the middle of a pick: the session has no backend left. */
class CeSwitchError extends Error {}

/** One table in the queue being checked against the game, for the connecting screen. */
export interface PickStep { id: number; filename: string; state: 'waiting' | 'checking' | TableVerdict }

/** Reads the cheat list straight from the .CT — no Cheat Engine needed. */
async function recordsFromCt(ctPath: string): Promise<CeRecord[]> {
  const xml = await readFile(ctPath, 'utf8');
  return listCtRecords(xml).map((r) => ({ ...r, isActive: false }));
}

let active: SessionState | null = null;

/** The memory scanner runs on starlightd, not in the CE bridge. */
const scannerHost = createScannerHost({ getClient: getEngineClient });

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
  /**
   * Who holds the game on starlightd. When this lists anyone for the game's
   * pid, Cheat Engine isn't launched and the table stays paused.
   */
  starlightdHolders?: ((pid: number) => Holder[]) | undefined;
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
  /** Whether starlightd lacks CAP_SYS_PTRACE (only asked when ptrace is restricted). */
  engineNeedsPtraceGrantFn?: (() => Promise<boolean>) | undefined;
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
  /** Decides whether a table runs natively or in Cheat Engine (default: ct-runner on starlightd). */
  routeTableFn?: ((ctPath: string, label: string) => Promise<RouteDecision>) | undefined;
  /** Told every decision the default router makes (e.g. to count it in ct-routing.json). */
  recordRouteFn?: ((d: RouteDecision) => void) | undefined;
  createNativeBackendFn?: typeof createNativeBackend | undefined;
  /** Opens starlightd's session on the game for a native table (`mainModule`: the game's exe). */
  attachEngineFn?: ((pid: number, mainModule?: string) => Promise<Session>) | undefined;
  /** Assembles a cheat's scripts without a game (default: the engine's `checkAssembles`). */
  checkAssemblesFn?: typeof checkAssembles | undefined;
  /** Registers the native table as a starlightd holder of the game. Returns the release. */
  holdTable?: ((pid: number) => () => void) | undefined;
  /** `preferences.nativeTables` (default true): off sends every table to Cheat Engine. */
  nativeTables?: boolean | undefined;
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
  /** Who runs the game's cheats. */
  engine: 'ce' | 'starlightd';
  /** Who runs the game's table (`engine` is derived from it). */
  mode: SessionMode;
  /** Where the loaded table was routed; null without a table. */
  route: RouteSummary | null;
  /** Who holds the game on starlightd (empty while Cheat Engine runs it). */
  holders: Holder[];
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

/** Turns hotkeys a native table registered off (lazily: the hook isn't loaded until used). */
async function clearTableHotkeys(): Promise<void> {
  try { (await import('./hotkey-host.js')).clearSessionHotkeys(); } catch { /* no hook */ }
}

/** A native session's teardown: detach starlightd's session, release the hold, drop the hotkeys. */
async function endNativeOf(s: SessionState): Promise<void> {
  const end = s.endNative;
  if (!end) return;
  s.endNative = undefined;
  await end();
  await clearTableHotkeys();
}

/** The game's exe name when it's a full Windows exe name (one that can decide the game's bitness). */
function mainModuleOf(name: string | undefined): string | undefined {
  return name && /\.exe$/i.test(name) ? name : undefined;
}

/**
 * Routes a table, checking its scripts at the game's bitness. While the game is still loading
 * its exe the bitness is unknown: wait for the table's modules once and ask again.
 */
function defaultRouteFn(opts: StartSessionOpts, pidOf: () => number | undefined): (ctPath: string, label: string) => Promise<RouteDecision> {
  return async (ctPath, label) => {
    const d = await routeWithBits(opts, pidOf, ctPath, label);
    opts.recordRouteFn?.(d);
    return d;
  };
}

/** The game's code bitness for `pid` (null while unknown, or when starlightd can't be asked). */
export async function gameCodeBits(pid: number, processName?: string): Promise<32 | 64 | null> {
  try {
    return (await processInfo(await getEngineClient(), pid, mainModuleOf(processName))).codeBits;
  } catch {
    return null;
  }
}

function routeWithBits(opts: StartSessionOpts, pidOf: () => number | undefined, ctPath: string, label: string): Promise<RouteDecision> {
  return routeTable(ctPath, {
    getClient: getEngineClient, enabled: opts.nativeTables !== false, label,
    ...(opts.checkAssemblesFn ? { check: opts.checkAssemblesFn } : {}),
    codeBits: async () => {
      const pid = pidOf();
      if (pid === undefined) return null;
      const client = await getEngineClient();
      const mainModule = mainModuleOf(opts.processName);
      const first = await processInfo(client, pid, mainModule);
      if (first.codeBits !== null) return first.codeBits;
      await waitForModules(opts, pid, ctPath);
      return (await processInfo(client, pid, mainModule)).codeBits;
    },
  });
}

export async function startSession(opts: StartSessionOpts): Promise<StartSessionResult> {
  // One game at a time: a game Cheat Engine is connected to is only replaced by
  // reconnecting to that same game; it ends when the game quits.
  if (active?.backend && active.pick && active.pick.cacheKey !== opts.cacheKey) {
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

  // Native or Cheat Engine (D13/D14). A table that can't be routed keeps
  // today's path.
  const routeFn = opts.routeTableFn ?? defaultRouteFn(opts, () => effectivePid);
  const routeOf = async (path: string | null, id: number | null): Promise<RouteDecision | null> => {
    if (!path) return null;
    return routeFn(path, `${opts.cacheKey}#${id ?? 0}`).catch((err) => {
      console.warn(`[ct-runner] ${opts.cacheKey}#${id ?? 0}: couldn't route (${err instanceof Error ? err.message : String(err)}); using Cheat Engine`);
      return null;
    });
  };

  // No attach target (ambiguous match, or a plain load with no process): show
  // the cheat list parsed straight from the .CT and DON'T launch Cheat Engine
  // (booting it just to preview is slow). The user attaches (which re-runs
  // this with a pid) when they pick a process.
  if (effectivePid === undefined) {
    const route = routeSummary(await routeOf(ctPath, tableId));
    const sessionId = randomUUID();
    const records = ctPath ? await recordsFromCt(ctPath) : [];
    active = { sessionId, mode: 'ce', ctPath, backend: null, records, pid: null, route };
    return {
      sessionId, records, proton: false, needsPicker: true, attached: false, tables, tableId, running,
      // Nothing can be switched on yet, so show the list as it will look once
      // the prerequisites are on.
      hiddenIds: findPrerequisites(records).map((p) => p.id),
      prereqErrors: {}, verdict: 'unknown', attempts: [], engine: engineOf('ce'), mode: 'ce', route, holders: [],
    };
  }

  // Refuse before anything is launched (or routed) when anti-cheat is loaded in the game.
  const antiCheat = await (opts.detectAntiCheatFn ?? detectAntiCheat)(effectivePid);
  if (antiCheat) throw new Error(antiCheatMessage(antiCheat));

  const decision = await routeOf(ctPath, tableId);
  let route = routeSummary(decision);

  // A table that compiles runs on starlightd, whoever else holds the game (D16).
  if (decision?.engine === 'native' && decision.compiled && ctPath) {
    try {
      return await startNativeSession(opts, {
        pid: effectivePid, ctPath, tables, tableId, needsPicker, decision, route,
        routeOf: (path, id) => routeOf(path, id),
      });
    } catch (err) {
      if (!(err instanceof NativeStartError)) throw err;
      // The table's Lua failed on starlightd, or its scripts don't assemble for this game's
      // bitness: Cheat Engine runs it instead.
      const what = err.code === 'asm:error' ? "couldn't start on the native engine" : 'Lua failed on the native engine';
      console.log(`[ct-runner] ${opts.cacheKey}#${tableId ?? 0}: ${what}, using Cheat Engine: ${err.message}`);
      route = {
        engine: 'ce', codes: { [err.code]: err.count },
        first: { recordId: err.recordId, name: err.recordName, code: err.code, detail: err.message, copy: reasonCopy(err.code) },
      };
    }
  }

  // starlightd already holds this game: Cheat Engine stays out, the table is
  // paused and its cheats are shown from the .CT.
  const holders = opts.starlightdHolders?.(effectivePid) ?? [];
  if (holders.length > 0) {
    const sessionId = randomUUID();
    const records = ctPath ? await recordsFromCt(ctPath) : [];
    const session: SessionState = { sessionId, mode: 'paused', ctPath, backend: null, records, pid: effectivePid, route };
    active = session;
    session.stopWatch = watchGame(effectivePid, opts.isGameAlive ?? defaultIsGameAlive, opts.gameWatchMs ?? 2000, () => {
      if (active !== session) return;
      active = null;
      void scannerHost.end().catch(() => {});
      opts.onGameExit?.(sessionId);
    });
    return {
      sessionId, records, proton: false, needsPicker: false, attached: true, running: true,
      tables, tableId, process: { pid: effectivePid, name: opts.processName },
      hiddenIds: findPrerequisites(records).map((p) => p.id),
      prereqErrors: {}, verdict: 'unknown', attempts: [], engine: engineOf('paused'), mode: 'paused', route, holders,
    };
  }

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

  const sessionId = randomUUID();
  const backend = await launchCeBackend({
    runtimeRoot: opts.runtimeRoot,
    pingTimeoutMs: opts.pingTimeoutMs,
    onEvent: opts.onEvent,
    findWineRunnerFn: opts.findWineRunnerFn,
    startCeServerFn: opts.startCeServerFn,
    readPtraceScopeFn: opts.readPtraceScopeFn,
    hasPtraceCapFn: opts.hasPtraceCapFn,
    engineNeedsPtraceGrantFn: opts.engineNeedsPtraceGrantFn,
    detect, effectivePid, processName, proton, ctPath, sessionId,
    onLauncherExit: () => {
      // If this session was active, drop it.
      if (active?.sessionId === sessionId && active.mode === 'ce') { active.stopWatch?.(); active = null; }
    },
  });
  const ready = backend.ready;

  const pick: PickContext = {
    tables, tableId, cacheKey: opts.cacheKey, ctCacheDir: opts.ctCacheDir,
    autoPick: opts.autoPick !== false,
    tableReadyTimeoutMs: opts.tableReadyTimeoutMs ?? 20_000,
    onProgress: opts.onProgress,
    onSteps: opts.onSteps,
    routes: new Map([[tableId, route]]),
  };
  const session: SessionState = { sessionId, mode: 'ce', ctPath, backend, records: [], pid: effectivePid, pick, route };
  active = session;
  session.stopWatch = watchGame(effectivePid, opts.isGameAlive ?? defaultIsGameAlive, opts.gameWatchMs ?? 2000, () => {
    if (active !== session) return;
    active = null;
    void scannerHost.end().catch(() => {});
    // The game is gone, so there's nothing to undo — just close Cheat Engine.
    void backend.close().catch(() => {});
    opts.onGameExit?.(sessionId);
  });

  // A starlightd hold can land while Cheat Engine is still starting (the claim
  // saw no CE session yet, or released CE halfway). Whenever that happened,
  // hand the game over rather than leave two engines on it.
  const handOver = async (): Promise<StartSessionResult | null> => {
    if (active !== session) throw new Error('The game closed while it was loading.');
    if (session.mode === 'ce') {
      if ((opts.starlightdHolders?.(effectivePid) ?? []).length === 0) return null;
      await releaseToStarlightd(sessionId);
    }
    const records = ctPath ? await recordsFromCt(ctPath) : [];
    session.records = records;
    return {
      sessionId, records, proton: proton !== null, needsPicker, attached: true, running: true,
      tables, tableId, process: { pid: effectivePid, name: processName },
      hiddenIds: findPrerequisites(records).map((p) => p.id),
      prereqErrors: {}, verdict: 'unknown', attempts: [], engine: engineOf('paused'), mode: 'paused', route,
      holders: opts.starlightdHolders?.(effectivePid) ?? [],
    };
  };
  const early = await handOver();
  if (early) return early;

  // Cheat Engine booted while the game was loading. Before matching a table,
  // let the game finish loading the modules the table points at.
  if (ctPath) {
    await waitForModules(opts, effectivePid, ctPath);
    if (active !== session) throw new Error('The game closed while it was loading.');
    const handed = await handOver();
    if (handed) return handed;
  }

  // The first check ran while the game may still have been loading, before it
  // mapped its anti-cheat. Look again now that it has loaded.
  const lateAntiCheat = await (opts.detectAntiCheatFn ?? detectAntiCheat)(effectivePid);
  if (lateAntiCheat) {
    await endSession({ sessionId }).catch(() => {});
    throw new Error(antiCheatMessage(lateAntiCheat));
  }
  const beforePick = await handOver();
  if (beforePick) return beforePick;

  const status = await sendWithTimeout(backend, { method: 'status' }, 5000).catch(() => ({})) as { attached?: boolean };
  const attached = status.attached !== false;
  let picked: Awaited<ReturnType<typeof pickTable>>;
  try {
    picked = await pickTable(session, { loaded: tableId, ready, attached });
  } catch (err) {
    // A release in the middle of the pick closed the bridge under it; the
    // session now belongs to starlightd and must stay.
    if (session.mode === 'paused' && active === session) return (await handOver())!;
    await endSession({ sessionId }).catch(() => {});
    throw err;
  }
  const afterPick = await handOver();
  if (afterPick) return afterPick;

  session.route = pick.routes.get(pick.tableId) ?? route;
  return {
    sessionId, records: picked.records, proton: proton !== null, needsPicker,
    attached, running: true,
    tables, tableId: pick.tableId,
    process: { pid: effectivePid, name: processName },
    tableError: picked.tableError,
    hiddenIds: picked.hiddenIds, prereqErrors: picked.prereqErrors,
    verdict: picked.verdict, attempts: picked.attempts, engine: engineOf('ce'), mode: 'ce', route: session.route, holders: [],
  };
}

/**
 * The native backend couldn't start the table: its Lua script failed (`lua:runtime`), or its
 * scripts don't assemble at the game's real bitness (`asm:error`). The session moves to Cheat Engine.
 */
class NativeStartError extends Error {
  constructor(
    message: string,
    readonly code: 'lua:runtime' | 'asm:error' = 'lua:runtime',
    readonly count = 1,
    readonly recordId: number | null = null,
    readonly recordName = '',
  ) { super(message); }
}

/** Lets a just-started game finish loading the modules the table points at. */
async function waitForModules(opts: StartSessionOpts, pid: number, ctPath: string): Promise<void> {
  const modules = referencedModules(await readFile(ctPath, 'utf8').catch(() => ''));
  const waitFn = opts.waitForGameFn ?? ((p: number, mods: string[]) => waitForGameReady({ pid: p, modules: mods }));
  // Only say so when it's noticeable (an already-loaded game returns at once).
  const slow = setTimeout(() => opts.onProgress?.('Waiting for the game to finish loading…'), 800);
  try { await waitFn(pid, modules); } finally { clearTimeout(slow); }
}

/**
 * A table that compiles runs on starlightd: no Cheat Engine, and the session
 * holds the game as `table` (D16). Anti-cheat was checked before routing; it is
 * checked again once the game has loaded its modules, as for Cheat Engine.
 */
async function startNativeSession(opts: StartSessionOpts, a: {
  pid: number; ctPath: string; tables: CtTable[]; tableId: number | null; needsPicker: boolean;
  decision: RouteDecision; route: RouteSummary | null;
  routeOf: (path: string, id: number) => Promise<RouteDecision | null>;
}): Promise<StartSessionResult> {
  const { pid, ctPath, tables, tableId, needsPicker } = a;

  // starlightd reads the game through ptrace access: refuse when it can't.
  const ptraceScope = await (opts.readPtraceScopeFn ?? readPtraceScope)();
  if (ptraceScope >= 3) throw new Error(PTRACE_LOCKED_MESSAGE);
  if (ptraceScope > 0 && await (opts.engineNeedsPtraceGrantFn?.() ?? false)) throw new Error(PTRACE_MESSAGE);

  let processName = opts.processName;
  if (!processName) processName = await (opts.readComm ?? defaultReadComm)(pid).catch(() => undefined);
  const proton = await (opts.detectProtonFn ?? detectProton)({ pid });

  const sessionId = randomUUID();
  const mainModule = mainModuleOf(processName);
  const attachFn = opts.attachEngineFn ?? (async (p: number, m?: string) => attach(await getEngineClient(), p, m ? { mainModule: m } : {}));
  const engineSession = await (mainModule ? attachFn(pid, mainModule) : attachFn(pid));
  const release = (opts.holdTable ?? (() => () => {}))(pid);
  // Set once the session is active: a dropped starlightd connection ends it.
  let offDetached = (): void => {};
  const endNative = async (): Promise<void> => {
    // Our own detach must not count as the connection dropping.
    offDetached();
    release();
    await engineSession.detach().catch(() => {});
  };

  // The table was checked at the bitness known when it was routed (64 while unknown). Before
  // anything of it runs, check it again at the game's real bitness if that differs.
  try {
    const bitsOf = async (): Promise<32 | 64 | null> =>
      typeof engineSession.codeBits === 'function' ? engineSession.codeBits().catch(() => null) : null;
    let bits = await bitsOf();
    if (bits === null && typeof engineSession.codeBits === 'function') {
      await waitForModules(opts, pid, ctPath);
      bits = await bitsOf();
    }
    if (bits !== null && bits !== (a.decision.bits ?? 64)) {
      const failures = await checkAllAssemble(engineSession.client, a.decision.compiled!, bits, opts.checkAssemblesFn ?? checkAssembles);
      if (failures.length > 0) {
        const f = failures[0]!;
        throw new NativeStartError(f.message, 'asm:error', failures.length, f.recordId, f.name);
      }
      a.decision.bits = bits;
    }
  } catch (err) {
    await endNative();
    throw err;
  }

  // Routes per path, so a table is compiled and assembled once per pick.
  const decisions = new Map<string, RouteDecision>([[ctPath, a.decision]]);
  let backend: TableBackend;
  try {
    backend = (opts.createNativeBackendFn ?? createNativeBackend)({
      session: engineSession,
      compiled: a.decision.compiled!,
      mainModule: processName ?? '',
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      loadCompiled: async (path): Promise<CompiledTable> =>
        decisions.get(path)?.compiled ?? compileTable(await readFile(path, 'utf8')),
    });
  } catch (err) {
    await endNative();
    throw err;
  }
  // The table's own Lua script runs once the game is attached.
  const started = await (backend.start?.() ?? Promise.resolve({ ok: true as const }));
  if (!started.ok) {
    await backend.close().catch(() => {});
    await endNative();
    throw new NativeStartError(started.error);
  }

  const pick: PickContext = {
    tables, tableId, cacheKey: opts.cacheKey, ctCacheDir: opts.ctCacheDir,
    autoPick: opts.autoPick !== false,
    tableReadyTimeoutMs: opts.tableReadyTimeoutMs ?? 20_000,
    onProgress: opts.onProgress,
    onSteps: opts.onSteps,
    routes: new Map([[tableId, a.route]]),
    route: async (path, id) => {
      const known = decisions.get(path);
      if (known) return known;
      const d = await a.routeOf(path, id);
      if (d) decisions.set(path, d);
      return d;
    },
  };
  const session: SessionState = {
    sessionId, mode: 'native', ctPath, backend, records: [], pid, pick, route: a.route, endNative,
  };
  active = session;

  // D17: a later candidate that needs Cheat Engine moves the session to it, once.
  pick.switchToCe = async (path: string): Promise<boolean> => {
    // The native table's own hold doesn't count; anyone else's keeps CE out.
    if ((opts.starlightdHolders?.(pid) ?? []).some((h) => h !== 'table')) return false;
    const old = session.backend;
    session.backend = null;
    if (old) {
      await sendWithTimeout(old, { method: 'shutdown' }, 5000).catch(() => {});
      try { await old.close(); } catch { /* ignore */ }
    }
    // Mode first: releasing the hold broadcasts session:engine with it.
    session.mode = 'ce';
    await endNativeOf(session);
    try {
      const detect = await ensureRuntime(opts);
      const proton2 = await (opts.detectProtonFn ?? detectProton)({ pid });
      session.backend = await launchCeBackend({
        runtimeRoot: opts.runtimeRoot,
        pingTimeoutMs: opts.pingTimeoutMs,
        onEvent: opts.onEvent,
        findWineRunnerFn: opts.findWineRunnerFn,
        startCeServerFn: opts.startCeServerFn,
        readPtraceScopeFn: opts.readPtraceScopeFn,
        hasPtraceCapFn: opts.hasPtraceCapFn,
        engineNeedsPtraceGrantFn: opts.engineNeedsPtraceGrantFn,
        detect, effectivePid: pid, processName, proton: proton2, ctPath: path, sessionId,
        onLauncherExit: () => {
          if (active?.sessionId === sessionId && active.mode === 'ce') { active.stopWatch?.(); active = null; }
        },
      });
    } catch (err) {
      throw new CeSwitchError(err instanceof Error ? err.message : String(err));
    }
    return true;
  };

  // The game exits, or starlightd's connection drops: the session ends, once,
  // like a Cheat Engine session does when its game exits.
  const gone = (): void => {
    if (active !== session) return;
    active = null;
    session.stopWatch?.();
    void scannerHost.end().catch(() => {});
    // Close whichever backend runs the table now, then detach and release.
    void (async () => {
      try { await session.backend?.close(); } catch { /* ignore */ }
      await endNativeOf(session);
    })();
    opts.onGameExit?.(sessionId);
  };
  session.stopWatch = watchGame(pid, opts.isGameAlive ?? defaultIsGameAlive, opts.gameWatchMs ?? 2000, gone);
  offDetached = engineSession.onDetached(gone);
  if (!engineSession.attached) gone();

  const pausedResult = async (): Promise<StartSessionResult> => {
    const records = await recordsFromCt(session.ctPath ?? ctPath);
    session.records = records;
    return {
      sessionId, records, proton: proton !== null, needsPicker, attached: true, running: true,
      tables, tableId: pick.tableId, process: { pid, name: processName },
      hiddenIds: findPrerequisites(records).map((p) => p.id),
      prereqErrors: {}, verdict: 'unknown', attempts: [], engine: engineOf('paused'), mode: 'paused',
      route: pick.routes.get(pick.tableId) ?? a.route,
      holders: opts.starlightdHolders?.(pid) ?? [],
    };
  };

  let picked: Awaited<ReturnType<typeof pickTable>>;
  let attached: boolean;
  try {
    await waitForModules(opts, pid, ctPath);
    if (active !== session) throw new Error('The game closed while it was loading.');

    // The first check ran while the game may still have been loading.
    const lateAntiCheat = await (opts.detectAntiCheatFn ?? detectAntiCheat)(pid);
    if (lateAntiCheat) throw new Error(antiCheatMessage(lateAntiCheat));

    const status = await sendWithTimeout(backend, { method: 'status' }, 5000).catch(() => ({})) as { attached?: boolean };
    attached = status.attached !== false;
    picked = await pickTable(session, { loaded: tableId, ready: true, attached });
  } catch (err) {
    pick.switchToCe = undefined;
    // Switched to Cheat Engine and then released to starlightd mid-pick.
    if (session.mode === 'paused' && active === session) return pausedResult();
    await endSession({ sessionId }).catch(() => {});
    throw err;
  }
  // D17 applies to the startup pick only: a later retry keeps the session native.
  pick.switchToCe = undefined;
  if (active !== session) throw new Error('The game closed while it was loading.');

  // On Cheat Engine now: a hold that landed while it started hands the game over.
  if (session.mode === 'ce' && (opts.starlightdHolders?.(pid) ?? []).length > 0) {
    await releaseToStarlightd(sessionId);
  }
  if (session.mode === 'paused') return pausedResult();

  const mode = session.mode;
  session.route = pick.routes.get(pick.tableId) ?? a.route;
  return {
    sessionId, records: picked.records, proton: proton !== null, needsPicker,
    attached, running: true,
    tables, tableId: pick.tableId,
    process: { pid, name: processName },
    tableError: picked.tableError,
    hiddenIds: picked.hiddenIds, prereqErrors: picked.prereqErrors,
    verdict: picked.verdict, attempts: picked.attempts, engine: engineOf(mode), mode, route: session.route,
    holders: mode === 'native' ? opts.starlightdHolders?.(pid) ?? [] : [],
  };
}

/** Polls until the table load Cheat Engine is doing has finished (or the window closes). */
async function waitTableReady(backend: TableBackend, timeoutMs: number, alreadyReady = false): Promise<boolean> {
  let ready = alreadyReady;
  const deadline = Date.now() + timeoutMs;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const pong = await sendWithTimeout(backend, { method: 'ping' }, 2000).catch(() => null) as { ready?: boolean } | null;
    ready = pong?.ready === true;
  }
  return ready;
}

/** Switches a record on and waits out scripts that finish asynchronously. */
async function enableRecord(backend: TableBackend, id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await sendWithTimeout(backend, { method: 'set_active', params: { id, active: true } }, 45_000) as { ok?: boolean; error?: string; pending?: boolean };
    if (!r.ok) return { ok: false, error: cleanCeError(r.error ?? 'did not switch on') };
    if (!r.pending) return { ok: true };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 500));
      const s = await sendWithTimeout(backend, { method: 'refresh' }, 8000).catch(() => null) as { states?: unknown } | null;
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
async function prepareTable(backend: TableBackend, opts: { readyTimeoutMs: number; ready?: boolean | undefined; hasTable: boolean; attached: boolean }): Promise<PreparedTable> {
  const ready = await waitTableReady(backend, opts.readyTimeoutMs, opts.ready);
  const status = await sendWithTimeout(backend, { method: 'status' }, 5000).catch(() => ({})) as { tableError?: string };
  const list = async (): Promise<CeRecord[]> => {
    const reply = await sendWithTimeout(backend, { method: 'list_records' }, 10_000).catch(() => ({})) as { records?: unknown };
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
      const r = await enableRecord(backend, p.id);
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
        const c = await sendWithTimeout(backend, { method: 'check_script', params: { id: r.id } }, 60_000).catch(() => ({ unknown: true })) as { ok?: boolean; unknown?: boolean };
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
  // Replaced once if a candidate moves the session from starlightd to Cheat Engine (D17).
  let backend = s.backend!;
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
  let current = await prepareTable(backend, { readyTimeoutMs: ctx.tableReadyTimeoutMs, ready: first.ready, hasTable, attached });
  let currentId = first.loaded;
  note(currentId, current.verdict);
  step(currentId, current.verdict);

  const load = async (t: CtTable): Promise<boolean> => {
    const cacheKey = t.id === 0 ? ctx.cacheKey : `${ctx.cacheKey}-a${t.id}`;
    const { ctPath } = await downloadCtToDisk({ source: t.url, cacheDir: ctx.ctCacheDir, cacheKey });
    if (ctx.route && s.mode === 'native') {
      // Each candidate is routed once it's downloaded. One that needs Cheat
      // Engine starts it with the table loaded; the session stays on CE.
      const d = await ctx.route(ctPath, t.id);
      ctx.routes.set(t.id, routeSummary(d));
      if (d?.engine !== 'native') {
        if (!ctx.switchToCe) {
          console.log(`[ct-runner] ${ctx.cacheKey}#${t.id}: needs Cheat Engine; skipped while the table runs on Starlight's engine`);
          return false;
        }
        if (!(await ctx.switchToCe(ctPath))) return false;
        backend = s.backend!;
        s.ctPath = ctPath;
        return true;
      }
    } else if (ctx.route && s.mode === 'ce') {
      // Cheat Engine is up: it runs every later table, whatever its route.
      const label = `${ctx.cacheKey}#${t.id}`;
      console.log(ceRunningLine(label));
      ctx.routes.set(t.id, routeSummary(outsideRoute(ROUTE_CE_RUNNING, 'cheat engine already running', { compiled: null, records: 0, sha256: '' })));
    }
    // The backend translates the path for its engine (Wine's Z: drive for CE).
    const r = await sendWithTimeout(backend, { method: 'load_table', params: { path: ctPath } }, 30_000) as { ok?: boolean };
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
        current = await prepareTable(backend, { readyTimeoutMs: ctx.tableReadyTimeoutMs, hasTable: true, attached: true });
        currentId = t.id;
        note(t.id, current.verdict);
        step(t.id, current.verdict);
        tried.push({ id: t.id, prepared: current });
        if (current.verdict === 'works') break;
      } catch (err) {
        // Cheat Engine didn't start after the native backend was put away: nothing is left to try with.
        if (err instanceof CeSwitchError) throw err;
        step(t.id, 'unknown'); /* unreachable or unloadable table: move on */
      }
    }
    if (current.verdict !== 'works') {
      // Nothing verified. Prefer one we couldn't judge over one known not to
      // match, and the earliest (the remembered / newest) among equals.
      const best = tried.find((x) => x.prepared.verdict === 'unknown') ?? tried[0]!;
      if (best.id !== currentId) {
        const t = ctx.tables.find((x) => x.id === best.id);
        if (t && await load(t).catch(() => false)) {
          current = await prepareTable(backend, { readyTimeoutMs: ctx.tableReadyTimeoutMs, hasTable: true, attached: true });
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
  if (!s.backend || !s.pick) return { ok: false, error: 'not attached to a game process' };
  try {
    // Start from a clean table: reload the current one so half-applied
    // prerequisites from the last attempt don't linger.
    const cur = s.pick.tables.find((t) => t.id === s.pick!.tableId);
    if (cur && s.ctPath) {
      await sendWithTimeout(s.backend, { method: 'load_table', params: { path: s.ctPath } }, 30_000);
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
async function sendWithTimeout(backend: TableBackend, cmd: { method: string; params?: unknown }, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cheat Engine did not respond (timed out)')), ms);
  });
  try {
    return await Promise.race([backend.send(cmd), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function setActive(req: { sessionId: string; recordId: number; active: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (!active || active.sessionId !== req.sessionId) {
    return { ok: false, error: 'session not active' };
  }
  if (active.mode === 'paused') return { ok: false, error: PAUSED_MESSAGE };
  if (!active.backend) {
    return { ok: false, error: 'not attached to a game process' };
  }
  try {
    // Enabling can run an AOB scan over the whole game, and a failure is
    // diagnosed by a second pass — allow for both.
    const r = await sendWithTimeout(active.backend, { method: 'set_active', params: { id: req.recordId, active: req.active } }, 30_000) as { ok?: boolean; error?: string };
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
  set_hotkeys: 8000,
};

/**
 * Runs one of the allow-listed session commands (value edits, game speed,
 * memory scanner). Always resolves: failures come back as `{ ok: false, error }`.
 */
export async function callSession(req: { sessionId: string; method: string; params?: unknown }): Promise<Record<string, unknown>> {
  if (!active || active.sessionId !== req.sessionId) return { ok: false, error: 'session not active' };
  if (req.method === 'speed_set' && active.mode === 'ce') {
    return { ok: false, error: 'Game speed runs through Cheat Engine for this table.' };
  }
  // Game speed runs on starlightd whenever Cheat Engine doesn't run the table (D18).
  if (active.mode === 'native' && req.method === 'set_speed') {
    if (active.pid === null) return { ok: false, error: 'not attached to a game process' };
    return scannerHost.call(active.pid, 'speed_set', req.params);
  }
  if (active.mode === 'paused') {
    if (active.pid === null) return { ok: false, error: 'not attached to a game process' };
    if (req.method === 'set_speed') return scannerHost.call(active.pid, 'speed_set', req.params);
    if (!SCANNER_METHODS.has(req.method)) return { ok: false, error: PAUSED_MESSAGE };
  }
  if (SCANNER_METHODS.has(req.method)) {
    if (active.pid === null) return { ok: false, error: 'not attached to a game process' };
    return scannerHost.call(active.pid, req.method, req.params);
  }
  if (!active.backend) return { ok: false, error: 'not attached to a game process' };
  const timeout = CALLABLE[req.method];
  if (timeout === undefined) return { ok: false, error: `unsupported command: ${req.method}` };
  try {
    const r = await sendWithTimeout(active.backend, { method: req.method, params: req.params }, timeout);
    const out = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    if (typeof out['error'] === 'string') out['error'] = cleanCeError(out['error']);
    return out;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const PAUSED_MESSAGE = 'the Cheat Engine table is paused';

/** The active Cheat Engine session on this game, if one is connected. */
export function ceSessionFor(pid: number): { sessionId: string } | null {
  return active && active.mode === 'ce' && active.backend !== null && active.pid === pid ? { sessionId: active.sessionId } : null;
}

/**
 * Hands the game from Cheat Engine to starlightd: the same shutdown as
 * ending a CE session (cheats off, bridge closed, CE killed), but the session
 * stays active in starlightd mode with its pid and records.
 */
export async function releaseToStarlightd(sessionId: string): Promise<boolean> {
  const s = active;
  if (!s || s.sessionId !== sessionId || s.mode !== 'ce' || !s.backend) return false;
  const { backend } = s;
  // Flip first: CE's exit callback must not clear a session that lives on.
  s.mode = 'paused';
  s.backend = null;
  await sendWithTimeout(backend, { method: 'shutdown' }, 5000).catch(() => {});
  try { await backend.close(); } catch { /* ignore */ }
  for (const r of s.records) r.isActive = false;
  return true;
}

export async function endSession(req: { sessionId: string }): Promise<{ ok: boolean }> {
  const s = active;
  if (!s || s.sessionId !== req.sessionId) return { ok: true };
  active = null;
  s.stopWatch?.();
  // Release the scanner's freezes and detach before CE goes.
  await scannerHost.end().catch(() => {});
  // Put the game back first: disable active cheats (runs their [DISABLE]),
  // restore normal speed, release frozen values. Killing CE without this
  // leaves code patches in the game, and the next attach then fails because
  // the table no longer recognises the patched bytes.
  if (s.backend) await sendWithTimeout(s.backend, { method: 'shutdown' }, 5000).catch(() => {});
  try { await s.backend?.close(); } catch { /* ignore */ }
  // A native table: detach starlightd's session and release the game.
  await endNativeOf(s);
  return { ok: true };
}

export function getActiveSession(): SessionState | null {
  return active;
}
