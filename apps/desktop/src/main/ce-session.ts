import { randomUUID } from 'node:crypto';
import { readFile, copyFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { detectCeRuntime } from './ce-runtime-detect.js';
import { createBridge, type Bridge } from './ce-bridge.js';
import { generateControlScript } from './ce-control-script.js';
import { spawnCeProcess, type CeProcessHandle, type CeProtonLaunch } from './ce-process.js';
import { downloadCtToDisk } from './ct-cache.js';
import { detectProton, type ProtonInfo } from './proton-detect.js';
import { readExeName } from './proc-exe-name.js';
import { matchGameToProcess, type MatchableGame } from './game-matcher.js';
import { listCtRecords } from '@starlight/ct-importer';
import type { DetectedGame, DetectedProcess } from '../shared/ipc.js';

/** Path to the Windows CE inside an extracted runtime, relative to installDir. */
const WIN_CE_RELATIVE = 'windowsbin/cheatengine-x86_64.exe';

/** Convert a Linux path to the Wine drive-Z form CE understands (Z:\a\b). */
export function toWinePath(linuxPath: string): string {
  return 'Z:' + linuxPath.replace(/\//g, '\\');
}

/**
 * The control script does `require("json")`. Linux CE ships `lua/json.lua`, but
 * the extracted Windows CE build does not — without it the autorun aborts before
 * the bridge starts. Copy the module next to Windows CE so `require` resolves.
 */
export async function ensureWinCeJson(installDir: string): Promise<void> {
  const dest = join(installDir, 'windowsbin', 'lua', 'json.lua');
  try { await access(dest, constants.F_OK); return; } catch { /* missing — copy it */ }
  const src = join(installDir, 'lua', 'json.lua');
  await mkdir(join(installDir, 'windowsbin', 'lua'), { recursive: true });
  await copyFile(src, dest);
}

export interface CeRecord {
  id: number;
  name: string;
  isActive: boolean;
  isGroupHeader: boolean;
}

export interface SessionState {
  sessionId: string;
  ctPath: string;
  /** null in a preview session (records parsed from the CT, no CE launched). */
  bridge: Bridge | null;
  ceProcess: CeProcessHandle | null;
  records: CeRecord[];
}

/** Reads the cheat list straight from the .CT — no Cheat Engine needed. */
async function recordsFromCt(ctPath: string): Promise<CeRecord[]> {
  const xml = await readFile(ctPath, 'utf8');
  return listCtRecords(xml).map((r) => ({ ...r, isActive: false }));
}

let active: SessionState | null = null;

export interface StartSessionOpts {
  source: string;       // URL of the .CT or viewtopic page
  cacheKey: string;     // unique key per catalog entry id
  runtimeRoot: string;
  ctCacheDir: string;
  pingTimeoutMs?: number;
  /** Target game process (Linux pid). Enables attach + Proton detection. */
  pid?: number | undefined;
  /** Target process name (e.g. "9Kings.exe"). Derived from /proc/<pid>/comm if omitted. */
  processName?: string | undefined;
  // Auto-attach via game identity:
  game?: MatchableGame | undefined;
  detectedGames?: DetectedGame[] | undefined;
  processes?: DetectedProcess[] | undefined;
  resolveMatch?: typeof matchGameToProcess | undefined;
  // Injectables for tests:
  detectProtonFn?: typeof detectProton;
  readComm?: (pid: number) => Promise<string>;
}

async function defaultReadComm(pid: number): Promise<string> {
  // Prefer the full exe name from cmdline: Windows CE's openProcess needs the
  // untruncated name (e.g. "RSDragonwilds.exe"), but /proc/<pid>/comm is clipped
  // to 15 chars ("RSDragonwilds.e"), which CE can't match. Fall back to comm.
  const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
  return (await readExeName(pid, comm)) ?? comm;
}

export async function startSession(opts: StartSessionOpts): Promise<{ sessionId: string; records: CeRecord[]; proton: boolean; needsPicker: boolean }> {
  if (active) await endSession({ sessionId: active.sessionId }).catch(() => {});

  const detect = await detectCeRuntime({ runtimeRoot: opts.runtimeRoot });
  if (detect.status !== 'ready') {
    throw new Error('CE runtime not installed');
  }

  const { ctPath } = await downloadCtToDisk({ source: opts.source, cacheDir: opts.ctCacheDir, cacheKey: opts.cacheKey });

  // Reactive auto-attach: if no explicit pid but a game identity is given, resolve it.
  let effectivePid = opts.pid;
  let needsPicker = false;
  if (effectivePid === undefined && opts.game) {
    const match = await (opts.resolveMatch ?? matchGameToProcess)(opts.game, {
      processes: opts.processes ?? [],
      detectedGames: opts.detectedGames ?? [],
    });
    if (match === null) throw new Error('game not running');
    if (match === 'ambiguous') { needsPicker = true; }
    else { effectivePid = match.pid; }
  }

  // No attach target (ambiguous match, or a plain load with no process): show
  // the cheat list parsed straight from the .CT and DON'T launch Cheat Engine.
  // Booting CE just to preview would pop the Linux CE Patreon nag; the user
  // attaches (which re-runs this with a pid) when they pick a process.
  if (effectivePid === undefined) {
    const sessionId = randomUUID();
    const records = await recordsFromCt(ctPath);
    active = { sessionId, ctPath, bridge: null, ceProcess: null, records };
    return { sessionId, records, proton: false, needsPicker: true };
  }

  // Resolve the target process name and whether it's a Proton game.
  let processName = opts.processName;
  let proton: ProtonInfo | null = null;
  if (effectivePid !== undefined) {
    if (!processName) {
      processName = await (opts.readComm ?? defaultReadComm)(effectivePid).catch(() => undefined);
    }
    proton = await (opts.detectProtonFn ?? detectProton)({ pid: effectivePid });
  }

  const bridge = await createBridge();
  // The control script loads the table itself (dialogs muted first). Windows CE
  // needs the Wine `Z:\…` path; native Linux CE takes the Linux path.
  const ceCtPath = proton ? toWinePath(ctPath) : ctPath;
  const controlScript = generateControlScript({ bridgeUrl: bridge.url, openProcessName: processName, ctPath: ceCtPath });
  const sessionId = randomUUID();

  let protonLaunch: CeProtonLaunch | undefined;
  if (proton) {
    await ensureWinCeJson(detect.installDir);
    protonLaunch = {
      protonBin: proton.protonBin,
      winCeExe: join(detect.installDir, WIN_CE_RELATIVE),
      winCeDir: join(detect.installDir, 'windowsbin'),
      ctWinPath: toWinePath(ctPath),
      compatDataPath: proton.compatDataPath,
      clientInstallPath: proton.clientInstallPath,
    };
  }

  const ceProcess = await spawnCeProcess({
    binaryPath: detect.binary,
    installDir: detect.installDir,
    ctPath,
    controlScript,
    proton: protonLaunch,
    onExit: () => {
      // If this session was active, drop it.
      if (active?.sessionId === sessionId) active = null;
    },
  });

  // Windows CE cold-boots under Proton/Wine, which is much slower than native
  // Linux CE — give it a longer ping window.
  const defaultTimeout = proton ? 45_000 : 10_000;
  const deadline = Date.now() + (opts.pingTimeoutMs ?? defaultTimeout);
  let online = false;
  while (Date.now() < deadline) {
    try {
      await Promise.race([
        bridge.send({ method: 'ping' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timed out')), 500)),
      ]);
      online = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!online) {
    await bridge.close().catch(() => {});
    await ceProcess.kill('SIGTERM').catch(() => {});
    throw new Error('CE process spawned but timed out waiting for ping');
  }

  const reply = await bridge.send({ method: 'list_records' }) as { records?: CeRecord[] };
  const records = reply.records ?? [];

  active = { sessionId, ctPath, bridge, ceProcess, records };
  return { sessionId, records, proton: proton !== null, needsPicker };
}

export async function setActive(req: { sessionId: string; recordId: number; active: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (!active || active.sessionId !== req.sessionId) {
    return { ok: false, error: 'session not active' };
  }
  if (!active.bridge) {
    return { ok: false, error: 'not attached to a game process' };
  }
  try {
    const r = await active.bridge.send({ method: 'set_active', params: { id: req.recordId, active: req.active } }) as { ok?: boolean; error?: string };
    if (r.ok) {
      const rec = active.records.find((x) => x.id === req.recordId);
      if (rec) rec.isActive = req.active;
      return { ok: true };
    }
    return { ok: false, error: r.error ?? 'unknown error' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function endSession(req: { sessionId: string }): Promise<{ ok: boolean }> {
  const s = active;
  if (!s || s.sessionId !== req.sessionId) return { ok: true };
  active = null;
  try { await s.bridge?.close(); } catch { /* ignore */ }
  try { await s.ceProcess?.kill('SIGTERM'); } catch { /* ignore */ }
  return { ok: true };
}

export function getActiveSession(): SessionState | null {
  return active;
}
