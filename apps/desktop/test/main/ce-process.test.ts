import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnCeProcess, type CeProcessHandle } from '../../src/main/ce-process.js';

let dir: string;
let installDir: string;
let binary: string;
let ctPath: string;
let handle: CeProcessHandle | undefined;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-ceproc-${Date.now()}-${Math.random()}`);
  installDir = join(dir, 'install');
  await mkdir(installDir, { recursive: true });
  await mkdir(join(installDir, 'autorun'), { recursive: true });
  binary = join(installDir, 'fake-ce.sh');
  // Fake binary: writes argv[1] to a probe file then exits 0.
  await writeFile(binary, '#!/bin/sh\necho "$1" > /tmp/starlight-fake-ce-probe\nexit 0\n');
  await chmod(binary, 0o755);
  ctPath = join(dir, 'trainer.CT');
  await writeFile(ctPath, '<CheatTable />');
});
afterEach(async () => {
  if (handle) await handle.kill('SIGKILL').catch(() => {});
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
  await rm('/tmp/starlight-fake-ce-probe', { force: true });
});

describe('spawnCeProcess', () => {
  it('writes the autorun script, spawns the binary with the CT path, and triggers onExit', async () => {
    let exitCode: number | null = -1;
    const exited = new Promise<void>((resolve) => {
      const onExit = (code: number | null): void => { exitCode = code; resolve(); };
      void (async () => {
        handle = await spawnCeProcess({
          binaryPath: binary, installDir, ctPath, controlScript: '-- starlight test\n', onExit,
        });
        // Verify autorun was written before child completes.
        const wrote = await readFile(join(installDir, 'autorun', 'zzz-starlight.lua'), 'utf8');
        expect(wrote).toContain('starlight test');
      })();
    });
    await exited;
    expect(exitCode).toBe(0);
    // Probe shows the binary received the .CT path as argv[1].
    const probe = await readFile('/tmp/starlight-fake-ce-probe', 'utf8');
    expect(probe.trim()).toBe(ctPath);
  });

  it('removes the autorun script after the child exits', async () => {
    const exited = new Promise<void>((resolve) => {
      void (async () => {
        handle = await spawnCeProcess({
          binaryPath: binary, installDir, ctPath, controlScript: 'x',
          onExit: () => resolve(),
        });
      })();
    });
    await exited;
    // Give the cleanup hook a tick.
    await new Promise((r) => setTimeout(r, 50));
    await expect(access(join(installDir, 'autorun', 'zzz-starlight.lua'))).rejects.toBeTruthy();
  });

  it('kill() resolves after the child exits', async () => {
    // Replace fake binary with one that sleeps so we can kill it mid-run.
    await writeFile(binary, '#!/bin/sh\nsleep 30\n');
    await chmod(binary, 0o755);
    handle = await spawnCeProcess({
      binaryPath: binary, installDir, ctPath, controlScript: 'x', onExit: () => {},
    });
    const start = Date.now();
    await handle.kill('SIGTERM');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it('forwards stderr lines via onStderrLine when provided', async () => {
    await writeFile(binary, '#!/bin/sh\necho "first error" 1>&2\necho "second error" 1>&2\nexit 0\n');
    await chmod(binary, 0o755);
    const lines: string[] = [];
    const exited = new Promise<void>((resolve) => {
      void (async () => {
        handle = await spawnCeProcess({
          binaryPath: binary, installDir, ctPath, controlScript: 'x',
          onStderrLine: (l) => { lines.push(l); },
          onExit: () => resolve(),
        });
      })();
    });
    await exited;
    expect(lines).toContain('first error');
    expect(lines).toContain('second error');
  });
});
