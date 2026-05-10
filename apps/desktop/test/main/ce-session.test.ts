import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSession, setActive, endSession, getActiveSession } from '../../src/main/ce-session.js';

let dir: string;
let installDir: string;
let binary: string;
let ctPath: string;

// Fake binary that "speaks" the bridge protocol — once spawned with .CT path
// argv[1], it polls the bridge URL (passed via env var) and replies.
// For tests we use a much simpler approach: just spawn a child that does nothing,
// then have the test code post commands directly to the bridge URL CE would have used.
// The session will time out waiting for ping. So we override `pingTimeoutMs` to a small value
// and assert on the timeout failure path.

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-ce-session-${Date.now()}-${Math.random()}`);
  installDir = join(dir, 'CheatEngineLinux766-4');
  await mkdir(join(installDir, 'autorun'), { recursive: true });
  binary = join(installDir, 'cheatengine-x86_64');
  // Default: a "stuck" binary that never responds.
  await writeFile(binary, '#!/bin/sh\nsleep 30\n');
  await chmod(binary, 0o755);
  ctPath = join(dir, 'trainer.CT');
  await writeFile(ctPath, '<CheatTable />');
});
afterEach(async () => {
  if (getActiveSession()) await endSession({ sessionId: getActiveSession()!.sessionId }).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe('ce-session', () => {
  it('rejects start when runtime is not installed', async () => {
    // Use a dir where the binary does not exist.
    await rm(binary, { force: true });
    await expect(startSession({
      ctPath, runtimeRoot: dir, pingTimeoutMs: 500,
    })).rejects.toThrow(/not installed|not-installed/i);
  });

  it('times out cleanly when CE never responds to ping', async () => {
    await expect(startSession({
      ctPath, runtimeRoot: dir, pingTimeoutMs: 500,
    })).rejects.toThrow(/timed out|ping/i);
    expect(getActiveSession()).toBeNull();
  });

  it('endSession is idempotent and tolerates missing session', async () => {
    const r = await endSession({ sessionId: 'nonexistent' });
    expect(r.ok).toBe(true);
  });
});
