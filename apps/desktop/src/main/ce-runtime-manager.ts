import { join } from 'node:path';
import { detectCeRuntime, WIN_CE_DIR, CESERVER_DIR, CESERVER_BIN, type DetectResult } from './ce-runtime-detect.js';
import { installCeServer, installWindowsCe, type ProgressEvent } from './ce-runtime-install.js';
import type { CeRuntimeStatus } from '../shared/ipc.js';

// Keeps the trainer engine (Windows CE + ceserver) installed without asking:
// whatever is missing is downloaded in the background when Starlight starts,
// and a session that needs it waits for that download instead of failing.

export interface RuntimeManifest {
  cheatEngine: {
    windows?: { url: string; sha256: string };
    ceserver?: { url: string; sha256: string; extractedDir?: string; binaryRelative?: string };
  };
}

export type EnsureResult = { ok: true; status: Extract<DetectResult, { status: 'ready' }> } | { ok: false; error: string };

export interface RuntimeManagerDeps {
  runtimeRoot: string;
  fetchManifest: () => Promise<RuntimeManifest>;
  /** Told about every status change (installing progress, ready, failed). */
  onStatus?: (status: CeRuntimeStatus, error?: string) => void;
  detect?: typeof detectCeRuntime;
  installWindowsCe?: typeof installWindowsCe;
  installCeServer?: typeof installCeServer;
  /** Delays between automatic retries after a failed background install. */
  retryDelaysMs?: number[];
}

export interface RuntimeManager {
  /** Current status; `installing` while a download runs. */
  status: () => Promise<CeRuntimeStatus>;
  /** The last install error, if the most recent attempt failed. */
  lastError: () => string | null;
  /** Installs whatever is missing. Concurrent callers share one install. */
  ensure: () => Promise<EnsureResult>;
  /** ensure(), then keep retrying in the background if it fails. */
  ensureInBackground: () => void;
  /** Stops pending retries. */
  dispose: () => void;
}

export const DEFAULT_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

export function createRuntimeManager(deps: RuntimeManagerDeps): RuntimeManager {
  const detect = deps.detect ?? detectCeRuntime;
  const winInstall = deps.installWindowsCe ?? installWindowsCe;
  const srvInstall = deps.installCeServer ?? installCeServer;
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  let inFlight: Promise<EnsureResult> | null = null;
  let progress: CeRuntimeStatus | null = null;
  let error: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;

  const notify = (s: CeRuntimeStatus): void => { deps.onStatus?.(s, error ?? undefined); };

  async function install(): Promise<EnsureResult> {
    const before = await detect({ runtimeRoot: deps.runtimeRoot });
    if (before.status === 'ready') return { ok: true, status: before };

    const onProgress = (e: ProgressEvent): void => {
      if (e.phase === 'done') return;
      progress = { status: 'installing', phase: e.phase, ...('current' in e ? { current: e.current, total: e.total } : {}) };
      notify(progress);
    };
    progress = { status: 'installing', phase: 'preparing' };
    notify(progress);

    const manifest = await deps.fetchManifest();
    if (before.missing.includes('windows-ce')) {
      const win = manifest.cheatEngine.windows;
      if (!win) throw new Error('The runtime list has no Windows Cheat Engine.');
      await winInstall({ url: win.url, sha256: win.sha256, destDir: join(deps.runtimeRoot, WIN_CE_DIR), onProgress });
    }
    if (before.missing.includes('ceserver')) {
      const srv = manifest.cheatEngine.ceserver;
      if (!srv) throw new Error('The runtime list has no ceserver.');
      await srvInstall({
        url: srv.url,
        sha256: srv.sha256,
        runtimeRoot: deps.runtimeRoot,
        binaryRelative: srv.binaryRelative ?? `${srv.extractedDir ?? CESERVER_DIR}/${CESERVER_BIN}`,
        onProgress,
      });
    }
    const after = await detect({ runtimeRoot: deps.runtimeRoot });
    if (after.status !== 'ready') throw new Error(`The trainer engine is still missing ${after.missing.join(' and ')} after installing.`);
    return { ok: true, status: after };
  }

  const manager: RuntimeManager = {
    status: async () => progress ?? detect({ runtimeRoot: deps.runtimeRoot }),
    lastError: () => error,
    ensure: () => {
      if (inFlight) return inFlight;
      inFlight = (async (): Promise<EnsureResult> => {
        try {
          const r = await install();
          error = null;
          return r;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          return { ok: false, error };
        } finally {
          progress = null;
          inFlight = null;
          notify(await detect({ runtimeRoot: deps.runtimeRoot }));
        }
      })();
      return inFlight;
    },
    ensureInBackground: () => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      void manager.ensure().then((r) => {
        if (r.ok) { retryIndex = 0; return; }
        const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)];
        retryIndex += 1;
        if (delay === undefined) return;
        retryTimer = setTimeout(() => { retryTimer = null; manager.ensureInBackground(); }, delay);
        retryTimer.unref?.();
      });
    },
    dispose: () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; },
  };
  return manager;
}
