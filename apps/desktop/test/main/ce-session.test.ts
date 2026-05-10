// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { startSession, setActive, endSession, getActiveSession } from '../../src/main/ce-session.js';

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
});
