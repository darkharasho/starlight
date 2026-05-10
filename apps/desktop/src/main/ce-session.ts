import { randomUUID } from 'node:crypto';
import { detectCeRuntime } from './ce-runtime-detect.js';
import { createBridge, type Bridge } from './ce-bridge.js';
import { generateControlScript } from './ce-control-script.js';
import { spawnCeProcess, type CeProcessHandle } from './ce-process.js';
import { downloadCtToDisk } from './ct-cache.js';

export interface CeRecord {
  id: number;
  name: string;
  isActive: boolean;
  isGroupHeader: boolean;
}

export interface SessionState {
  sessionId: string;
  ctPath: string;
  bridge: Bridge;
  ceProcess: CeProcessHandle;
  records: CeRecord[];
}

let active: SessionState | null = null;

export interface StartSessionOpts {
  source: string;       // URL of the .CT or viewtopic page
  cacheKey: string;     // unique key per catalog entry id
  runtimeRoot: string;
  ctCacheDir: string;
  pingTimeoutMs?: number;
}

export async function startSession(opts: StartSessionOpts): Promise<{ sessionId: string; records: CeRecord[] }> {
  if (active) await endSession({ sessionId: active.sessionId }).catch(() => {});

  const detect = await detectCeRuntime({ runtimeRoot: opts.runtimeRoot });
  if (detect.status !== 'ready') {
    throw new Error('CE runtime not installed');
  }

  const { ctPath } = await downloadCtToDisk({ source: opts.source, cacheDir: opts.ctCacheDir, cacheKey: opts.cacheKey });

  const bridge = await createBridge();
  const controlScript = generateControlScript({ bridgeUrl: bridge.url });
  const sessionId = randomUUID();

  const ceProcess = await spawnCeProcess({
    binaryPath: detect.binary,
    installDir: detect.installDir,
    ctPath,
    controlScript,
    onExit: () => {
      // If this session was active, drop it.
      if (active?.sessionId === sessionId) active = null;
    },
  });

  // Poll ping until CE comes online.
  const deadline = Date.now() + (opts.pingTimeoutMs ?? 10_000);
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
  return { sessionId, records };
}

export async function setActive(req: { sessionId: string; recordId: number; active: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (!active || active.sessionId !== req.sessionId) {
    return { ok: false, error: 'session not active' };
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
  try { await s.bridge.close(); } catch { /* ignore */ }
  try { await s.ceProcess.kill('SIGTERM'); } catch { /* ignore */ }
  return { ok: true };
}

export function getActiveSession(): SessionState | null {
  return active;
}
