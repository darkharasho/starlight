// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { startSession, setActive, endSession, getActiveSession, toWinePath } from '../../src/main/ce-session.js';

let dir: string;
let installDir: string;
let binary: string;
let ctCacheDir: string;
let ctServer: Server;
let ctServerPort: number;

async function startCtServer(): Promise<string> {
  return new Promise((resolve) => {
    ctServer = createServer((_req, res) => { res.writeHead(200); res.end('<CheatTable />'); });
    ctServer.listen(0, '127.0.0.1', () => {
      ctServerPort = (ctServer.address() as { port: number }).port;
      resolve(`http://127.0.0.1:${ctServerPort}/x.CT`);
    });
  });
}

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-ce-session-${Date.now()}-${Math.random()}`);
  installDir = join(dir, 'CheatEngineLinux766-4');
  await mkdir(join(installDir, 'autorun'), { recursive: true });
  binary = join(installDir, 'cheatengine-x86_64');
  // Default: a "stuck" binary that never responds.
  await writeFile(binary, '#!/bin/sh\nsleep 30\n');
  await chmod(binary, 0o755);
  ctCacheDir = join(dir, 'ctcache');
});
afterEach(async () => {
  if (getActiveSession()) await endSession({ sessionId: getActiveSession()!.sessionId }).catch(() => {});
  await new Promise<void>((r) => ctServer?.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('ce-session', () => {
  it('rejects start when runtime is not installed', async () => {
    // Use a dir where the binary does not exist.
    await rm(binary, { force: true });
    // Any source URL is fine — the detect failure gates before the download.
    const source = await startCtServer();
    await expect(startSession({
      source, cacheKey: 'k1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
    })).rejects.toThrow(/not installed|not-installed/i);
  });

  it('times out cleanly when CE never responds to ping', async () => {
    const source = await startCtServer();
    await expect(startSession({
      source, cacheKey: 'k2', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
    })).rejects.toThrow(/timed out|ping/i);
    expect(getActiveSession()).toBeNull();
  });

  it('endSession is idempotent and tolerates missing session', async () => {
    const r = await endSession({ sessionId: 'nonexistent' });
    expect(r.ok).toBe(true);
  });

  it('toWinePath maps a Linux path to the Wine Z: drive', () => {
    expect(toWinePath('/home/user/x.ct')).toBe('Z:\\home\\user\\x.ct');
  });

  it('launches Windows CE via proton run when the target is a Proton game', async () => {
    // A fake `proton` launcher that records how it was invoked, then hangs so
    // the ping loop times out (we assert on the invocation, not a live bridge).
    const marker = join(dir, 'proton-invoked.txt');
    const fakeProton = join(dir, 'proton');
    // cwd is the windowsbin dir, so the control script is at ./autorun/…
    await writeFile(fakeProton, `#!/bin/sh\necho "$@" > ${marker}\nenv | grep STEAM_COMPAT >> ${marker}\ncat autorun/zzz-starlight.lua >> ${marker} 2>/dev/null\nsleep 30\n`);
    await chmod(fakeProton, 0o755);
    // Windows CE binary must exist for the launch path.
    await mkdir(join(installDir, 'windowsbin', 'autorun'), { recursive: true });
    await writeFile(join(installDir, 'windowsbin', 'cheatengine-x86_64.exe'), 'stub');
    // The bundled json module the control script needs copied into windowsbin.
    await mkdir(join(installDir, 'lua'), { recursive: true });
    await writeFile(join(installDir, 'lua', 'json.lua'), '-- stub json module');

    const source = await startCtServer();
    await expect(startSession({
      source, cacheKey: 'proton1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 600,
      pid: 4242,
      readComm: async () => 'Game.exe',
      detectProtonFn: async () => ({
        compatDataPath: '/steam/compatdata/999',
        clientInstallPath: '/steam',
        protonDir: dir,
        protonBin: fakeProton,
      }),
    })).rejects.toThrow(/timed out|ping/i);

    const invocation = await readFile(marker, 'utf8');
    expect(invocation).toMatch(/\brun\b/);
    expect(invocation).toContain('windowsbin/cheatengine-x86_64.exe');
    expect(invocation).toContain('Z:\\'); // CT passed in Wine path form
    expect(invocation).toMatch(/STEAM_COMPAT_DATA_PATH=\/steam\/compatdata\/999/);
    // The control script written into the Windows CE autorun dir opens the game.
    expect(invocation).toContain('local OPEN_PROCESS_NAME = "Game.exe"');

    // json.lua was staged into windowsbin so `require("json")` resolves in Windows CE.
    const staged = await readFile(join(installDir, 'windowsbin', 'lua', 'json.lua'), 'utf8');
    expect(staged).toContain('stub json module');
  });

  it('auto-resolves the pid from game identity via the matcher', async () => {
    await writeFile(binary, '#!/bin/sh\nsleep 30\n'); await chmod(binary, 0o755);
    const source = await startCtServer();
    // matcher returns a pid → session proceeds to the (stub) proton launch and times out
    await mkdir(join(installDir, 'windowsbin', 'autorun'), { recursive: true });
    await writeFile(join(installDir, 'windowsbin', 'cheatengine-x86_64.exe'), 'stub');
    await mkdir(join(installDir, 'lua'), { recursive: true });
    await writeFile(join(installDir, 'lua', 'json.lua'), '--stub');
    const fakeProton = join(dir, 'proton');
    await writeFile(fakeProton, '#!/bin/sh\nsleep 30\n'); await chmod(fakeProton, 0o755);

    await expect(startSession({
      source, cacheKey: 'auto1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      game: { id: '9-kings', name: '9 Kings', steamAppId: 2784470 },
      resolveMatch: async () => ({ pid: 4242, name: '9Kings.exe' }),
      readComm: async () => '9Kings.exe',
      detectProtonFn: async () => ({ compatDataPath: '/steam/compatdata/2784470', clientInstallPath: '/steam', protonDir: dir, protonBin: fakeProton }),
    })).rejects.toThrow(/timed out|ping/i);
  });

  it('throws "game not running" when the matcher finds no process', async () => {
    await writeFile(binary, '#!/bin/sh\nsleep 30\n'); await chmod(binary, 0o755);
    const source = await startCtServer();
    await expect(startSession({
      source, cacheKey: 'auto2', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      game: { id: '9-kings', name: '9 Kings', steamAppId: null },
      resolveMatch: async () => null,
    })).rejects.toThrow(/not running/i);
  });
});
