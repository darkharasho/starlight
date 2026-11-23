import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installDaemon, socketPath, bundledBinaryPath, configureStarlightdHost, getEngineClient,
} from '../../src/main/starlightd-host.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sl-host-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function bundle(bytes = 'daemon-v1'): Promise<string> {
  const p = join(dir, 'bundled');
  await writeFile(p, bytes);
  return p;
}

describe('installDaemon', () => {
  it('copies when missing and reports changed', async () => {
    const bundled = await bundle();
    const r = await installDaemon({ bundled, runtimeRoot: join(dir, 'rt') });
    expect(r.changed).toBe(true);
    expect(r.path).toBe(join(dir, 'rt', 'starlightd', 'starlightd'));
    expect((await stat(r.path)).mode & 0o777).toBe(0o755);
  });

  it('skips copy when sha256 matches', async () => {
    const bundled = await bundle();
    const first = await installDaemon({ bundled, runtimeRoot: join(dir, 'rt') });
    const m1 = (await stat(first.path)).mtimeMs;
    const second = await installDaemon({ bundled, runtimeRoot: join(dir, 'rt') });
    expect(second.changed).toBe(false);
    expect((await stat(second.path)).mtimeMs).toBe(m1);
  });

  it('replaces a different binary', async () => {
    const bundled = await bundle('new-bytes');
    const first = await installDaemon({ bundled, runtimeRoot: join(dir, 'rt') });
    await writeFile(first.path, 'old-bytes');
    const r = await installDaemon({ bundled, runtimeRoot: join(dir, 'rt') });
    expect(r.changed).toBe(true);
    expect(await readFile(r.path, 'utf8')).toBe('new-bytes');
  });
});

describe('paths', () => {
  it('socketPath prefers XDG_RUNTIME_DIR', async () => {
    const xdg = join(dir, 'run');
    expect(socketPath({ XDG_RUNTIME_DIR: xdg }, 1000)).toBe(join(xdg, 'starlight', 'starlightd.sock'));
    expect((await stat(join(xdg, 'starlight'))).mode & 0o777).toBe(0o700);
  });

  it('socketPath falls back to the temp dir', () => {
    const p = socketPath({}, 4242);
    expect(p).toBe(join(tmpdir(), 'starlight-4242', 'starlightd.sock'));
  });

  it('bundledBinaryPath dev vs packaged', () => {
    expect(bundledBinaryPath({ isPackaged: true, resourcesPath: '/res', appPath: '/x' })).toBe('/res/starlightd');
    expect(bundledBinaryPath({ isPackaged: false, resourcesPath: '/res', appPath: '/repo/apps/desktop' }))
      .toBe('/repo/packages/starlightd/target/release/starlightd');
  });
});

describe('getEngineClient', () => {
  it('respawns the daemon after it dies', async () => {
    const bundled = await bundle();
    const closers: Array<() => void> = [];
    let starts = 0;
    const start = (async () => {
      starts++;
      let closed = false;
      const client = {
        get closed() { return closed; },
        onClose(cb: () => void) { closers.push(() => { closed = true; cb(); }); },
      };
      return { client, pid: starts, stop: async () => undefined };
    }) as never;
    configureStarlightdHost({
      runtimeRoot: join(dir, 'rt'), isPackaged: true, resourcesPath: dir, appPath: dir, start,
    });
    await rm(join(dir, 'starlightd'), { force: true });
    await writeFile(join(dir, 'starlightd'), await readFile(bundled));
    const a = await getEngineClient();
    expect(await getEngineClient()).toBe(a);
    expect(starts).toBe(1);
    closers[0]!();
    const b = await getEngineClient();
    expect(b).not.toBe(a);
    expect(starts).toBe(2);
  });
});
