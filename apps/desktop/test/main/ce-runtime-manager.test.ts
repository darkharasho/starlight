// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createRuntimeManager, type RuntimeManagerDeps } from '../../src/main/ce-runtime-manager.js';
import type { DetectResult } from '../../src/main/ce-runtime-detect.js';
import type { CeRuntimeStatus } from '../../src/shared/ipc.js';

const READY: DetectResult = { status: 'ready', winCeDir: '/rt/w', winCeExe: '/rt/w/ce.exe', ceserver: '/rt/s/ceserver' };
const MANIFEST = {
  cheatEngine: {
    windows: { url: 'https://x/win.zip', sha256: 'aa' },
    ceserver: { url: 'https://x/srv.zip', sha256: 'bb', extractedDir: 'ceserver-7.5' },
  },
};

/** A fake install: detect reports `missing` until the installers have run. */
function setup(missing: ('windows-ce' | 'ceserver')[], extra: Partial<RuntimeManagerDeps> = {}) {
  const left = new Set(missing);
  const statuses: CeRuntimeStatus[] = [];
  const deps: RuntimeManagerDeps = {
    runtimeRoot: '/rt',
    fetchManifest: vi.fn(async () => MANIFEST),
    detect: vi.fn(async () => (left.size === 0 ? READY : { status: 'not-installed', missing: [...left] }) as DetectResult),
    installWindowsCe: vi.fn(async (o) => { o.onProgress({ phase: 'downloading', current: 5, total: 10 }); left.delete('windows-ce'); }),
    installCeServer: vi.fn(async () => { left.delete('ceserver'); }),
    onStatus: (s) => { statuses.push(s); },
    retryDelaysMs: [],
    ...extra,
  };
  return { deps, statuses, manager: createRuntimeManager(deps) };
}

describe('createRuntimeManager', () => {
  it('does nothing when everything is installed', async () => {
    const { deps, manager } = setup([]);
    expect(await manager.ensure()).toEqual({ ok: true, status: READY });
    expect(deps.fetchManifest).not.toHaveBeenCalled();
  });

  it('installs only the missing parts and reports progress, then ready', async () => {
    const { deps, statuses, manager } = setup(['ceserver']);
    expect((await manager.ensure()).ok).toBe(true);
    expect(deps.installWindowsCe).not.toHaveBeenCalled();
    expect(deps.installCeServer).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://x/srv.zip', sha256: 'bb', runtimeRoot: '/rt', binaryRelative: 'ceserver-7.5/ceserver',
    }));
    expect(statuses[0]).toEqual({ status: 'installing', phase: 'preparing' });
    expect(statuses.at(-1)).toEqual(READY);
  });

  it('reports download progress while installing', async () => {
    const { statuses, manager } = setup(['windows-ce', 'ceserver']);
    await manager.ensure();
    expect(statuses).toContainEqual({ status: 'installing', phase: 'downloading', current: 5, total: 10 });
  });

  it('shares one install between concurrent callers', async () => {
    const { deps, manager } = setup(['windows-ce', 'ceserver']);
    const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
    expect(a).toEqual(b);
    expect(deps.installWindowsCe).toHaveBeenCalledTimes(1);
  });

  it('shows the installing status to anyone asking mid-install', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { manager } = setup(['ceserver'], { installCeServer: vi.fn(async () => { await gate; }) });
    const p = manager.ensure();
    await new Promise((r) => setTimeout(r, 0));
    expect(await manager.status()).toMatchObject({ status: 'installing' });
    release();
    await p;
  });

  it('returns the error and keeps it until a later attempt succeeds', async () => {
    let fail = true;
    const { manager } = setup(['ceserver'], {
      fetchManifest: vi.fn(async () => { if (fail) throw new Error('offline'); return MANIFEST; }),
    });
    expect(await manager.ensure()).toEqual({ ok: false, error: 'offline' });
    expect(manager.lastError()).toBe('offline');
    fail = false;
    expect((await manager.ensure()).ok).toBe(true);
    expect(manager.lastError()).toBeNull();
  });

  it('retries a failed background install', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { manager } = setup(['ceserver'], {
        retryDelaysMs: [1000],
        fetchManifest: vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('offline'); return MANIFEST; }),
      });
      manager.ensureInBackground();
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.lastError()).toBe('offline');
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      expect(manager.lastError()).toBeNull();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
