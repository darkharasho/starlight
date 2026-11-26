// End-to-end sharing, all local: the app's share host sends a cheat to the
// real Worker under `wrangler dev --local`, which talks to a fake GitHub that
// writes the file into a temp catalog; the Pages publish step runs on it; the
// app's community host loads the result over HTTP. Run by scripts/share-e2e.mjs
// (SHARE_E2E=1); skipped in normal test runs.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createShareHost } from '../../src/main/share-host.js';
import { createCommunityHost } from '../../src/main/community-host.js';
import { saveUserCheat } from '../../src/main/user-cheats.js';

const ROOT = resolve(__dirname, '../../../..');
const RELAY = join(ROOT, 'apps/share-relay');
const cleanups: Array<() => Promise<void> | void> = [];
let wranglerLog = '';
const ghLog: string[] = [];
afterAll(async () => { for (const c of cleanups.reverse()) await c(); });

function listen(server: Server): Promise<number> {
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
}
async function freePort(): Promise<number> {
  const s = createServer();
  const p = await listen(s);
  await new Promise((ok) => s.close(ok));
  return p;
}

/** A fake GitHub that writes added files under `repo`. */
function fakeGitHub(repo: string): Server {
  let next = 1;
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = new URL(req.url!, 'http://x').pathname;
      ghLog.push(`${req.method} ${path}`);
      const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && /\/access_tokens$/.test(path)) return send(201, { token: 't' });
      if (req.method === 'GET' && path.endsWith('/git/ref/heads/main')) return send(200, { object: { sha: 'main' } });
      if (req.method === 'POST' && path.endsWith('/git/refs')) return send(201, {});
      const put = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path);
      if (req.method === 'PUT' && put) {
        const rel = normalize(decodeURIComponent(put[1]!));
        if (!rel.startsWith('packages/catalog/community/')) return send(403, { message: 'outside community' });
        const dest = join(repo, rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, Buffer.from(body.content, 'base64'));
        return send(201, {});
      }
      if (req.method === 'POST' && /\/pulls$/.test(path)) { const n = next++; return send(201, { number: n, html_url: `https://github.test/pull/${n}` }); }
      if (req.method === 'POST' && /\/labels$/.test(path)) return send(200, []);
      const pr = /\/pulls\/(\d+)$/.exec(path);
      if (req.method === 'GET' && pr) return send(200, { state: 'open', merged: false, html_url: `https://github.test/pull/${pr[1]}` });
      return send(404, { message: 'nope' });
    });
  });
}

function serveDir(dir: string): Server {
  return createServer(async (req, res) => {
    const file = join(dir, normalize(new URL(req.url!, 'http://x').pathname));
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try { const b = await readFile(file); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); } catch { res.writeHead(404); res.end(); }
  });
}

async function rsaPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`;
}

function startWrangler(port: number, vars: Record<string, string>, state: string): Promise<ChildProcess> {
  const args = ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const child = spawn(join(RELAY, 'node_modules/.bin/wrangler'), args, {
    cwd: RELAY, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  cleanups.push(() => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ } });
  return new Promise((ok, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error(`wrangler dev didn't start:\n${log}`)), 90_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      wranglerLog = log;
      if (/Ready on/i.test(log)) { clearTimeout(timer); ok(child); }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const keep = (d: Buffer) => { wranglerLog += d.toString(); };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`wrangler dev exited (${code}):\n${log}`)); });
  });
}

describe.skipIf(!process.env.SHARE_E2E)('share end to end', () => {
  it('a shared cheat comes back as a community cheat', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'share-e2e-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const repo = join(tmp, 'repo');
    await mkdir(join(repo, 'packages/catalog/community'), { recursive: true });
    await writeFile(join(repo, 'packages/catalog/index.json'), JSON.stringify({ schemaVersion: 1, generatedAt: '2026-11-01T00:00:00.000Z', games: [] }));

    const gh = fakeGitHub(repo);
    const ghPort = await listen(gh);
    cleanups.push(() => new Promise((ok) => gh.close(() => ok())));

    const relayPort = await freePort();
    await startWrangler(relayPort, {
      GITHUB_API: `http://127.0.0.1:${ghPort}`, GITHUB_APP_KEY: await rsaPem(), GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2',
    }, join(tmp, 'wrangler-state'));

    // The player's cheat, shared through the app's share host.
    const lib = join(tmp, 'lib');
    const { id } = await saveUserCheat(lib, 'testgame', { name: 'Test Game', exeName: 'game.exe', proton: true, steamAppId: 1234 }, {
      name: 'Infinite gold', type: 'freeze', valueType: 'int32', value: 999,
      address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x10', offsets: ['0x4'] },
      verify: { range: { min: 0, max: 9999 } },
      provenance: { kind: 'agent', agent: 'e2e', createdAt: '2026-11-25T00:00:00.000Z', game: { steamAppId: 1234, buildId: '555' }, bits: 64 },
    } as never);
    const share = createShareHost({ dir: lib, userData: join(tmp, 'ud'), appVersion: 'e2e', relayUrl: `http://127.0.0.1:${relayPort}/submit` });
    const sent = await share.send({ key: 'testgame', id, pid: null, credit: 'E2E' });
    if (!sent.ok) {
      const q = await fetch(`http://127.0.0.1:${relayPort}/cdn-cgi/local/explorer/api/local/observability/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT * FROM logs LIMIT 20' }),
      }).then((r) => r.text(), (e) => String(e));
      console.log(`--- worker logs:\n${q}`);
    }
    if (!sent.ok) console.log(`--- github calls:\n${ghLog.join('\n')}\n--- wrangler:\n${wranglerLog.slice(-4000)}`);
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, state: 'open', duplicate: false });
    const again = await share.send({ key: 'testgame', id, pid: null, credit: 'E2E' });
    expect(again).toMatchObject({ ok: true, duplicate: true });

    // The maintainer merges; the Pages build publishes.
    const added = execFileSync('find', [join(repo, 'packages/catalog/community'), '-name', '*.json'], { encoding: 'utf8' }).trim().split('\n');
    expect(added).toHaveLength(1);
    const hash12 = /([0-9a-f]{12})\.json$/.exec(added[0]!)![1]!;
    const deploy = join(tmp, 'deploy');
    await mkdir(deploy, { recursive: true });
    await writeFile(join(deploy, 'index.json'), await readFile(join(repo, 'packages/catalog/index.json')));
    execFileSync(process.env.NODE_BINARY ?? 'node', [join(ROOT, 'scripts/build-community.mjs'), join(repo, 'packages/catalog'), deploy], { stdio: 'pipe' });
    expect((await stat(join(deploy, 'community', '1234', `${hash12}.json`))).isFile()).toBe(true);
    const catalog = JSON.parse(await readFile(join(deploy, 'index.json'), 'utf8'));
    expect(catalog.games).toEqual([expect.objectContaining({ steamAppId: 1234, communityOnly: true, name: 'Test Game' })]);

    // Another player's app loads it.
    const site = serveDir(deploy);
    const sitePort = await listen(site);
    cleanups.push(() => new Promise((ok) => site.close(() => ok())));
    const community = createCommunityHost({ cacheDir: join(tmp, 'cache'), baseUrl: `http://127.0.0.1:${sitePort}/`, minRefreshMs: 0 });
    const loaded = await community.trainer(1234, { platform: 'windows', bits: 64, buildId: '555' });
    const cheat = loaded!.trainer.categories[0]!.cheats[0]!;
    expect(cheat.id).toBe(`c-${hash12}`);
    expect(cheat.name).toBe('Infinite gold');
    expect(loaded!.meta.get(cheat.id)).toMatchObject({ credit: 'E2E', buildId: '555', older: false });
    console.log('share-e2e: ok');
  }, 150_000);
});
