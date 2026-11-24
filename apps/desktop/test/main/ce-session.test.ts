// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { startSession, releaseToStarlightd, ceSessionFor, setActive, endSession, getActiveSession, toWinePath, callSession, retryTables, cleanCeError, isStaleTableError } from '../../src/main/ce-session.js';
import { PTRACE_MESSAGE } from '../../src/main/ce-native.js';
import type { CeBackend } from '../../src/main/ce-backend.js';
import type { BackendCommand, TableBackend } from '../../src/main/table-backend.js';
import type { NativeBackendDeps } from '../../src/main/native-backend.js';
import type { RouteDecision } from '../../src/main/ct-runner.js';
import type { CompiledTable } from '@starlight/ct-importer';
import type { Session } from '@starlight/engine';

const scannerHost = vi.hoisted(() => ({
  call: vi.fn(async () => ({ ok: true, from: 'scanner' }) as Record<string, unknown>),
  end: vi.fn(async () => undefined),
}));
vi.mock('../../src/main/scanner-host.js', async (orig) => ({
  ...(await orig<typeof import('../../src/main/scanner-host.js')>()),
  createScannerHost: () => scannerHost,
}));

const hotkeyHost = vi.hoisted(() => ({ clearSessionHotkeys: vi.fn(), setSessionHotkeys: vi.fn() }));
vi.mock('../../src/main/hotkey-host.js', () => hotkeyHost);

/** Records every Cheat Engine launch (the real spawn still runs). */
const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ce-process.js', async (orig) => {
  const real = await orig<typeof import('../../src/main/ce-process.js')>();
  return {
    ...real,
    spawnCeProcess: (...a: Parameters<typeof real.spawnCeProcess>) => { spawnSpy(...a); return real.spawnCeProcess(...a); },
  };
});

let dir: string;
/** Windows CE's directory in the runtime (CheatEngineWindows75). */
let winCeDir: string;
/** Stands in for the Wine launcher; the live tests make it a scripted CE. */
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
  winCeDir = join(dir, 'CheatEngineWindows75');
  await mkdir(join(winCeDir, 'autorun'), { recursive: true });
  await mkdir(join(winCeDir, 'lua'), { recursive: true });
  await writeFile(join(winCeDir, 'cheatengine-x86_64.exe'), 'MZ');
  await writeFile(join(winCeDir, 'lua', 'json.lua'), '-- json');
  await mkdir(join(dir, 'ceserver-7.5'), { recursive: true });
  await writeFile(join(dir, 'ceserver-7.5', 'ceserver'), '#!/bin/sh\n');
  await chmod(join(dir, 'ceserver-7.5', 'ceserver'), 0o755);
  binary = join(dir, 'fake-wine');
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

/** A native game: Windows CE "runs" through `binary`, ceserver is stubbed. */
const ceServerStops: number[] = [];
const nativeLaunch = {
  findWineRunnerFn: async () => ({ kind: 'wine' as const, command: binary, args: [], env: {}, prefixDir: join(dir, 'prefix', 'wine') }),
  startCeServerFn: async () => ({ port: 52736, stop: async () => { ceServerStops.push(1); } }),
  readPtraceScopeFn: async () => 0,
};

describe('ce-session', () => {
  it('rejects an attach when the trainer engine is missing and nothing can install it', async () => {
    await rm(join(winCeDir, 'cheatengine-x86_64.exe'), { force: true });
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'k1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
    })).rejects.toThrow(/isn't installed/i);
  });

  it('throws the anti-cheat message before launching CE', async () => {
    const ensureRuntime = vi.fn();
    const startCeServerFn = vi.fn();
    const findWineRunnerFn = vi.fn();
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'k-ac', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      startCeServerFn, findWineRunnerFn, ensureRuntime,
      detectAntiCheatFn: async () => ({ name: 'Easy Anti-Cheat', module: 'EasyAntiCheat_EOS_x64.dll' }),
    })).rejects.toThrow(/won't attach/);
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(startCeServerFn).not.toHaveBeenCalled();
    expect(findWineRunnerFn).not.toHaveBeenCalled();
  });

  it('waits for the trainer engine download before attaching', async () => {
    await rm(join(winCeDir, 'cheatengine-x86_64.exe'), { force: true });
    const progress: string[] = [];
    const ensureRuntime = vi.fn(async () => {
      await writeFile(join(winCeDir, 'cheatengine-x86_64.exe'), 'MZ');
      return { ok: true as const, status: { status: 'ready' as const, winCeDir, winCeExe: join(winCeDir, 'cheatengine-x86_64.exe'), ceserver: join(dir, 'ceserver-7.5', 'ceserver') } };
    });
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'k1b', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      ensureRuntime, onProgress: (m) => progress.push(m),
    })).rejects.toThrow(/timed out|ping/i);   // got as far as launching CE
    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(progress).toContain('Downloading the trainer engine…');
  });

  it('reports a failed trainer engine download', async () => {
    await rm(join(winCeDir, 'cheatengine-x86_64.exe'), { force: true });
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'k1c', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      ensureRuntime: async () => ({ ok: false as const, error: 'offline' }),
    })).rejects.toThrow("Couldn't download the trainer engine: offline");
  });

  it('previews a table without the trainer engine installed', async () => {
    await rm(join(winCeDir, 'cheatengine-x86_64.exe'), { force: true });
    const ensureRuntime = vi.fn();
    const r = await startSession({ source: await startCtServer(), cacheKey: 'k1d', runtimeRoot: dir, ctCacheDir, ensureRuntime });
    expect(r.attached).toBe(false);
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it('times out cleanly when CE never responds to ping', async () => {
    const source = await startCtServer();
    // A pid forces an actual CE launch (the "stuck" binary) → ping timeout.
    ceServerStops.length = 0;
    await expect(startSession({
      source, cacheKey: 'k2', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
    })).rejects.toThrow(/timed out|ping/i);
    expect(getActiveSession()).toBeNull();
    expect(ceServerStops.length).toBeGreaterThan(0);   // ceserver isn't left running
  });

  it('runs Windows CE connected to ceserver for a native game, opening it by pid', async () => {
    const marker = join(dir, 'wine-invoked.txt');
    await writeFile(binary, `#!/bin/sh\necho "$@" > ${marker}\ncat autorun/zzz-starlight.lua >> ${marker}\nsleep 30\n`);
    await chmod(binary, 0o755);
    let serverBin = '';
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'native1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 600,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game',
      ...nativeLaunch,
      startCeServerFn: async ({ bin }) => { serverBin = bin; return { port: 40123, stop: async () => {} }; },
    })).rejects.toThrow(/timed out|ping/i);
    expect(serverBin).toBe(join(dir, 'ceserver-7.5', 'ceserver'));
    const out = await readFile(marker, 'utf8');
    expect(out.split('\n')[0]).toBe(join(winCeDir, 'cheatengine-x86_64.exe'));
    expect(out).toContain('local CESERVER = { host = "127.0.0.1", port = 40123 }');
    expect(out).toContain('local OPEN_PROCESS_PID = 4242');
    expect(out).toContain('local CT_PATH = "Z:\\\\');   // the table, as a Wine path
  });

  it('asks for permission when ptrace is restricted and ceserver lacks CAP_SYS_PTRACE', async () => {
    const stops: number[] = [];
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'pt1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      readPtraceScopeFn: async () => 1,
      startCeServerFn: async () => ({ port: 1, pid: 99, stop: async () => { stops.push(1); } }),
      hasPtraceCapFn: async () => false,
    })).rejects.toThrow(PTRACE_MESSAGE);
    expect(stops).toEqual([1]);   // ceserver isn't left running
  });

  it('attaches with ptrace restricted once ceserver has CAP_SYS_PTRACE', async () => {
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'pt2', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      readPtraceScopeFn: async () => 1,
      startCeServerFn: async () => ({ port: 1, pid: 99, stop: async () => {} }),
      hasPtraceCapFn: async (pid) => pid === 99,
    })).rejects.toThrow(/timed out|ping/i);   // past the permission check, into launching CE
  });

  it('asks for permission when ceserver has it but starlightd lost it', async () => {
    const stops: number[] = [];
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'pt4', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      readPtraceScopeFn: async () => 1,
      startCeServerFn: async () => ({ port: 1, pid: 99, stop: async () => { stops.push(1); } }),
      hasPtraceCapFn: async () => true,
      engineNeedsPtraceGrantFn: async () => true,
    })).rejects.toThrow(PTRACE_MESSAGE);
    expect(stops).toEqual([1]);
  });

  it('does not ask about starlightd when ptrace is unrestricted', async () => {
    const engineNeedsPtraceGrantFn = vi.fn(async () => true);
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'pt5', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      engineNeedsPtraceGrantFn,
    })).rejects.toThrow(/timed out|ping/i);
    expect(engineNeedsPtraceGrantFn).not.toHaveBeenCalled();
  });

  it('explains ptrace_scope 3, which no permission can get past', async () => {
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'pt3', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
      readPtraceScopeFn: async () => 3,
    })).rejects.toThrow(/ptrace_scope 3/);
  });

  it('stops waiting at once when Wine exits without starting Cheat Engine', async () => {
    await writeFile(binary, '#!/bin/sh\nexit 1\n');
    const t0 = Date.now();
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'native4', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 20_000,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', ...nativeLaunch,
    })).rejects.toThrow(/closed while starting \(Wine/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('asks for Proton or Wine when a native game has nothing to run Cheat Engine with', async () => {
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'native3', runtimeRoot: dir, ctCacheDir,
      pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game',
      ...nativeLaunch, findWineRunnerFn: async () => null,
    })).rejects.toThrow(/Proton or Wine/);
  });

  it('endSession is idempotent and tolerates missing session', async () => {
    const r = await endSession({ sessionId: 'nonexistent' });
    expect(r.ok).toBe(true);
  });

  it('previews records from the .CT without launching CE when there is no attach target', async () => {
    // A CT the fake server returns, with a group header + two cheats.
    const ct = '<CheatTable><CheatEntries>'
      + '<CheatEntry><ID>1</ID><Description>"== Player =="</Description><GroupHeader>1</GroupHeader>'
      + '<CheatEntries><CheatEntry><ID>2</ID><Description>"Infinite HP"</Description></CheatEntry></CheatEntries></CheatEntry>'
      + '</CheatEntries></CheatTable>';
    const ctSrv = createServer((_req, res) => { res.writeHead(200); res.end(ct); });
    const url = await new Promise<string>((resolve) => {
      ctSrv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(ctSrv.address() as { port: number }).port}/x.CT`));
    });
    try {
      // No pid and no game → preview mode. The binary is the "stuck" sleeper;
      // if CE were launched this would hang, so a fast return proves it wasn't.
      const r = await startSession({
        source: url, cacheKey: 'preview1', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
      });
      expect(r.needsPicker).toBe(true);
      expect(r.proton).toBe(false);
      expect(r.records.map((x) => x.name)).toEqual(['== Player ==', 'Infinite HP']);
      expect(r.records[0]).toMatchObject({ id: 1, isGroupHeader: true });
      // No CE was launched → toggling reports "not attached".
      const t = await setActive({ sessionId: r.sessionId, recordId: 2, active: true });
      expect(t.ok).toBe(false);
      expect(t.error).toMatch(/not attached/i);
    } finally {
      await new Promise<void>((res) => ctSrv.close(() => res()));
    }
  });

  it('toWinePath maps a Linux path to the Wine Z: drive', () => {
    expect(toWinePath('/home/user/x.ct')).toBe('Z:\\home\\user\\x.ct');
  });

  it('launches Windows CE via proton run when the target is a Proton game', async () => {
    // A fake `proton` launcher that records how it was invoked, then hangs so
    // the ping loop times out (we assert on the invocation, not a live bridge).
    const marker = join(dir, 'proton-invoked.txt');
    const fakeProton = join(dir, 'proton');
    // cwd is Windows CE's dir, so the control script is at ./autorun/…
    await writeFile(fakeProton, `#!/bin/sh\necho "$@" > ${marker}\nenv | grep STEAM_COMPAT >> ${marker}\ncat autorun/zzz-starlight.lua >> ${marker} 2>/dev/null\nsleep 30\n`);
    await chmod(fakeProton, 0o755);
    // An install from before 0.3: Windows CE inside the Linux CE, without its
    // own json module.
    await rm(winCeDir, { recursive: true });
    const legacy = join(dir, 'CheatEngineLinux766-4');
    await mkdir(join(legacy, 'windowsbin', 'autorun'), { recursive: true });
    await writeFile(join(legacy, 'windowsbin', 'cheatengine-x86_64.exe'), 'stub');
    await mkdir(join(legacy, 'lua'), { recursive: true });
    await writeFile(join(legacy, 'lua', 'json.lua'), '-- stub json module');

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
    const staged = await readFile(join(legacy, 'windowsbin', 'lua', 'json.lua'), 'utf8');
    expect(staged).toContain('stub json module');
  });

  it('auto-resolves the pid from game identity via the matcher', async () => {
    await writeFile(binary, '#!/bin/sh\nsleep 30\n'); await chmod(binary, 0o755);
    const source = await startCtServer();
    // matcher returns a pid → session proceeds to the (stub) proton launch and times out
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

  it('previews the table instead of failing when the game is not running', async () => {
    await writeFile(binary, '#!/bin/sh\nsleep 30\n'); await chmod(binary, 0o755);
    const ct = '<CheatTable><CheatEntries>'
      + '<CheatEntry><ID>1</ID><Description>"Enable"</Description><Options moHideChildren="1"/><VariableType>Auto Assembler Script</VariableType>'
      + '<CheatEntries><CheatEntry><ID>2</ID><Description>"God Mode"</Description><VariableType>Auto Assembler Script</VariableType></CheatEntry></CheatEntries></CheatEntry>'
      + '</CheatEntries></CheatTable>';
    const srv = createServer((_req, res) => { res.writeHead(200); res.end(ct); });
    const source = await new Promise<string>((resolve) => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}/x.CT`)));
    try {
      const r = await startSession({
        source, cacheKey: 'auto2', runtimeRoot: dir, ctCacheDir, pingTimeoutMs: 500,
        game: { id: '9-kings', name: '9 Kings', steamAppId: null },
        resolveMatch: async () => null,
      });
      expect(r).toMatchObject({ attached: false, running: false, verdict: 'unknown' });
      expect(r.records.map((x) => x.name)).toEqual(['Enable', 'God Mode']);
      // The list is shown as it will look once the prerequisite is on.
      expect(r.hiddenIds).toEqual([1]);
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });

  // ── a scripted stand-in for Cheat Engine that speaks the real bridge protocol ──
  // A table may carry its own behaviour in a `<!--FAKE {...}-->` comment:
  //   records: what list_records returns;  enable: { "<id>": true | "error text" };
  //   check: { "<id>": true | false | "unknown" }.
  // An `enable` value of "flag" succeeds only once the file `<dir>/flag` exists.
  async function installFakeCe(log: string, opts: { readyAfterMs?: number; rawPaths?: boolean } = {}): Promise<void> {
    const src = `#!/usr/bin/env node
const fs = require('fs');
const lua = fs.readFileSync('autorun/zzz-starlight.lua', 'utf8');
const url = /local BRIDGE_URL = "([^"]+)"/.exec(lua)[1];
const first = /local CT_PATH = (.*)/.exec(lua)[1];
fs.appendFileSync(${JSON.stringify(log)}, 'ct=' + first + '\\n');
let ready = false; setTimeout(() => { ready = true; }, ${opts.readyAfterMs ?? 0});
// Windows CE gets Wine paths (Z:\\home\\…); read the files from Linux.
const fromWine = (p) => p.replace(/^Z:/, '').replace(/\\\\/g, '/');
let path = first === 'nil' ? null : fromWine(JSON.parse(first));
let on = new Set();
const spec = () => {
  if (!path) return null;
  const m = /<!--FAKE (.*?)-->/s.exec(fs.readFileSync(path, 'utf8'));
  return m ? JSON.parse(m[1]) : null;
};
const STALE = 'Lua error in the script at line 25:[string "local syntaxcheck,memrec=..."]:146: No hook installed.\\r\\n\\r\\naddrA: 0 matches';
const reply = (cmd) => {
  const sp = spec();
  switch (cmd.method) {
    case 'ping': return { ok: true, ready, attached: true };
    case 'status': return { attached: true, pid: 460, ready };
    // Like the real thing, an empty list comes back as {} (an empty Lua table).
    case 'list_records':
      if (!ready || !path) return { records: {} };
      if (sp) return { records: sp.records.map((r) => ({ isGroupHeader: false, kind: 'script', depth: 0, ...r, isActive: on.has(r.id) })) };
      return { records: [{ id: 7, name: 'God Mode', isActive: false, isGroupHeader: false, kind: 'script', depth: 0 }] };
    case 'refresh': return { states: (sp ? sp.records : []).map((r) => ({ id: r.id, a: on.has(r.id) })) };
    case 'set_active': {
      let how = sp && sp.enable ? sp.enable[String(cmd.params.id)] : undefined;
      if (how === 'flag') how = fs.existsSync(${JSON.stringify(join(dir, 'flag'))}) ? true : undefined;
      if (how === true) { if (cmd.params.active) on.add(cmd.params.id); else on.delete(cmd.params.id); return { ok: true, active: cmd.params.active }; }
      return { ok: false, active: false, error: typeof how === 'string' ? how : STALE };
    }
    case 'check_script': {
      const how = sp && sp.check ? sp.check[String(cmd.params.id)] : 'unknown';
      if (how === 'unknown' || how === undefined) return { unknown: true };
      return how ? { ok: true, found: 1 } : { ok: false, found: 0, missing: 1, error: "signature 'x' is not in the game" };
    }
    case 'load_table':
      if (${opts.rawPaths ? 'true' : 'false'}) fs.appendFileSync(${JSON.stringify(log)}, 'raw ' + cmd.params.path + '\\n');
      path = fromWine(cmd.params.path); on = new Set(); return { ok: true };
    case 'set_hotkeys': return { ok: true, count: cmd.params.bindings.length };
    case 'set_speed': return { ok: true, speed: cmd.params.speed };
    case 'shutdown': return { ok: true };
    default: return { ok: false, error: 'unknown method' };
  }
};
(async () => {
  for (;;) {
    try {
      const r = await fetch(url + '/poll');
      if (r.status === 200) {
        const cmd = await r.json();
        if (cmd.method !== 'ping') fs.appendFileSync(${JSON.stringify(log)}, cmd.method + (cmd.method === 'load_table' ? ' ' + cmd.params.path.split('\\\\').pop() : '') + '\\n');
        await fetch(url + '/result', { method: 'POST', body: JSON.stringify({ id: cmd.id, result: reply(cmd) }) });
        if (cmd.method === 'set_hotkeys' && cmd.params.bindings.length > 0) {
          // "press" the first hotkey
          await fetch(url + '/event', { method: 'POST', body: JSON.stringify({ type: 'hotkey', id: cmd.params.bindings[0].id, ok: true, active: true }) });
        }
      }
    } catch { /* bridge not up yet / closing */ }
    await new Promise((r) => setTimeout(r, 15));
  }
})();
`;
    await writeFile(binary, src);
    await chmod(binary, 0o755);
  }

  /** Serves fake tables (filename → behaviour) and returns a table list for them, newest first. */
  async function serveTables(specs: Record<string, unknown>): Promise<{ tables: { id: number; filename: string; url: string; topicUrl: string }[]; close: () => Promise<void> }> {
    const srv = createServer((req, res) => {
      const spec = specs[(req.url ?? '').slice(1)];
      res.writeHead(spec ? 200 : 404);
      res.end(`<CheatTable><!--FAKE ${JSON.stringify(spec)}--></CheatTable>`);
    });
    const base = await new Promise<string>((resolve) => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));
    const names = Object.keys(specs);
    return {
      tables: names.map((f, i) => ({ id: (names.length - i) * 10, filename: f, url: `${base}/${f}`, topicUrl: 't' })),
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };
  }
  const MASTER = [
    { id: 1, name: 'Enable', opts: '[moHideChildren]' },
    { id: 2, name: 'God Mode', depth: 1 },
    { id: 3, name: 'Infinite Ammo', depth: 1 },
  ];

  const native = { pid: 4242, detectProtonFn: async () => null, readComm: async () => 'game', isGameAlive: () => true, ...nativeLaunch };

  it('attaches, waits for the table to finish loading, and lists records', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log, { readyAfterMs: 400 });
    const source = await startCtServer();
    const r = await startSession({ source, cacheKey: 'live1', runtimeRoot: dir, ctCacheDir, ...native });
    // list_records before "ready" would have returned [] — we must have waited.
    expect(r.records.map((x) => x.name)).toEqual(['God Mode']);
    expect(r).toMatchObject({ attached: true, proton: false, tableId: 0, process: { pid: 4242, name: 'game' } });
    expect(r.tables).toHaveLength(1);
  });

  it('returns the table\'s own error text, cleaned up, when a cheat fails to enable', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const r = await startSession({ source: await startCtServer(), cacheKey: 'live2', runtimeRoot: dir, ctCacheDir, ...native });
    const out = await setActive({ sessionId: r.sessionId, recordId: 7, active: true });
    expect(out).toEqual({ ok: false, error: 'No hook installed.\naddrA: 0 matches' });
  });

  it('runs allow-listed tool commands and rejects everything else', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const r = await startSession({ source: await startCtServer(), cacheKey: 'live3', runtimeRoot: dir, ctCacheDir, ...native });
    expect(await callSession({ sessionId: r.sessionId, method: 'set_speed', params: { speed: 2 } })).toEqual({ ok: true, speed: 2 });
    expect(await callSession({ sessionId: r.sessionId, method: 'shutdown' })).toMatchObject({ ok: false, error: expect.stringMatching(/unsupported/) });
    expect(await callSession({ sessionId: 'nope', method: 'set_speed' })).toMatchObject({ ok: false, error: 'session not active' });
  });

  it('routes scanner commands to the scanner host, not the CE bridge', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log);
    const r = await startSession({ source: await startCtServer(), cacheKey: 'live-scan', runtimeRoot: dir, ctCacheDir, ...native });
    scannerHost.call.mockClear();
    const out = await callSession({ sessionId: r.sessionId, method: 'scan_status', params: { a: 1 } });
    expect(out).toEqual({ ok: true, from: 'scanner' });
    expect(scannerHost.call).toHaveBeenCalledWith(4242, 'scan_status', { a: 1 });
    expect(await readFile(log, 'utf8')).not.toMatch(/scan_status/);
  });

  it('refuses scanner commands when no game is attached', async () => {
    const r = await startSession({ sources: [], cacheKey: 'tools-n', runtimeRoot: dir, ctCacheDir });
    scannerHost.call.mockClear();
    expect(await callSession({ sessionId: r.sessionId, method: 'mem_read', params: {} }))
      .toEqual({ ok: false, error: 'not attached to a game process' });
    expect(scannerHost.call).not.toHaveBeenCalled();
  });

  it('endSession ends the scanner before shutting CE down', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log);
    const r = await startSession({ source: await startCtServer(), cacheKey: 'live-end', runtimeRoot: dir, ctCacheDir, ...native });
    const order: string[] = [];
    scannerHost.end.mockImplementationOnce(async () => { order.push(`scanner-end:${(await readFile(log, 'utf8')).includes('shutdown')}`); });
    await endSession({ sessionId: r.sessionId });
    expect(order).toEqual(['scanner-end:false']);
    expect((await readFile(log, 'utf8')).trim().split('\n').pop()).toBe('shutdown');
  });

  it('asks Cheat Engine to undo its cheats before the session ends', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log);
    const r = await startSession({ source: await startCtServer(), cacheKey: 'live4', runtimeRoot: dir, ctCacheDir, ...native });
    await endSession({ sessionId: r.sessionId });
    expect((await readFile(log, 'utf8')).trim().split('\n').pop()).toBe('shutdown');
    expect(getActiveSession()).toBeNull();
  });

  it('starts a tools-only session (no table) for a running game', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log);
    const r = await startSession({ sources: [], cacheKey: 'tools-x', runtimeRoot: dir, ctCacheDir, ...native });
    expect(r).toMatchObject({ attached: true, tableId: null, tables: [] });
    expect(r.records).toEqual([]);   // not the `{}` Cheat Engine actually sent
    expect(await readFile(log, 'utf8')).toContain('ct=nil');
  });

  it('a tools-only session with no process yet asks for one instead of failing', async () => {
    const r = await startSession({ sources: [], cacheKey: 'tools-y', runtimeRoot: dir, ctCacheDir });
    expect(r).toMatchObject({ attached: false, needsPicker: true, records: [], tableId: null });
  });

  it('loads the requested table and caches each attachment separately', async () => {
    const served: string[] = [];
    const srv = createServer((req, res) => { served.push(req.url ?? ''); res.writeHead(200); res.end(`<CheatTable><CheatEntries><CheatEntry><ID>1</ID><Description>"from ${req.url}"</Description></CheatEntry></CheatEntries></CheatTable>`); });
    const base = await new Promise<string>((resolve) => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));
    const tables = [
      { id: 30, filename: 'new.CT', url: `${base}/new.CT`, topicUrl: 't' },
      { id: 10, filename: 'old.CT', url: `${base}/old.CT`, topicUrl: 't' },
    ];
    try {
      const common = { sources: ['https://forum.example/viewtopic.php?t=1'], cacheKey: 'game', runtimeRoot: dir, ctCacheDir, listTablesFn: async () => tables };
      const newest = await startSession(common);
      expect(newest.tableId).toBe(30);
      expect(newest.records[0]!.name).toBe('from /new.CT');
      const picked = await startSession({ ...common, tableId: 10 });
      expect(picked.tableId).toBe(10);
      expect(picked.records[0]!.name).toBe('from /old.CT');
      expect(picked.tables).toEqual(tables);
      // Re-opening a table already fetched doesn't download it again.
      await startSession(common);
      expect(served).toEqual(['/new.CT', '/old.CT']);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('switches the table\'s prerequisite on by itself and reports it as hidden', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log);
    const t = await serveTables({ 'game.CT': { records: MASTER, enable: { 1: true } } });
    try {
      const r = await startSession({ sources: ['https://f.example/viewtopic.php?t=1'], cacheKey: 'pre1', runtimeRoot: dir, ctCacheDir, listTablesFn: async () => t.tables, ...native });
      expect(r).toMatchObject({ verdict: 'works', hiddenIds: [1], prereqErrors: {}, tableId: 10 });
      expect(r.records.find((x) => x.id === 1)!.isActive).toBe(true);
      expect(r.records.find((x) => x.id === 2)!.isActive).toBe(false);   // real cheats are left to the user
      expect((await readFile(log, 'utf8')).split('\n').filter((l) => l === 'set_active')).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('moves on to an older table when the newest no longer matches the game', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log);
    const t = await serveTables({
      'new.CT': { records: MASTER, enable: {} },
      'old.CT': { records: MASTER, enable: { 1: true } },
    });
    const progress: string[] = [];
    const steps: string[] = [];
    try {
      const r = await startSession({
        sources: ['https://f.example/viewtopic.php?t=1'], cacheKey: 'pick1', runtimeRoot: dir, ctCacheDir,
        listTablesFn: async () => t.tables, onProgress: (m) => progress.push(m),
        onSteps: (list) => steps.push(list.map((x) => `${x.filename}:${x.state}`).join(' ')), ...native,
      });
      expect(r.tableId).toBe(10);
      expect(r.verdict).toBe('works');
      expect(r.attempts).toEqual([
        { id: 20, filename: 'new.CT', verdict: 'broken' },
        { id: 10, filename: 'old.CT', verdict: 'works' },
      ]);
      expect(progress).toHaveLength(1);
      // The connecting screen is told about every table as its turn comes and goes.
      expect(steps).toEqual([
        'new.CT:checking old.CT:waiting',
        'new.CT:broken old.CT:waiting',
        'new.CT:broken old.CT:checking',
        'new.CT:broken old.CT:works',
      ]);
      // Swapped inside the running Cheat Engine — it was launched once.
      const lines = (await readFile(log, 'utf8')).split('\n');
      expect(lines.filter((l) => l.startsWith('ct=')).length).toBe(1);
      expect(lines.filter((l) => l.startsWith('load_table'))).toEqual(['load_table pick1-a10.ct']);
    } finally { await t.close(); }
  });

  it('prefers a table it could not judge over one known not to match', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const FLAT = [{ id: 5, name: 'God Mode' }];
    const t = await serveTables({
      'newest.CT': { records: FLAT, check: { 5: false } },      // its signature is gone
      'lua.CT': { records: FLAT, check: { 5: 'unknown' } },      // Lua-driven: can't tell
    });
    try {
      const r = await startSession({ sources: ['https://f.example/viewtopic.php?t=1'], cacheKey: 'pick2', runtimeRoot: dir, ctCacheDir, listTablesFn: async () => t.tables, ...native });
      expect(r.attempts.map((a) => a.verdict)).toEqual(['broken', 'unknown']);
      expect(r.tableId).toBe(10);
      expect(r.verdict).toBe('unknown');
    } finally { await t.close(); }
  });

  it('judges a table with no prerequisite by its cheats\' signatures, without switching any on', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log);
    const t = await serveTables({ 'flat.CT': { records: [{ id: 5, name: 'God Mode' }, { id: 6, name: 'Add 1000 Gold' }], check: { 5: true, 6: true } } });
    try {
      const r = await startSession({ sources: ['https://f.example/viewtopic.php?t=1'], cacheKey: 'flat1', runtimeRoot: dir, ctCacheDir, listTablesFn: async () => t.tables, ...native });
      expect(r).toMatchObject({ verdict: 'works', hiddenIds: [] });
      const lines = (await readFile(log, 'utf8')).split('\n');
      expect(lines.filter((l) => l === 'check_script')).toHaveLength(2);
      expect(lines).not.toContain('set_active');
    } finally { await t.close(); }
  });

  it('loads an explicitly chosen table as is, with the reason its prerequisite failed', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const t = await serveTables({
      'new.CT': { records: MASTER, enable: {} },
      'old.CT': { records: MASTER, enable: { 1: true } },
    });
    try {
      const r = await startSession({
        sources: ['https://f.example/viewtopic.php?t=1'], cacheKey: 'pick3', runtimeRoot: dir, ctCacheDir,
        listTablesFn: async () => t.tables, tableId: 20, autoPick: false, ...native,
      });
      expect(r).toMatchObject({ tableId: 20, verdict: 'broken', hiddenIds: [] });
      expect(r.prereqErrors[1]).toBe('No hook installed.\naddrA: 0 matches');
      expect(r.attempts).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('retryTables finds the table once the game has finished loading', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const t = await serveTables({ 'game.CT': { records: MASTER, enable: { 1: 'flag' } } });
    try {
      const r = await startSession({ sources: ['https://f.example/viewtopic.php?t=1'], cacheKey: 'retry1', runtimeRoot: dir, ctCacheDir, listTablesFn: async () => t.tables, ...native });
      expect(r.verdict).toBe('broken');
      await writeFile(join(dir, 'flag'), '');      // "the game finished loading"
      const again = await retryTables({ sessionId: r.sessionId });
      expect(again).toMatchObject({ ok: true, verdict: 'works', hiddenIds: [1], tableId: 10 });
      expect(await retryTables({ sessionId: 'nope' })).toEqual({ ok: false, error: 'session not active' });
    } finally { await t.close(); }
  });

  it('retryTables hands the backend the Linux path, and Cheat Engine gets the Wine path once', async () => {
    const log = join(dir, 'fake-ce.log');
    await installFakeCe(log, { rawPaths: true });
    const t = await serveTables({ 'game.CT': { records: MASTER, enable: { 1: true } } });
    try {
      const r = await startSession({ sources: ['https://f.example/viewtopic.php?t=1'], cacheKey: 'retry2', runtimeRoot: dir, ctCacheDir, listTablesFn: async () => t.tables, ...native });
      const s = getActiveSession()!;
      const send = vi.spyOn(s.backend!, 'send');
      expect(await retryTables({ sessionId: r.sessionId })).toMatchObject({ ok: true, verdict: 'works' });
      const loads = send.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd.method === 'load_table');
      expect(s.ctPath!.startsWith('/')).toBe(true);
      expect(loads).toEqual([{ method: 'load_table', params: { path: s.ctPath } }]);
      const raw = (await readFile(log, 'utf8')).split('\n').filter((l) => l.startsWith('raw '));
      expect(raw).toEqual([`raw ${toWinePath(s.ctPath!)}`]);
    } finally { await t.close(); }
  });

  it('lets a game that just started finish loading before matching its table', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const calls: [number, string[]][] = [];
    const progress: string[] = [];
    const r = await startSession({
      source: await startCtServer(), cacheKey: 'load1', runtimeRoot: dir, ctCacheDir, ...native,
      onProgress: (m) => progress.push(m),
      waitForGameFn: async (pid, modules) => { calls.push([pid, modules]); await new Promise((res) => setTimeout(res, 900)); },
    });
    expect(r.attached).toBe(true);
    expect(calls).toEqual([[4242, []]]);
    expect(progress).toContain('Waiting for the game to finish loading…');
  });

  it('refuses once anti-cheat shows up while the game was loading', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    let calls = 0;
    const detectAntiCheatFn = vi.fn(async () => (++calls === 1 ? null : { name: 'Easy Anti-Cheat', module: 'easyanticheat_x64.dll' }));
    await expect(startSession({
      source: await startCtServer(), cacheKey: 'ac-late', runtimeRoot: dir, ctCacheDir, ...native,
      detectAntiCheatFn, waitForGameFn: async () => {},
    })).rejects.toThrow(/Easy Anti-Cheat is running in this game/);
    expect(detectAntiCheatFn).toHaveBeenCalledTimes(2);
    expect(getActiveSession()).toBeNull();
  });

  it('ends the session by itself when the game exits', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    let alive = true;
    let exited = 0;
    const r = await startSession({
      source: await startCtServer(), cacheKey: 'gone1', runtimeRoot: dir, ctCacheDir, ...native,
      isGameAlive: () => alive, gameWatchMs: 20, onGameExit: () => { exited++; },
    });
    await new Promise((res) => setTimeout(res, 80));
    expect(getActiveSession()?.sessionId).toBe(r.sessionId);
    scannerHost.end.mockClear();
    alive = false;
    await new Promise((res) => setTimeout(res, 150));
    expect(exited).toBe(1);
    expect(scannerHost.end).toHaveBeenCalledTimes(1);
    expect(getActiveSession()).toBeNull();
  });

  it('notices a real game process exiting', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const game = spawn('sleep', ['30']);
    let exited = 0;
    await startSession({
      source: await startCtServer(), cacheKey: 'gone3', runtimeRoot: dir, ctCacheDir, ...native,
      pid: game.pid!, isGameAlive: undefined, gameWatchMs: 20, onGameExit: () => { exited++; },
    });
    await new Promise((res) => setTimeout(res, 80));
    expect(exited).toBe(0);
    game.kill('SIGKILL');
    await new Promise((res) => game.once('exit', res));
    await new Promise((res) => setTimeout(res, 100));
    expect(exited).toBe(1);
  });

  it('stops watching the game once the session is ended', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    let alive = true;
    let exited = 0;
    const r = await startSession({
      source: await startCtServer(), cacheKey: 'gone2', runtimeRoot: dir, ctCacheDir, ...native,
      isGameAlive: () => alive, gameWatchMs: 20, onGameExit: () => { exited++; },
    });
    await endSession({ sessionId: r.sessionId });
    alive = false;
    await new Promise((res) => setTimeout(res, 100));
    expect(exited).toBe(0);
  });

  it('refuses to start another game while one is connected, and keeps it', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const r = await startSession({ source: await startCtServer(), cacheKey: 'one-a', runtimeRoot: dir, ctCacheDir, ...native });
    await expect(startSession({ source: 'http://127.0.0.1:1/x.CT', cacheKey: 'one-b', runtimeRoot: dir, ctCacheDir, ...native }))
      .rejects.toThrow(/still connected/);
    expect(getActiveSession()?.sessionId).toBe(r.sessionId);
  });

  describe('one engine per game', () => {
    const CT = '<CheatTable><CheatEntries><CheatEntry><ID>2</ID><Description>"Infinite HP"</Description></CheatEntry></CheatEntries></CheatTable>';
    async function serveCt(): Promise<{ url: string; close: () => Promise<void> }> {
      const srv = createServer((_req, res) => { res.writeHead(200); res.end(CT); });
      const url = await new Promise<string>((resolve) => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}/x.CT`)));
      return { url, close: () => new Promise<void>((r) => srv.close(() => r())) };
    }

    it('releaseToStarlightd shuts CE down and keeps the session in starlightd mode', async () => {
      const log = join(dir, 'fake-ce.log');
      await installFakeCe(log);
      const r = await startSession({ source: await startCtServer(), cacheKey: 'rel1', runtimeRoot: dir, ctCacheDir, ...native });
      expect(ceSessionFor(4242)).toEqual({ sessionId: r.sessionId });
      expect(ceSessionFor(1)).toBeNull();
      const backend = getActiveSession()!.backend!;
      const kill = vi.spyOn(backend, 'close');
      expect(await releaseToStarlightd(r.sessionId)).toBe(true);
      expect((await readFile(log, 'utf8')).trim().split('\n').pop()).toBe('shutdown');
      expect(kill).toHaveBeenCalled();
      const s = getActiveSession()!;
      expect(s).toMatchObject({ sessionId: r.sessionId, mode: 'paused', backend: null, pid: 4242 });
      expect(s.records).toEqual(r.records.map((x) => ({ ...x, isActive: false })));
      expect(ceSessionFor(4242)).toBeNull();
      expect(await releaseToStarlightd(r.sessionId)).toBe(false);
    });

    it('a hold that lands while CE is starting hands the game over instead of leaving two engines', async () => {
      const log = join(dir, 'fake-ce.log');
      await installFakeCe(log);
      let held = false;
      const r = await startSession({
        source: await startCtServer(), cacheKey: 'race1', runtimeRoot: dir, ctCacheDir, ...native,
        starlightdHolders: () => (held ? ['agent'] : []),
        waitForGameFn: async () => { held = true; },
      });
      expect(r).toMatchObject({ engine: 'starlightd', holders: ['agent'], attached: true });
      expect(await readFile(log, 'utf8')).toMatch(/shutdown/);
      expect(getActiveSession()).toMatchObject({ sessionId: r.sessionId, mode: 'paused', backend: null, pid: 4242 });
    });

    it('a release that lands mid-startup does not tear down the starlightd-owned session', async () => {
      await installFakeCe(join(dir, 'fake-ce.log'));
      let held = false;
      const r = await startSession({
        source: await startCtServer(), cacheKey: 'race2', runtimeRoot: dir, ctCacheDir, ...native,
        starlightdHolders: () => (held ? ['agent'] : []),
        waitForGameFn: async () => {
          held = true;
          expect(await releaseToStarlightd(getActiveSession()!.sessionId)).toBe(true);
        },
      });
      expect(r).toMatchObject({ engine: 'starlightd', holders: ['agent'] });
      expect(getActiveSession()).toMatchObject({ sessionId: r.sessionId, mode: 'paused' });
    });

    it('CE exiting after releaseToStarlightd keeps the session', async () => {
      await installFakeCe(join(dir, 'fake-ce.log'));
      let alive = true;
      const r = await startSession({ source: await startCtServer(), cacheKey: 'rel2', runtimeRoot: dir, ctCacheDir, ...native, isGameAlive: () => alive, gameWatchMs: 20 });
      const backend = getActiveSession()!.backend as CeBackend;
      const exited = vi.waitFor(() => { if (!backend.launcherExited()) throw new Error('CE still running'); }, { timeout: 5000, interval: 10 });
      await releaseToStarlightd(r.sessionId);
      await exited;                                       // CE's exit (and its onExit callback) has happened
      await new Promise((res) => setTimeout(res, 20));
      expect(getActiveSession()).toMatchObject({ sessionId: r.sessionId, mode: 'paused', pid: 4242 });
      // ...and the game-exit watch still runs.
      scannerHost.end.mockClear();
      alive = false;
      await new Promise((res) => setTimeout(res, 150));
      expect(getActiveSession()).toBeNull();
      expect(scannerHost.end).toHaveBeenCalled();
    });

    it('starting on a game starlightd owns does not launch Cheat Engine', async () => {
      const ct = await serveCt();
      const findWineRunnerFn = vi.fn();
      const startCeServerFn = vi.fn();
      const ensureRuntime = vi.fn();
      try {
        const r = await startSession({
          source: ct.url, cacheKey: 'sd1', runtimeRoot: dir, ctCacheDir, ...native,
          findWineRunnerFn, startCeServerFn, ensureRuntime, starlightdHolders: () => ['user-cheats'],
        });
        expect(findWineRunnerFn).not.toHaveBeenCalled();
        expect(startCeServerFn).not.toHaveBeenCalled();
        expect(ensureRuntime).not.toHaveBeenCalled();
        expect(r).toMatchObject({ engine: 'starlightd', holders: ['user-cheats'], attached: true, verdict: 'unknown', process: { pid: 4242 } });
        expect(r.records.map((x) => x.name)).toEqual(['Infinite HP']);
        expect(getActiveSession()).toMatchObject({ mode: 'paused', backend: null });
      } finally { await ct.close(); }
    });

    it('anti-cheat is still refused in starlightd mode', async () => {
      await expect(startSession({
        source: await startCtServer(), cacheKey: 'sd-ac', runtimeRoot: dir, ctCacheDir, ...native,
        starlightdHolders: () => ['agent'],
        detectAntiCheatFn: async () => ({ name: 'Easy Anti-Cheat', module: 'EasyAntiCheat_EOS_x64.dll' }),
      })).rejects.toThrow(/won't attach/);
    });

    it('set_speed in starlightd mode goes to the scanner host', async () => {
      const r = await startSession({ source: await startCtServer(), cacheKey: 'sd-sp', runtimeRoot: dir, ctCacheDir, ...native, starlightdHolders: () => ['agent'] });
      scannerHost.call.mockClear();
      expect(await callSession({ sessionId: r.sessionId, method: 'set_speed', params: { speed: 2 } })).toEqual({ ok: true, from: 'scanner' });
      expect(scannerHost.call).toHaveBeenCalledWith(4242, 'speed_set', { speed: 2 });
      scannerHost.call.mockClear();
      await callSession({ sessionId: r.sessionId, method: 'scan_status', params: {} });
      expect(scannerHost.call).toHaveBeenCalledWith(4242, 'scan_status', {});
    });

    it('CE-only commands in starlightd mode say the table is paused', async () => {
      const r = await startSession({ source: await startCtServer(), cacheKey: 'sd-pa', runtimeRoot: dir, ctCacheDir, ...native, starlightdHolders: () => ['agent'] });
      const paused = { ok: false, error: 'the Cheat Engine table is paused' };
      expect(await callSession({ sessionId: r.sessionId, method: 'set_value', params: {} })).toEqual(paused);
      expect(await callSession({ sessionId: r.sessionId, method: 'refresh' })).toEqual(paused);
      expect(await setActive({ sessionId: r.sessionId, recordId: 2, active: true })).toEqual(paused);
    });

    it('speed_set is refused while CE owns the game', async () => {
      await installFakeCe(join(dir, 'fake-ce.log'));
      const r = await startSession({ source: await startCtServer(), cacheKey: 'ce-sp', runtimeRoot: dir, ctCacheDir, ...native });
      scannerHost.call.mockClear();
      expect(await callSession({ sessionId: r.sessionId, method: 'speed_set', params: { speed: 2 } }))
        .toEqual({ ok: false, error: 'Game speed runs through Cheat Engine for this table.' });
      expect(scannerHost.call).not.toHaveBeenCalled();
    });
  });

  describe('native tables', () => {
    /** Routes by the table's FAKE spec: `route: 'native'` compiles, anything else needs CE (a Lua record). */
    function fakeRoute() {
      return vi.fn(async (ctPath: string, _label: string): Promise<RouteDecision> => {
        const m = /<!--FAKE (.*?)-->/s.exec(await readFile(ctPath, 'utf8'));
        const sp = m ? JSON.parse(m[1]!) : {};
        const native = sp.route === 'native';
        return {
          engine: native ? 'native' : 'ce',
          compiled: native ? ({ path: ctPath, spec: sp, records: [], native: true, reasons: [], registeredBy: {} } as unknown as CompiledTable) : null,
          codes: native ? {} : { 'lua:block': 1 },
          first: native ? null : { recordId: 3, name: 'Infinite Ammo', code: 'lua:block', detail: 'line 2: {$lua}' },
          records: 3, sha256: 'sha',
        };
      });
    }
    /** A native backend that plays the table's FAKE spec, like the fake CE does. */
    function fakeNative() {
      const sends: BackendCommand[] = [];
      const created: NativeBackendDeps[] = [];
      const close = vi.fn(async () => {});
      const fn = vi.fn((deps: NativeBackendDeps): TableBackend => {
        created.push(deps);
        let sp = (deps.compiled as unknown as { spec: { records?: { id: number }[]; enable?: Record<string, boolean>; check?: Record<string, boolean | string> } }).spec;
        let on = new Set<number>();
        return {
          kind: 'native',
          close,
          send: async (cmd) => {
            sends.push(cmd);
            const p = (cmd.params ?? {}) as Record<string, unknown>;
            switch (cmd.method) {
              case 'ping': return { ok: true, ready: true, attached: true };
              case 'status': return { attached: true, pid: 4242, ready: true };
              case 'list_records': return { records: (sp.records ?? []).map((r) => ({ isGroupHeader: false, kind: 'script', depth: 0, ...r, isActive: on.has(r.id) })) };
              case 'refresh': return { states: (sp.records ?? []).map((r) => ({ id: r.id, a: on.has(r.id) })) };
              case 'set_active': {
                if (sp.enable?.[String(p['id'])] !== true) return { ok: false, active: false, error: 'aob not found' };
                if (p['active']) on.add(p['id'] as number); else on.delete(p['id'] as number);
                return { ok: true, active: p['active'] };
              }
              case 'check_script': {
                const how = sp.check?.[String(p['id'])];
                return how === undefined || how === 'unknown' ? { unknown: true } : how ? { ok: true, found: 1 } : { ok: false, missing: 1 };
              }
              case 'load_table': {
                const c = await deps.loadCompiled!(p['path'] as string);
                sp = (c as unknown as { spec: typeof sp }).spec; on = new Set();
                return { ok: true };
              }
              case 'set_value': return { ok: true, value: String(p['value']) };
              case 'shutdown': on = new Set(); return { ok: true };
              default: return { ok: false, error: `unknown method: ${cmd.method}` };
            }
          },
        };
      });
      return { fn, sends, created, close };
    }
    /** Like the engine's Session: detach (or a dropped connection) tells every listener, once. */
    function fakeEngineSession() {
      let attached = true;
      const cbs: ((reason: string) => void)[] = [];
      const mark = (reason: string): void => {
        if (!attached) return;
        attached = false;
        for (const cb of [...cbs]) cb(reason);
      };
      const detach = vi.fn(async () => { mark('manual'); });
      const session = {
        pid: 4242, handle: 1, client: {}, detach,
        get attached() { return attached; },
        onDetached: (cb: (reason: string) => void) => { cbs.push(cb); return () => { const i = cbs.indexOf(cb); if (i !== -1) cbs.splice(i, 1); }; },
      } as unknown as Session;
      /** starlightd died or the socket dropped. */
      const drop = (): void => mark('process-exit');
      return { detach, session, drop };
    }
    function nativeOpts(t: { tables: { id: number; filename: string; url: string; topicUrl: string }[] }, cacheKey: string) {
      const route = fakeRoute();
      const backend = fakeNative();
      const engine = fakeEngineSession();
      const release = vi.fn();
      const holdTable = vi.fn((_pid: number) => release);
      const attachEngineFn = vi.fn(async (_pid: number) => engine.session);
      return {
        route, backend, engine, release, holdTable, attachEngineFn,
        opts: {
          sources: ['https://f.example/viewtopic.php?t=1'], cacheKey, runtimeRoot: dir, ctCacheDir,
          listTablesFn: async () => t.tables, ...native,
          routeTableFn: route, createNativeBackendFn: backend.fn as never, attachEngineFn, holdTable,
        },
      };
    }

    it('a native-routed table attaches starlightd, holds the game and never launches Cheat Engine', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: [{ id: 5, name: 'God Mode' }] } });
      const findWineRunnerFn = vi.fn();
      const startCeServerFn = vi.fn();
      try {
        spawnSpy.mockClear();
        const n = nativeOpts(t, 'nat1');
        const r = await startSession({ ...n.opts, findWineRunnerFn, startCeServerFn });
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(findWineRunnerFn).not.toHaveBeenCalled();
        expect(startCeServerFn).not.toHaveBeenCalled();
        expect(n.attachEngineFn).toHaveBeenCalledWith(4242);
        expect(n.holdTable).toHaveBeenCalledTimes(1);
        expect(n.holdTable).toHaveBeenCalledWith(4242);
        expect(n.route).toHaveBeenCalledWith(expect.stringMatching(/nat1-a10\.ct$/), 'nat1#10');
        expect(n.backend.created[0]).toMatchObject({ session: n.engine.session, mainModule: 'game' });
        expect(r).toMatchObject({ mode: 'native', engine: 'starlightd', attached: true, tableId: 10, route: { engine: 'native', codes: {}, first: null } });
        expect(r.records.map((x) => x.name)).toEqual(['God Mode']);
        expect(getActiveSession()).toMatchObject({ mode: 'native', pid: 4242 });
        expect(ceSessionFor(4242)).toBeNull();     // claims on a native game release nothing
      } finally { await t.close(); }
    });

    it('native sessions run prerequisites and the verdict through the native backend', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: MASTER, enable: { 1: true } } });
      try {
        const n = nativeOpts(t, 'nat2');
        const r = await startSession(n.opts);
        expect(r).toMatchObject({ mode: 'native', verdict: 'works', hiddenIds: [1], prereqErrors: {} });
        expect(n.backend.sends.filter((c) => c.method === 'set_active')).toEqual([{ method: 'set_active', params: { id: 1, active: true } }]);
        // Toggles and retries go to the same backend.
        expect(await setActive({ sessionId: r.sessionId, recordId: 1, active: false })).toEqual({ ok: true });
        expect(await retryTables({ sessionId: r.sessionId })).toMatchObject({ ok: true, verdict: 'works', tableId: 10 });
        const loads = n.backend.sends.filter((c) => c.method === 'load_table');
        expect(loads).toEqual([{ method: 'load_table', params: { path: getActiveSession()!.ctPath } }]);
      } finally { await t.close(); }
    });

    it('preview sessions report the route without launching anything', async () => {
      const t = await serveTables({ 'game.CT': { route: 'ce' } });
      try {
        spawnSpy.mockClear();
        const n = nativeOpts(t, 'nat3');
        const { pid: _pid, ...noPid } = n.opts;
        const r = await startSession(noPid);
        expect(r).toMatchObject({
          attached: false, needsPicker: true,
          route: { engine: 'ce', codes: { 'lua:block': 1 }, first: { recordId: 3, name: 'Infinite Ammo', code: 'lua:block', copy: 'A script in this table runs Lua code.' } },
        });
        expect(n.route).toHaveBeenCalledTimes(1);
        expect(n.attachEngineFn).not.toHaveBeenCalled();
        expect(n.backend.fn).not.toHaveBeenCalled();
        expect(n.holdTable).not.toHaveBeenCalled();
        expect(spawnSpy).not.toHaveBeenCalled();
      } finally { await t.close(); }
    });

    it('game exit ends a native session and releases the table hold', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: [{ id: 5, name: 'God Mode' }] } });
      try {
        let alive = true;
        const exited: string[] = [];
        const n = nativeOpts(t, 'nat4');
        const r = await startSession({ ...n.opts, isGameAlive: () => alive, gameWatchMs: 20, onGameExit: (id) => { exited.push(id); } });
        hotkeyHost.clearSessionHotkeys.mockClear();
        scannerHost.end.mockClear();
        alive = false;
        await vi.waitFor(() => { if (exited.length === 0) throw new Error('not yet'); }, { timeout: 2000, interval: 10 });
        expect(exited).toEqual([r.sessionId]);
        expect(getActiveSession()).toBeNull();
        await vi.waitFor(() => { if (hotkeyHost.clearSessionHotkeys.mock.calls.length === 0) throw new Error('not yet'); }, { timeout: 2000, interval: 10 });
        expect(n.release).toHaveBeenCalledTimes(1);
        expect(n.backend.close).toHaveBeenCalledTimes(1);
        expect(n.engine.detach).toHaveBeenCalledTimes(1);
        expect(scannerHost.end).toHaveBeenCalledTimes(1);
      } finally { await t.close(); }
    });

    it('ending a native session shuts the table down and releases the hold once', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: [{ id: 5, name: 'God Mode' }] } });
      try {
        const n = nativeOpts(t, 'nat4b');
        const r = await startSession(n.opts);
        hotkeyHost.clearSessionHotkeys.mockClear();
        await endSession({ sessionId: r.sessionId });
        await endSession({ sessionId: r.sessionId });
        expect(n.backend.sends.at(-1)).toEqual({ method: 'shutdown' });
        expect(n.backend.close).toHaveBeenCalledTimes(1);
        expect(n.engine.detach).toHaveBeenCalledTimes(1);
        expect(n.release).toHaveBeenCalledTimes(1);
        expect(hotkeyHost.clearSessionHotkeys).toHaveBeenCalled();
      } finally { await t.close(); }
    });

    it('game speed in a native session goes to the scanner host', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: [{ id: 5, name: 'God Mode' }] } });
      try {
        const n = nativeOpts(t, 'nat5');
        const r = await startSession(n.opts);
        scannerHost.call.mockClear();
        expect(await callSession({ sessionId: r.sessionId, method: 'set_speed', params: { speed: 2 } })).toEqual({ ok: true, from: 'scanner' });
        expect(scannerHost.call).toHaveBeenCalledWith(4242, 'speed_set', { speed: 2 });
        expect(await callSession({ sessionId: r.sessionId, method: 'speed_set', params: { speed: 1 } })).toEqual({ ok: true, from: 'scanner' });
        // The rest goes to the table, through the same allow-list as Cheat Engine (R9).
        expect(await callSession({ sessionId: r.sessionId, method: 'set_value', params: { id: 5, value: '9' } })).toEqual({ ok: true, value: '9' });
        expect(await callSession({ sessionId: r.sessionId, method: 'shutdown' })).toMatchObject({ ok: false, error: expect.stringMatching(/unsupported/) });
        expect(n.backend.sends.some((c) => c.method === 'set_speed')).toBe(false);
      } finally { await t.close(); }
    });

    it('a CE candidate later in the pick switches to Cheat Engine once and stays', async () => {
      const log = join(dir, 'fake-ce.log');
      await installFakeCe(log);
      const t = await serveTables({
        'new.CT': { route: 'native', records: MASTER, enable: {} },
        'mid.CT': { route: 'ce', records: MASTER, enable: {} },
        'old.CT': { route: 'native', records: MASTER, enable: { 1: true } },
      });
      try {
        spawnSpy.mockClear();
        const n = nativeOpts(t, 'sw1');
        // Releasing the hold broadcasts session:engine with the session's mode.
        const modeAtRelease: (string | undefined)[] = [];
        n.release.mockImplementation(() => { modeAtRelease.push(getActiveSession()?.mode); });
        const r = await startSession(n.opts);
        expect(modeAtRelease).toEqual(['ce']);
        expect(r.attempts.map((a) => `${a.filename}:${a.verdict}`)).toEqual(['new.CT:broken', 'mid.CT:broken', 'old.CT:works']);
        expect(r).toMatchObject({
          mode: 'ce', engine: 'ce', tableId: 10, verdict: 'works',
          route: { engine: 'ce', codes: {}, first: { detail: 'cheat engine already running' } },
        });
        // The native backend was put away before Cheat Engine started, once.
        expect(n.backend.sends.at(-1)).toEqual({ method: 'shutdown' });
        expect(n.backend.close).toHaveBeenCalledTimes(1);
        expect(n.engine.detach).toHaveBeenCalledTimes(1);
        expect(n.release).toHaveBeenCalledTimes(1);
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        const lines = (await readFile(log, 'utf8')).split('\n');
        expect(lines.filter((l) => l.startsWith('ct='))).toEqual([expect.stringContaining('sw1-a20.ct')]);
        // The native-routable table after it loads in Cheat Engine, without asking the router.
        expect(lines.filter((l) => l.startsWith('load_table'))).toEqual(['load_table sw1-a10.ct']);
        expect(n.route.mock.calls.map((c) => c[1])).toEqual(['sw1#30', 'sw1#20']);
        expect(getActiveSession()).toMatchObject({ mode: 'ce', pid: 4242 });
        expect(ceSessionFor(4242)).toEqual({ sessionId: r.sessionId });
      } finally { await t.close(); }
    });

    it('a dropped starlightd connection ends a native session, clears hotkeys and releases the table hold', async () => {
      const log = join(dir, 'fake-ce.log');
      await installFakeCe(log);
      const t = await serveTables({ 'game.CT': { route: 'native', records: [{ id: 5, name: 'God Mode' }] } });
      try {
        // A game owner: the table hold is what starlightd holds the game with.
        const holders: string[] = [];
        const exited: string[] = [];
        const n = nativeOpts(t, 'drop1');
        n.holdTable.mockImplementation(() => { holders.push('table'); return n.release; });
        n.release.mockImplementation(() => { holders.splice(holders.indexOf('table'), 1); });
        const r = await startSession({
          ...n.opts, starlightdHolders: () => holders as never, onGameExit: (id) => { exited.push(id); },
        });
        expect(r.mode).toBe('native');
        hotkeyHost.clearSessionHotkeys.mockClear();
        scannerHost.end.mockClear();

        n.engine.drop();
        n.engine.drop();
        expect(exited).toEqual([r.sessionId]);
        expect(getActiveSession()).toBeNull();
        await vi.waitFor(() => { if (hotkeyHost.clearSessionHotkeys.mock.calls.length === 0) throw new Error('not yet'); }, { timeout: 2000, interval: 10 });
        expect(n.release).toHaveBeenCalledTimes(1);
        expect(holders).toEqual([]);
        expect(n.backend.close).toHaveBeenCalledTimes(1);
        expect(scannerHost.end).toHaveBeenCalledTimes(1);
        // Ending it again (the game exit landing too, or the renderer) does nothing more.
        await endSession({ sessionId: r.sessionId });
        expect(n.release).toHaveBeenCalledTimes(1);
        expect(n.backend.close).toHaveBeenCalledTimes(1);
        expect(exited).toHaveLength(1);

        // A CE-routed table on the same game now runs on Cheat Engine, not paused.
        const ce = await serveTables({ 'ce.CT': { route: 'ce', records: MASTER, enable: { 1: true } } });
        try {
          const c = nativeOpts(ce, 'drop1-ce');   // same pid (4242); its own cache entry
          const r2 = await startSession({ ...c.opts, starlightdHolders: () => holders as never });
          expect(r2).toMatchObject({ mode: 'ce', engine: 'ce' });
        } finally { await ce.close(); }
      } finally { await t.close(); }
    });

    it('a game exit and a dropped connection together end the native session once', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: [{ id: 5, name: 'God Mode' }] } });
      try {
        let alive = true;
        const exited: string[] = [];
        const n = nativeOpts(t, 'drop2');
        const r = await startSession({ ...n.opts, isGameAlive: () => alive, gameWatchMs: 20, onGameExit: (id) => { exited.push(id); } });
        alive = false;
        n.engine.drop();
        await new Promise((res) => setTimeout(res, 100));
        expect(exited).toEqual([r.sessionId]);
        expect(n.release).toHaveBeenCalledTimes(1);
        expect(n.backend.close).toHaveBeenCalledTimes(1);
      } finally { await t.close(); }
    });

    it('a retry on a native session skips a CE-routed candidate and stays native', async () => {
      const log = join(dir, 'fake-ce.log');
      await installFakeCe(log);
      const t = await serveTables({
        'new.CT': { route: 'native', records: MASTER, enable: {} },
        'mid.CT': { route: 'ce', records: MASTER, enable: { 1: true } },
      });
      try {
        spawnSpy.mockClear();
        // The agent holds the game at first, so the startup pick can't switch.
        let holders: string[] = ['agent'];
        const n = nativeOpts(t, 'rt1');
        const r = await startSession({ ...n.opts, starlightdHolders: () => holders as never });
        expect(r).toMatchObject({ mode: 'native', verdict: 'broken' });
        holders = [];
        const again = await retryTables({ sessionId: r.sessionId });
        expect(again).toMatchObject({ ok: true, verdict: 'broken', tableId: 20 });
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(n.release).not.toHaveBeenCalled();
        expect(n.engine.detach).not.toHaveBeenCalled();
        expect(n.backend.close).not.toHaveBeenCalled();
        expect(getActiveSession()).toMatchObject({ mode: 'native', pid: 4242 });
        expect(getActiveSession()!.backend?.kind).toBe('native');
        // Still usable.
        expect(await callSession({ sessionId: r.sessionId, method: 'set_value', params: { id: 2, value: '7' } })).toEqual({ ok: true, value: '7' });
      } finally { await t.close(); }
    });

    it('a CE-routed table on a game the agent holds opens paused, as before', async () => {
      const t = await serveTables({ 'game.CT': { route: 'ce', records: MASTER } });
      try {
        spawnSpy.mockClear();
        const n = nativeOpts(t, 'held1');
        const r = await startSession({ ...n.opts, starlightdHolders: () => ['agent'] });
        expect(r).toMatchObject({ mode: 'paused', engine: 'starlightd', holders: ['agent'], route: { engine: 'ce' } });
        expect(n.attachEngineFn).not.toHaveBeenCalled();
        expect(n.holdTable).not.toHaveBeenCalled();
        expect(spawnSpy).not.toHaveBeenCalled();
      } finally { await t.close(); }
    });

    it('a native-routed table on a game the agent holds runs native', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: MASTER, enable: { 1: true } } });
      try {
        const n = nativeOpts(t, 'held2');
        const r = await startSession({ ...n.opts, starlightdHolders: () => ['agent'] });
        expect(r).toMatchObject({ mode: 'native', verdict: 'works', holders: ['agent'] });
        expect(n.backend.fn).toHaveBeenCalledTimes(1);
        expect(getActiveSession()).toMatchObject({ mode: 'native' });
      } finally { await t.close(); }
    });

    it('anti-cheat refuses before any backend starts', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: MASTER } });
      try {
        spawnSpy.mockClear();
        const n = nativeOpts(t, 'ac-n');
        const ensureRuntime = vi.fn();
        await expect(startSession({
          ...n.opts, ensureRuntime,
          detectAntiCheatFn: async () => ({ name: 'Easy Anti-Cheat', module: 'EasyAntiCheat_EOS_x64.dll' }),
        })).rejects.toThrow(/won't attach/);
        expect(n.route).not.toHaveBeenCalled();           // R8: checked before routing
        expect(n.attachEngineFn).not.toHaveBeenCalled();
        expect(n.holdTable).not.toHaveBeenCalled();
        expect(n.backend.fn).not.toHaveBeenCalled();
        expect(ensureRuntime).not.toHaveBeenCalled();
        expect(spawnSpy).not.toHaveBeenCalled();

        // And again once the game has loaded its modules, on the native path too.
        const late = nativeOpts(t, 'ac-n2');
        let calls = 0;
        await expect(startSession({
          ...late.opts, waitForGameFn: async () => {},
          detectAntiCheatFn: async () => (++calls === 1 ? null : { name: 'Easy Anti-Cheat', module: 'easyanticheat_x64.dll' }),
        })).rejects.toThrow(/Easy Anti-Cheat is running in this game/);
        expect(calls).toBe(2);
        expect(late.backend.sends.some((c) => c.method === 'list_records')).toBe(false);   // never got to the pick
        expect(late.engine.detach).toHaveBeenCalledTimes(1);
        expect(late.release).toHaveBeenCalledTimes(1);
        expect(getActiveSession()).toBeNull();
      } finally { await t.close(); }
    });

    it('ptrace restricted without the grant refuses native with the Allow message', async () => {
      const t = await serveTables({ 'game.CT': { route: 'native', records: MASTER } });
      try {
        const n = nativeOpts(t, 'pt-n');
        await expect(startSession({
          ...n.opts, readPtraceScopeFn: async () => 1, engineNeedsPtraceGrantFn: async () => true,
        })).rejects.toThrow(PTRACE_MESSAGE);
        expect(n.attachEngineFn).not.toHaveBeenCalled();
        expect(n.holdTable).not.toHaveBeenCalled();
        // Unrestricted ptrace doesn't ask.
        const free = nativeOpts(t, 'pt-n2');
        const engineNeedsPtraceGrantFn = vi.fn(async () => true);
        expect(await startSession({ ...free.opts, engineNeedsPtraceGrantFn })).toMatchObject({ mode: 'native' });
        expect(engineNeedsPtraceGrantFn).not.toHaveBeenCalled();
      } finally { await t.close(); }
    });
  });

  it('forwards hotkey presses from Cheat Engine', async () => {
    await installFakeCe(join(dir, 'fake-ce.log'));
    const events: Record<string, unknown>[] = [];
    const r = await startSession({ source: await startCtServer(), cacheKey: 'hk1', runtimeRoot: dir, ctCacheDir, onEvent: (e) => events.push(e), ...native });
    expect(await callSession({ sessionId: r.sessionId, method: 'set_hotkeys', params: { bindings: [{ id: 7, keys: [0x61] }], replace: [] } })).toEqual({ ok: true, count: 1 });
    await new Promise((res) => setTimeout(res, 200));
    expect(events).toEqual([{ type: 'hotkey', id: 7, ok: true, active: true }]);
  });
});

describe('cleanCeError', () => {
  it('strips the Lua chunk prefix and blank padding', () => {
    expect(cleanCeError('Lua error in the script at line 25:[string "local syntaxcheck,memrec=...\r..."]:146: No hook installed.\r\n\r\naddrA: 0 matches'))
      .toBe('No hook installed.\naddrA: 0 matches');
  });
  it('leaves plain messages alone', () => {
    expect(cleanCeError("Error while scanning for AOB's : CashAOB \r\n\r\nError: Not all results found"))
      .toBe("Error while scanning for AOB's : CashAOB\nError: Not all results found");
  });
  it('recognises version-mismatch failures', () => {
    expect(isStaleTableError('Error: Not all results found')).toBe(true);
    expect(isStaleTableError('not attached to a game process')).toBe(false);
  });
});
