#!/usr/bin/env node
// Live check for 32-bit games on starlightd: our own w32.exe under Proton, in Proton's default
// mode (a 32-bit Linux process) and in WoW64 mode (PROTON_USE_WOW64=1: a 64-bit process running
// 32-bit code).
//
//   node scripts/live-32.mjs [default|wow64|both] [--expect-wow64 works|refused]   (default: works)
//
// Needs `cargo build` in packages/starlightd, `pnpm --filter @starlight/engine build` and
// `make -C packages/engine/test-target/win build/w32.exe`. PROTON overrides the Proton directory.
//
// Safety (as live-m4.mjs): only processes this script starts are touched (pid + start time), every
// tree runs under a child-subreaper wrapper, Proton runs only through `proton runinprefix` with a
// fresh temp STEAM_COMPAT_DATA_PATH and STEAM_COMPAT_CLIENT_INSTALL_PATH, and cleanup stops only our
// own prefix's wineserver.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PY_DESCENDANTS, statOf, trackOwned } from './live-procs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(join(ROOT, 'packages/engine/dist/index.js'));
const DAEMON = join(ROOT, 'packages/starlightd/target/debug/starlightd');
const W32 = join(ROOT, 'packages/engine/test-target/win/build/w32.exe');
const PROTON_DIR = process.env.PROTON ?? join(homedir(), '.steam/steam/steamapps/common/Proton 11.0');
const SPEED_32 = "Game speed doesn't work with 32-bit games yet.";

const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith('--')) ?? 'both';
const expectWow64 = args.includes('--expect-wow64') ? args[args.indexOf('--expect-wow64') + 1] : 'works';
const modes = which === 'both' ? ['default', 'wow64'] : [which];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const hex = (n) => '0x' + BigInt(n).toString(16);
const info = (m) => console.log(`     ${m}`);
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`ok   ${name}${detail ? ` (${detail})` : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
  return !!cond;
}
async function waitFor(fn, ms, every = 200) {
  const end = now() + ms;
  for (;;) {
    const v = await fn();
    if (v || now() > end) return v;
    await sleep(every);
  }
}

// ------------------------------------------------------------- own processes (pid + start time)
function killOwn(pid, start, sig = 'SIGKILL') {
  if (!pid || start === undefined || statOf(pid)?.start !== start) return false;
  try { process.kill(pid, sig); return true; } catch { return false; }
}
const alive = (pid, start) => { const st = statOf(pid); return !!st && st.state !== 'Z' && (start === undefined || st.start === start); };
const trees = [];
const cleanups = [];
let cleanedUp = false;
function cleanupSync() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const f of cleanups.splice(0).reverse()) { try { f(); } catch (e) { info(`cleanup error: ${e.message}`); } }
  const left = [];
  for (const t of trees) { t.track(); for (const [p, s] of t.owned) if (alive(p, s)) left.push(`${p}:${statOf(p)?.comm}`); }
  info(`own processes left after cleanup: ${left.length ? left.join(', ') : 'none'}`);
  if (left.length) failures++;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { console.log(`FAIL interrupted by ${sig}`); cleanupSync(); process.exit(130); });
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, (e) => { console.log(`FAIL ${ev}: ${e?.stack ?? e}`); cleanupSync(); process.exit(1); });

const SUBREAPER = `
import ctypes, os, signal, subprocess, sys
libc = ctypes.CDLL(None)
libc.prctl(36, 1, 0, 0, 0)
${PY_DESCENDANTS.trim()}
def on_parent_death(*_):
    for _ in range(3):
        for p in descendants():
            try: os.kill(p, signal.SIGKILL)
            except Exception: pass
    os._exit(1)
signal.signal(signal.SIGUSR1, on_parent_death)
libc.prctl(1, signal.SIGUSR1, 0, 0, 0)
if os.getppid() != int(os.environ.get('LIVE_PARENT', os.getppid())): on_parent_death()
subprocess.Popen(sys.argv[1:])
while True:
    try: os.wait()
    except ChildProcessError: break
`;
function spawnTree(name, argv, opts) {
  const child = spawn('python3', ['-I', '-c', SUBREAPER, ...argv], { ...opts, env: { ...(opts.env ?? process.env), LIVE_PARENT: String(process.pid) } });
  const rootStart = child.pid ? statOf(child.pid)?.start : undefined;
  const owned = new Map();
  if (rootStart !== undefined) owned.set(child.pid, rootStart);
  const t = { name, child, owned, root: child.pid, rootStart, track: () => trackOwned(owned) };
  trees.push(t);
  return t;
}
function killTree(t, extra = () => {}) {
  killOwn(t.root, t.rootStart, 'SIGSTOP');
  t.track();
  for (const [p, s] of t.owned) if (p !== t.root) killOwn(p, s);
  extra();
  sleepSync(300);
  t.track();
  for (const [p, s] of t.owned) if (p !== t.root) killOwn(p, s);
  killOwn(t.root, t.rootStart, 'SIGCONT');
  killOwn(t.root, t.rootStart);
  sleepSync(200);
}

// ----------------------------------------------------------------------------------- proton
function protonEnv(pfx, client, wow64) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(STEAM_COMPAT_|WINE|PROTON_)/.test(k) || /^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY)$/.test(k)) delete env[k];
  }
  env.STEAM_COMPAT_DATA_PATH = pfx;
  env.STEAM_COMPAT_CLIENT_INSTALL_PATH = client;
  if (wow64) env.PROTON_USE_WOW64 = '1';
  return env;
}
const mapsImage = (pid, image) => { try { return readFileSync(`/proc/${pid}/maps`, 'utf8').includes(`/${image}`); } catch { return false; } };

async function runW32(env, timeoutMs) {
  const t = spawnTree('proton w32.exe', [join(PROTON_DIR, 'proton'), 'runinprefix', W32], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  t.child.stderr.setEncoding('utf8');
  t.child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-20000); });
  const a = {};
  let buf = '';
  t.child.stdout.setEncoding('utf8');
  t.child.stdout.on('data', (c) => {
    buf += c;
    for (const m of buf.matchAll(/^addr (\w+)=(?:0x)?([0-9a-fA-F]+)\s*$/gm)) a[m[1]] = hex('0x' + m[2]);
  });
  let pid = 0;
  const deadline = now() + timeoutMs;
  while ((!pid || !a.gold || !a.p1 || !a.addGold) && now() < deadline) {
    t.track();
    pid = [...t.owned.keys()].find((p) => statOf(p)?.comm === 'w32.exe' || mapsImage(p, 'w32.exe')) ?? 0;
    if (t.child.exitCode !== null) break;
    await sleep(250);
  }
  return { tree: t, pid, start: t.owned.get(pid), a, stderr: () => stderr, ok: !!pid && !!a.gold && !!a.p1 && !!a.addGold };
}

const elfClass = (pid) => { try { return readFileSync(`/proc/${pid}/exe`).subarray(4, 5)[0] === 1 ? 32 : 64; } catch { return null; } };

// ------------------------------------------------------------------------------------ checks
async function runMode(mode) {
  console.log(`\n== ${mode} ==`);
  const wow64 = mode === 'wow64';
  const tmp = mkdtempSync(join(tmpdir(), `starlight-live-32-${mode}-`));
  const pfx = join(tmp, 'pfx');
  const client = join(tmp, 'client');
  mkdirSync(pfx);
  mkdirSync(client);
  info(`throwaway prefix ${pfx}`);
  const env = protonEnv(pfx, client, wow64);
  const wsKill = () => {
    const ws = spawnSync(join(PROTON_DIR, 'files/bin/wineserver'), ['-k'], { env: { ...env, WINEPREFIX: join(pfx, 'pfx') }, timeout: 15000, stdio: 'ignore' });
    info(`wineserver -k (own prefix) exit ${ws.status}`);
  };
  let g = null;
  let engine = null;
  const done = () => {
    if (g) killTree(g.tree, wsKill);
    rmSync(tmp, { recursive: true, force: true });
  };
  cleanups.push(done);
  try {
    g = await runW32(env, 240_000);
    if (!check(`${mode}: w32.exe starts`, g.ok, `pid ${g.pid}`)) { info(g.stderr().slice(-600).replace(/\s+/g, ' ')); return; }
    info(`/proc/${g.pid}/exe is ELF${elfClass(g.pid)}; gold ${g.a.gold}, p1 ${g.a.p1}, addGold ${g.a.addGold}`);

    const dir = mkdtempSync(join(tmpdir(), 'starlight-live-32-sock-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    engine = await E.startEngine({ binary: DAEMON, socketPath: join(dir, 'sock') });
    cleanups.push(() => { void engine.stop().catch(() => {}); });
    const c = engine.client;

    // 2. Facts.
    const s = await E.attach(c, g.pid, { mainModule: 'w32.exe' });
    const codeBits = await waitFor(() => s.codeBits(), 10_000);
    check(`${mode}: bitness facts`, s.processBits === (wow64 ? 64 : 32) && codeBits === 32, `process ${s.processBits}, code ${codeBits}`);
    const readI32 = async (a) => Buffer.from((await c.call('read', { handle: s.handle, address: a, length: 4 })).bytes, 'hex').readInt32LE(0);

    // 3. Pointer chain (4-byte pointers).
    const r = await c.call('resolve_pointer', { handle: s.handle, base: g.a.p1, offsets: ['0x0', '0x0'] });
    check(`${mode}: pointer chain p1 -> p2 -> gold`, BigInt(r.address) === BigInt(g.a.gold), `${r.address}`);

    // 4-6. Alloc, a 32-bit script at the alloc, a jmp patched into addGold, restore.
    const codeOk = !wow64 || expectWow64 === 'works';
    let cave = null;
    try {
      cave = await c.call('alloc', { handle: s.handle, size: 4096 });
    } catch (e) {
      if (codeOk) check(`${mode}: alloc`, false, e.message);
      else check(`${mode}: alloc refused while WoW64 is guarded`, /32-bit games isn't supported yet/.test(e.message), e.message);
    }
    if (cave) {
      check(`${mode}: alloc below 4 GiB`, BigInt(cave.address) < 0x1_0000_0000n, cave.address);
      if (!codeOk) check(`${mode}: alloc was expected to be refused`, false);
      await c.call('write', { handle: s.handle, address: cave.address, bytes: 'deadbeef' });
      const back = (await c.call('read', { handle: s.handle, address: cave.address, length: 4 })).bytes;
      check(`${mode}: write/read in the alloc`, back === 'deadbeef', back);
      const code = await E.assemble(s, { address: cave.address, source: 'mov dword ptr [gold],#7777\nret', symbols: { gold: g.a.gold } });
      await c.call('write', { handle: s.handle, address: cave.address, bytes: code.bytes.toString('hex') });
      const jmp = await E.assemble(s, { address: g.a.addGold, source: `jmp ${cave.address}` });
      check(`${mode}: 32-bit jmp assembled`, jmp.bytes.length === 5 && jmp.bytes[0] === 0xe9, jmp.bytes.toString('hex'));
      const p = await c.call('patch', { handle: s.handle, address: g.a.addGold, bytes: jmp.bytes.toString('hex') });
      const hooked = await waitFor(async () => (await readI32(g.a.gold)) === 7777, 3000);
      check(`${mode}: hooked addGold sets gold to 7777`, hooked, String(await readI32(g.a.gold)));
      await c.call('unpatch', { id: p.id });
      const before = await readI32(g.a.gold);
      const grows = await waitFor(async () => (await readI32(g.a.gold)) > before, 3000);
      check(`${mode}: unpatched addGold counts again`, grows, `${before} -> ${await readI32(g.a.gold)}`);
      await c.call('free', { handle: s.handle, address: cave.address });
    }

    // 7. Lua.
    const lua = await c.call('lua_open', { handle: s.handle });
    const lr = await c.call('lua_run', { id: lua.id, chunk: "return string.format('%x', readPointer('p1')) .. ' ' .. tostring(targetIs64Bit())", name: 'live', symbols: { p1: g.a.p1 } });
    const [p2, is64] = String(lr.returned ?? '').split(' ');
    const p2Real = Buffer.from((await c.call('read', { handle: s.handle, address: g.a.p1, length: 4 })).bytes, 'hex').readUInt32LE(0);
    check(`${mode}: Lua readPointer reads 4 bytes`, lr.ok && BigInt('0x' + p2) === BigInt(p2Real) && is64 === 'false', String(lr.returned ?? lr.error));

    // 8. Speed refused.
    try {
      await c.call('speed_set', { handle: s.handle, speed: 2 });
      check(`${mode}: speed refused`, false, 'speed_set succeeded');
    } catch (e) {
      check(`${mode}: speed refused`, e.message === SPEED_32, e.message);
    }
    check(`${mode}: game still alive`, alive(g.pid, g.start));
    await s.detach();
  } finally {
    await engine?.stop().catch(() => {});
    cleanups.splice(cleanups.indexOf(done), 1);
    done();
  }
}

if (!existsSync(join(PROTON_DIR, 'proton')) || !existsSync(W32) || !existsSync(DAEMON)) {
  console.error(`need ${PROTON_DIR}/proton, ${W32} and ${DAEMON}`);
  process.exit(2);
}
try {
  for (const m of modes) await runMode(m);
} finally {
  cleanupSync();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
