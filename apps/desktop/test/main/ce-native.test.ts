// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { findProton, findWineRunner, rankProtonDirs, startCeServer, hasPtraceCap, grantPtraceCap } from '../../src/main/ce-native.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-cenative-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function putProton(lib: string, name: string): Promise<string> {
  const d = join(lib, 'steamapps', 'common', name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'proton'), '#!/usr/bin/env python3\n');
  return join(d, 'proton');
}

describe('rankProtonDirs', () => {
  it('puts the newest numbered Proton first, then Experimental, then the rest', () => {
    expect(rankProtonDirs(['Proton Hotfix', 'Proton - Experimental', 'Proton 8.0', 'Proton 11.0', 'Proton 9.0-4']))
      .toEqual(['Proton 11.0', 'Proton 9.0-4', 'Proton 8.0', 'Proton - Experimental', 'Proton Hotfix']);
  });
});

describe('findProton', () => {
  it('finds the best Proton across Steam libraries', async () => {
    const steam = join(dir, 'steam');
    const lib2 = join(dir, 'games');
    await putProton(steam, 'Proton 9.0');
    const best = await putProton(lib2, 'Proton 10.0');
    await mkdir(join(steam, 'steamapps'), { recursive: true });
    await writeFile(join(steam, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n "0"\n {\n  "path" "${steam}"\n }\n "1"\n {\n  "path" "${lib2}"\n }\n}\n`);
    expect(await findProton(steam)).toBe(best);
  });

  it('returns null when Steam has no Proton', async () => {
    await mkdir(join(dir, 'steamapps', 'common', 'Some Game'), { recursive: true });
    expect(await findProton(dir)).toBeNull();
  });
});

describe('findWineRunner', () => {
  it("prefers Proton, in Starlight's own compat data dir", async () => {
    const r = await findWineRunner({
      prefixRoot: '/rt/prefix', steamRoot: '/steam',
      findProtonFn: async () => '/steam/Proton 10.0/proton', which: async () => '/usr/bin/wine',
    });
    expect(r).toEqual({
      kind: 'proton', command: '/steam/Proton 10.0/proton', args: ['run'], prefixDir: '/rt/prefix/proton',
      env: { STEAM_COMPAT_DATA_PATH: '/rt/prefix/proton', STEAM_COMPAT_CLIENT_INSTALL_PATH: '/steam' },
    });
  });

  it('falls back to Wine, without the Mono and Gecko install prompts', async () => {
    const r = await findWineRunner({
      prefixRoot: '/rt/prefix', steamRoot: null, which: async () => '/usr/bin/wine',
    });
    expect(r).toMatchObject({ kind: 'wine', command: '/usr/bin/wine', args: [] });
    expect(r?.env).toMatchObject({ WINEPREFIX: '/rt/prefix/wine', WINEDLLOVERRIDES: 'mscoree,mshtml=' });
  });

  it('returns null with neither', async () => {
    expect(await findWineRunner({ prefixRoot: '/p', steamRoot: '/s', findProtonFn: async () => null, which: async () => null })).toBeNull();
  });
});

describe('startCeServer', () => {
  /** A stand-in ceserver: listens on 127.0.0.1 at the `-p` port. */
  async function fakeServer(body = ''): Promise<string> {
    const bin = join(dir, 'ceserver');
    await writeFile(bin, `#!/usr/bin/env node
const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
${body}
require('net').createServer((s) => s.end()).listen(port, '127.0.0.1');
`);
    await chmod(bin, 0o755);
    return bin;
  }

  const reachable = (port: number): Promise<boolean> => new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });

  it('starts on a free port, waits until it accepts connections, and stops it', async () => {
    const srv = await startCeServer({ bin: await fakeServer() });
    expect(await reachable(srv.port)).toBe(true);
    expect(srv.pid).toBeGreaterThan(0);
    await srv.stop();
    expect(await reachable(srv.port)).toBe(false);
  });

  it('fails when ceserver exits instead of listening', async () => {
    await expect(startCeServer({ bin: await fakeServer('process.exit(1);') })).rejects.toThrow(/exited/);
  });
});

describe('hasPtraceCap', () => {
  const status = (capEff: string) => async () => `Name:\tceserver\nCapInh:\t0000000000000000\nCapEff:\t${capEff}\n`;

  it('sees CAP_SYS_PTRACE (bit 19) in the effective set', async () => {
    expect(await hasPtraceCap(1, status('0000000000080000'))).toBe(true);
    expect(await hasPtraceCap(1, status('000001ffffffffff'))).toBe(true);   // root
  });

  it('is false without it, or when the process is gone', async () => {
    expect(await hasPtraceCap(1, status('0000000000000000'))).toBe(false);
    expect(await hasPtraceCap(1, async () => { throw new Error('ENOENT'); })).toBe(false);
  });

  it('reads a real process', async () => {
    expect(typeof await hasPtraceCap(process.pid)).toBe('boolean');
  });
});

describe('grantPtraceCap', () => {
  const onlyAt = (path: string) => async (p: string) => p === path;

  it('runs setcap on ceserver through pkexec', async () => {
    const calls: [string, string[]][] = [];
    const r = await grantPtraceCap({
      bin: '/rt/ceserver-7.5/ceserver', exists: onlyAt('/usr/bin/setcap'),
      run: async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stderr: '' }; },
    });
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([['pkexec', ['/usr/bin/setcap', 'cap_sys_ptrace=ep', '/rt/ceserver-7.5/ceserver']]]);
  });

  it('reports a dismissed password prompt as cancelled', async () => {
    const r = await grantPtraceCap({ bin: '/b', exists: onlyAt('/usr/sbin/setcap'), run: async () => ({ code: 126, stderr: '' }) });
    expect(r).toMatchObject({ ok: false, cancelled: true });
  });

  it('gives the terminal command when setcap or pkexec is missing', async () => {
    expect(await grantPtraceCap({ bin: '/b', exists: async () => false, run: async () => ({ code: 0, stderr: '' }) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('sudo setcap cap_sys_ptrace=ep "/b"') });
    expect(await grantPtraceCap({ bin: '/b', exists: onlyAt('/sbin/setcap'), run: async () => ({ code: null, stderr: 'spawn pkexec ENOENT' }) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('sudo setcap') });
  });
});
