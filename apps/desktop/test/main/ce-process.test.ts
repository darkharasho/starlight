import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnCeProcess, type CeProcessHandle, type CeProcessOpts } from '../../src/main/ce-process.js';

let dir: string;
let winCeDir: string;
let launcher: string;
let probe: string;
let handle: CeProcessHandle | undefined;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-ceproc-${Date.now()}-${Math.random()}`);
  winCeDir = join(dir, 'CheatEngineWindows75');
  await mkdir(join(winCeDir, 'autorun'), { recursive: true });
  probe = join(dir, 'probe.txt');
  // Stands in for `proton` / `wine`: records its argv, then exits.
  launcher = join(dir, 'launcher.sh');
  await writeFile(launcher, `#!/bin/sh\necho "$@" > ${probe}\nexit 0\n`);
  await chmod(launcher, 0o755);
});
afterEach(async () => {
  if (handle) await handle.kill('SIGKILL').catch(() => {});
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
});

function opts(extra: Partial<CeProcessOpts> = {}, env: Record<string, string> = {}): CeProcessOpts {
  return {
    launch: { command: launcher, args: ['run'], env, winCeExe: join(winCeDir, 'ce.exe'), winCeDir },
    controlScript: '-- starlight test\n',
    sessionId: 'sess-1',
    runtimeRoot: dir,
    ...extra,
  };
}

function untilExit(o: CeProcessOpts): Promise<number | null> {
  return new Promise((resolve) => {
    void (async () => {
      handle = await spawnCeProcess({ ...o, onExit: (code) => resolve(code) });
    })();
  });
}

describe('spawnCeProcess', () => {
  it('writes the autorun script and runs Windows CE through the launcher (no CT on argv)', async () => {
    await writeFile(launcher, `#!/bin/sh\necho "$@" > ${probe}\ncat autorun/zzz-starlight.lua >> ${probe}\nexit 0\n`);
    expect(await untilExit(opts())).toBe(0);
    const out = await readFile(probe, 'utf8');
    expect(out.split('\n')[0]).toBe(`run ${join(winCeDir, 'ce.exe')}`);
    expect(out).toContain('starlight test');
  });

  it('removes the autorun script after the child exits', async () => {
    await untilExit(opts());
    await new Promise((r) => setTimeout(r, 50));
    await expect(access(join(winCeDir, 'autorun', 'zzz-starlight.lua'))).rejects.toBeTruthy();
  });

  it('kill() resolves after the child exits', async () => {
    await writeFile(launcher, '#!/bin/sh\nsleep 30\n');
    handle = await spawnCeProcess(opts());
    const start = Date.now();
    await handle.kill('SIGTERM');
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it('forwards stderr lines via onStderrLine when provided', async () => {
    await writeFile(launcher, '#!/bin/sh\necho "first error" 1>&2\necho "second error" 1>&2\nexit 0\n');
    const lines: string[] = [];
    await untilExit(opts({ onStderrLine: (l) => { lines.push(l); } }));
    expect(lines).toEqual(['first error', 'second error']);
  });

  it('passes the launch environment and tags the process with its session and runtime root', async () => {
    await writeFile(launcher, '#!/bin/sh\necho "data=$STEAM_COMPAT_DATA_PATH install=$STEAM_COMPAT_INSTALL_PATH session=$STARLIGHT_CE_SESSION root=$STARLIGHT_CE_ROOT"\nexit 0\n');
    const lines: string[] = [];
    await untilExit(opts(
      { onStdoutLine: (l) => { lines.push(l); } },
      { STEAM_COMPAT_DATA_PATH: '/c/data', STEAM_COMPAT_INSTALL_PATH: '/lib/steamapps/common/G' },
    ));
    expect(lines).toEqual([`data=/c/data install=/lib/steamapps/common/G session=sess-1 root=${dir}`]);
  });
});
