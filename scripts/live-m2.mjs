#!/usr/bin/env node
// Live verification for native engine milestone 2 (discovery, code injection, speed).
//
//   node scripts/live-m2.mjs native   # the C test target, spawned here
//   node scripts/live-m2.mjs proton   # clocks.exe under Proton, in a throwaway prefix
//
// Needs: `cargo build --release` in packages/starlightd (STARLIGHTD overrides the binary),
// `pnpm --filter @starlight/engine build`, `make -C packages/engine/test-target` and, for proton,
// `make -C packages/engine/test-target/win`. PROTON overrides the Proton directory.
//
// Safety: this script only touches processes it starts itself. The Proton target is found among
// this script's own descendants, the prefix is a fresh temp dir (never a game's compatdata), and
// cleanup kills only pids we spawned or their descendants, then stops our own prefix's wineserver.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(join(ROOT, 'packages/engine/dist/index.js'));
const DAEMON = process.env.STARLIGHTD ?? join(ROOT, 'packages/starlightd/target/release/starlightd');
const TARGET = join(ROOT, 'packages/engine/test-target/build/target');
const CLOCKS = join(ROOT, 'packages/engine/test-target/win/build/clocks.exe');
const PROTON_DIR = process.env.PROTON ?? join(homedir(), '.steam/steam/steamapps/common/Proton 11.0');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + BigInt(n).toString(16);
const now = () => Number(process.hrtime.bigint()) / 1e6;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`ok   ${name}${detail ? ` (${detail})` : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
  return cond;
}
const info = (msg) => console.log(`     ${msg}`);
const near = (rate, want, tol = 0.1) => Math.abs(rate - want) <= want * tol;

// ---------------------------------------------------------------- daemons (only ones we start)

const daemons = [];
async function startDaemon() {
  const dir = mkdtempSync(join(tmpdir(), 'starlight-live-m2-sock-'));
  const engine = await E.startEngine({ binary: DAEMON, socketPath: join(dir, 'sock') });
  const d = { engine, dir, pid: engine.pid };
  daemons.push(d);
  return d;
}
const alive = (pid) => existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
async function stopDaemons() {
  for (const d of daemons.splice(0)) {
    await Promise.race([d.engine.stop().catch(() => {}), sleep(4000)]);
    if (alive(d.pid)) try { process.kill(d.pid, 'SIGKILL'); } catch { /* gone */ }
    rmSync(d.dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- own descendants via /proc ppid

function statOf(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(rest[1]), start: rest[19], comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')) };
  } catch { return null; }
}
function descendants(roots) {
  const children = new Map();
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    const st = statOf(Number(e));
    if (!st) continue;
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(Number(e));
  }
  const out = [];
  const queue = [...roots];
  while (queue.length) {
    const p = queue.shift();
    for (const c of children.get(p) ?? []) { out.push(c); queue.push(c); }
  }
  return out;
}

// ------------------------------------------------------------------------------- shared checks

async function readBytes(s, address, length) {
  const r = await s.client.call('read', { handle: s.handle, address, length });
  return r.bytes;
}

async function watchCounter(s, address, modulePrefix, waitMs) {
  const w = await E.watchStart(s, { address, size: 4, kind: 'write', durationMs: 5000 });
  await sleep(waitMs);
  const report = await w.stop();
  const hit = report.hits[0];
  check('watch_start on g_counter (write) reports a hit', report.hits.length >= 1, `${report.hits.length} site(s)`);
  if (hit) {
    info(`hit ${hit.address} ${hit.module} "${hit.text}" count=${hit.count}`);
    check(`watch hit module starts with ${modulePrefix}`, hit.module?.startsWith(modulePrefix) ?? false, String(hit.module));
  }
  return hit;
}

async function scanFindsCounter(s, address, value) {
  const first = await E.scanFirst(s, { type: 'int32', mode: 'range', min: String(value), max: String(value + 400) });
  const found = [];
  for (let off = 0; off < first.count && off < 100_000; off += 1000) {
    const page = await E.scanResults(s, first.scan, { offset: off, limit: 1000 });
    found.push(...page.results.map((r) => r.address));
  }
  await E.scanEnd(s, first.scan);
  check('value scan finds g_counter', found.includes(address), `${first.count} candidate(s)`);
}

// ----------------------------------------------------------------------------------- native

async function native() {
  const child = spawn(TARGET, ['--writer', '--heap-chain', '--clocks'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const a = {};
  await new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('target did not print its listing')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      for (const m of buf.matchAll(/^addr (\w+)=(0x[0-9a-f]+)$/gim)) a[m[1]] = m[2].toLowerCase();
      if (/^offset hp_in_stats=/m.test(buf)) { clearTimeout(timer); res(); }
    });
    child.once('exit', () => rej(new Error('target exited early')));
  });
  info(`target pid ${child.pid}`);
  try {
    const d = await startDaemon();
    let s = await E.attach(d.engine.client, child.pid);

    // Value scan: first scan 100, write a new value, next scan narrows to g_health.
    const first = await E.scanFirst(s, { type: 'int32', mode: 'exact', value: '100' });
    await E.write(s, a.g_health, 'int32', 4242);
    const next = await E.scanNext(s, first.scan, { mode: 'exact', value: '4242' });
    const page = await E.scanResults(s, first.scan, { limit: 1000 });
    check('value scan 100 -> 4242 narrows to g_health',
      next.count < first.count && page.results.some((r) => r.address === a.g_health && r.value === '4242'),
      `${first.count} -> ${next.count}`);
    await E.write(s, a.g_health, 'int32', 100);
    await E.scanEnd(s, first.scan);

    // Pointer scan: g_root -> [+0x18] -> [+0x10] reaches heap_value.
    const ps = await E.pointerScan(s, { address: a.heap_value });
    const { paths } = await E.pointerResults(s, ps.id, { limit: 1000 });
    const known = paths.find((p) => p.module === 'target' && p.offsets.join() === '0x18,0x10');
    check('pointer scan finds target -> +0x18 -> +0x10',
      !!known && (await E.resolvePointerChain(s, known)) === a.heap_value, `${ps.count} path(s)`);
    await E.pointerEnd(s, ps.id);

    // Write watch on g_counter.
    const hit = await watchCounter(s, a.g_counter, 'target+0x', 500);
    const bump = BigInt(a.bump_counter);
    check('watch hit is inside bump_counter',
      !!hit?.address && BigInt(hit.address) >= bump && BigInt(hit.address) < bump + 64n, hit?.address ?? 'none');

    // Signature + AOB round trip.
    const sig = await E.makeSignature(s, hit.address);
    const matches = await E.aobScan(s, { module: sig.module, pattern: sig.pattern });
    check('signature is unique and aobScan finds it again',
      sig.unique && matches.length === 1 && matches[0] === hit.address, `${sig.pattern} in ${sig.module}`);

    // Alloc near + patch + revert.
    const mem = await E.alloc(s, { size: 4096, near: a.bump_counter });
    const dist = BigInt(mem) - bump;
    check('alloc near bump_counter is within +-2 GiB', (dist < 0n ? -dist : dist) < 0x7fff0000n, mem);
    const code = await E.assemble(s, { address: mem, source: 'mov eax,#7\nret' });
    const p1 = await E.patch(s, mem, code.bytes);
    check('patch into allocated memory reads back', (await readBytes(s, mem, code.bytes.length)) === code.bytes.toString('hex'),
      code.bytes.toString('hex'));
    await p1.revert();
    const [ins] = await E.disassemble(s, hit.address, 1);
    const orig = await readBytes(s, hit.address, ins.length);
    const nop = await E.patch(s, hit.address, Buffer.alloc(ins.length, 0x90));
    const c0 = await E.read(s, a.g_counter, 'int32');
    await sleep(300);
    const c1 = await E.read(s, a.g_counter, 'int32');
    await nop.revert();
    await sleep(300);
    const c2 = await E.read(s, a.g_counter, 'int32');
    check('NOP patch stops g_counter, revert restores bytes and it counts again',
      c1 === c0 && c2 > c1 && (await readBytes(s, hit.address, ins.length)) === orig, `${c0} ${c1} ${c2}`);

    // Speed 2.0 -> 0.5 -> 1.0 on libc clocks.
    const sites = [{ address: a.libc_clock_gettime, length: 16 }, { address: a.got_gettimeofday, length: 8 }];
    const before = (await E.readMany(s, sites)).map((b) => b?.toString('hex'));
    const clocks = [['clock_gettime', a.g_mono_ns, 1e6], ['gettimeofday', a.g_tod_us, 1e3], ['clock_wrapper', a.g_wrapped_ns, 1e6]];
    async function nativeRates(ms) {
      const sample = async () => ({ t: now(), v: (await E.readMany(s, clocks.map(([, ad]) => ({ address: ad, length: 8 })))).map((b) => b.readBigInt64LE(0)) });
      const x = await sample();
      await sleep(ms);
      const y = await sample();
      return clocks.map(([name, , div], i) => [name, Number(y.v[i] - x.v[i]) / div / (y.t - x.t)]);
    }
    for (const sp of [2.0, 0.5, 1.0]) {
      const st = await E.setSpeed(s, sp);
      if (sp === 2.0) for (const h of st.hooks) info(`hook ${h.name} ${h.address} ${h.status}${h.reason ? ` (${h.reason})` : ''}`);
      await sleep(200);
      const rates = await nativeRates(1500);
      check(`speed ${sp}: clock rates within 10%`, rates.every(([, r]) => near(r, sp)),
        rates.map(([n, r]) => `${n}=${r.toFixed(3)}`).join(' '));
    }
    const after10 = (await E.readMany(s, sites)).map((b) => b?.toString('hex'));
    info(`after speed 1.0: clock_gettime bytes ${after10[0] === before[0] ? 'original' : 'still hooked (pass-through)'}, ` +
      `gettimeofday GOT ${after10[1] === before[1] ? 'original' : 'still hooked (pass-through)'}`);
    await s.detach();
    s = await E.attach(d.engine.client, child.pid);
    const afterDetach = (await E.readMany(s, sites)).map((b) => b?.toString('hex'));
    check('detach restores libc clock_gettime bytes and the gettimeofday GOT slot',
      afterDetach[0] === before[0] && afterDetach[1] === before[1]);
    await s.detach();
  } finally {
    await stopDaemons();
    child.kill('SIGKILL');
  }
}

// ----------------------------------------------------------------------------------- proton

// Wine export -> final code address, the way the daemon follows forwarders and jmp thunks, so the
// original bytes can be snapshotted before any hook exists.
async function snapshotTargets(s) {
  const names = [
    ['ntdll.dll', 'RtlQueryPerformanceCounter'], ['ntdll.dll', 'NtQueryPerformanceCounter'],
    ['kernel32.dll', 'QueryPerformanceCounter'], ['kernel32.dll', 'GetTickCount'],
    ['kernel32.dll', 'GetTickCount64'], ['winmm.dll', 'timeGetTime'],
  ];
  const snap = new Map();
  for (const [mod, name] of names) {
    let addr;
    try { addr = await E.resolveSymbol(s, mod, name); } catch (e) { info(`resolve ${mod}!${name}: ${e.message}`); continue; }
    for (let hop = 0; hop < 4 && addr; hop++) {
      snap.set(addr, await readBytes(s, addr, 32));
      const ins = await E.disassemble(s, addr, 4);
      let next = null;
      for (const i of ins) {
        if (/^nop/i.test(i.text) || /^lea rsp,\[rsp\]$/i.test(i.text.replace(/\s/g, ''))) continue;
        if (/^jmp/i.test(i.text) && i.target) {
          next = i.text.includes('[')
            ? hex((await E.readMany(s, [{ address: i.target.address, length: 8 }]))[0].readBigUInt64LE(0))
            : i.target.address;
        }
        break;
      }
      addr = next && next !== '0x0' ? next : null;
    }
  }
  return snap;
}

async function bytesMatch(s, snap, hooks) {
  const out = [];
  for (const h of hooks.filter((x) => x.status === 'hooked')) {
    const want = snap.get(h.address);
    if (!want) { out.push([h.name, 'no snapshot']); continue; }
    out.push([h.name, (await readBytes(s, h.address, 32)) === want ? 'original' : 'changed']);
  }
  return out;
}

// PR_SET_CHILD_SUBREAPER, run argv, reap every orphan until none is left.
const SUBREAPER = [
  'import ctypes, os, subprocess, sys',
  'ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)',
  'subprocess.Popen(sys.argv[1:])',
  'while True:',
  '    try: os.wait()',
  '    except ChildProcessError: break',
].join('\n');

// Wine runs the exe in-place in a process that may keep the name start.exe, so match the image.
function mapsImage(pid) {
  try { return readFileSync(`/proc/${pid}/maps`, 'utf8').includes('/clocks.exe'); } catch { return false; }
}

async function proton() {
  const protonBin = join(PROTON_DIR, 'proton');
  if (!existsSync(protonBin) || !existsSync(CLOCKS)) throw new Error(`need ${protonBin} and ${CLOCKS}`);
  const tmp = mkdtempSync(join(tmpdir(), 'starlight-live-m2-pfx-'));
  const pfx = join(tmp, 'pfx');
  mkdirSync(pfx);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('STEAM_COMPAT_') || k.startsWith('WINE') || k.startsWith('PROTON_')) delete env[k];
  env.STEAM_COMPAT_DATA_PATH = pfx;
  env.STEAM_COMPAT_CLIENT_INSTALL_PATH = join(homedir(), '.steam/steam');
  info(`throwaway prefix ${pfx}`);

  const lines = [];
  let counterAddr = null;
  // `runinprefix`, not `run`: `run` starts Proton's steam.exe launcher, which waits for a Steam
  // client session that a bare test program doesn't have (it never starts clocks.exe).
  // Wine double-forks new processes (and wineserver daemonizes), so they'd leave our process
  // tree. A child-subreaper wrapper keeps them as its descendants, so the ppid walk finds them.
  const child = spawn('python3', ['-I', '-c', SUBREAPER, protonBin, 'runinprefix', CLOCKS], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const owned = new Map(); // pid -> starttime, every descendant we have seen
  const track = () => {
    for (const p of [child.pid, ...descendants([child.pid, ...owned.keys()])]) {
      const st = statOf(p);
      if (st && !owned.has(p)) owned.set(p, st.start);
    }
  };
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-20000); });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const a = line.match(/^addr g_counter=(?:0x)?([0-9a-fA-F]+)$/);
      if (a) counterAddr = hex('0x' + a[1]);
      const t = line.match(/^t qpc_ms=(-?\d+) tick=(-?\d+) tick64=(-?\d+) tgt=(-?\d+)$/);
      if (t) lines.push({ wall: now(), v: t.slice(1).map(Number) });
    }
  });

  const rates = (from, to) => {
    const w = lines.filter((l) => l.wall >= from && l.wall <= to);
    if (w.length < 3) return null;
    const [x, y] = [w[0], w[w.length - 1]];
    return ['qpc', 'tick', 'tick64', 'tgt'].map((n, i) => [n, (y.v[i] - x.v[i]) / (y.wall - x.wall)]);
  };
  const fmt = (r) => r ? r.map(([n, v]) => `${n}=${v.toFixed(3)}`).join(' ') : 'no lines';
  async function measure(ms) { const t0 = now(); await sleep(ms); return rates(t0, now()); }

  let pid = 0;
  try {
    const deadline = now() + 240_000;
    while ((!counterAddr || lines.length < 2 || !pid) && now() < deadline) {
      track();
      pid = [...owned.keys()].find((p) => statOf(p)?.comm === 'clocks.exe' || mapsImage(p)) ?? 0;
      if (child.exitCode !== null) throw new Error(`proton exited (${child.exitCode}) before clocks.exe ran`);
      await sleep(250);
    }
    if (!pid || !counterAddr) {
      throw new Error(`clocks.exe did not start within 240 s (pid ${pid}, g_counter ${counterAddr}, ${lines.length} lines; own: ${[...owned.keys()].map((p) => `${p}:${statOf(p)?.comm}`).join(' ')})`);
    }
    info(`clocks.exe pid ${pid} comm ${statOf(pid)?.comm} (descendant of proton pid ${child.pid}), g_counter ${counterAddr}`);

    // ---- Step 3
    const d1 = await startDaemon();
    let s = await E.attach(d1.engine.client, pid);
    const mods = await E.listModules(s);
    info(`PE modules: ${mods.filter((m) => m.kind === 'pe').map((m) => m.name).join(', ')}`);
    const snap = await snapshotTargets(s);

    const g = await E.getSpeed(s);
    check('speed_get before any change is 1.0', g.speed === 1, JSON.stringify(g));
    const st = await E.setSpeed(s, 2.0);
    for (const h of st.hooks) info(`hook ${h.name} ${h.address} ${h.status}${h.reason ? ` (${h.reason})` : ''}`);
    const hooked = (re) => st.hooks.some((h) => re.test(h.name) && h.status === 'hooked');
    check('RtlQueryPerformanceCounter (or its forwarder) hooked', hooked(/QueryPerformanceCounter/));
    check('GetTickCount64 hooked', hooked(/^GetTickCount64$/));
    await sleep(300);
    let r = await measure(2000);
    check('speed 2.0: all four rates within 10% of 2.0', !!r && r.every(([, v]) => near(v, 2)), fmt(r));
    check('speed 2.0: no clock double-scaled (~4.0)', !!r && r.every(([, v]) => !near(v, 4)), fmt(r));

    await E.setSpeed(s, 1.0);
    const at10 = await bytesMatch(s, snap, st.hooks);
    info(`after speed 1.0: ${at10.map(([n, b]) => `${n}=${b}`).join(' ')}`);
    await sleep(300);
    r = await measure(2000);
    check('speed 1.0: rates back to 1.0', !!r && r.every(([, v]) => near(v, 1)), fmt(r));

    await watchCounter(s, counterAddr, 'clocks.exe+0x', 1000);
    await scanFindsCounter(s, counterAddr, await E.read(s, counterAddr, 'int32'));

    await s.detach();
    s = await E.attach(d1.engine.client, pid);
    const afterDetach = await bytesMatch(s, snap, st.hooks);
    check('detach restores every hooked function', afterDetach.every(([, b]) => b === 'original'),
      afterDetach.map(([n, b]) => `${n}=${b}`).join(' '));

    // ---- Step 4a: stdin close with speed 2.0
    await E.setSpeed(s, 2.0);
    await sleep(300);
    r = await measure(1500);
    check('speed 2.0 again before stdin close', !!r && r.every(([, v]) => near(v, 2)), fmt(r));
    const t0 = now();
    await d1.engine.stop(); // closes stdin; startEngine SIGKILLs only after 2 s
    const exitMs = now() - t0;
    daemons.splice(daemons.indexOf(d1), 1);
    rmSync(d1.dir, { recursive: true, force: true });
    check('daemon exits on stdin close within 3 s (by itself, before the 2 s SIGKILL fallback)', exitMs < 1900, `${exitMs.toFixed(0)} ms`);
    await sleep(300);
    r = await measure(2000);
    check('after stdin close: rates back to 1.0', !!r && r.every(([, v]) => near(v, 1)), fmt(r));
    check('clocks.exe still running', alive(pid) && lines[lines.length - 1].wall > now() - 1000);

    // ---- Step 4b: SIGKILL (D12)
    const d2 = await startDaemon();
    s = await E.attach(d2.engine.client, pid);
    const stdinCloseBytes = await bytesMatch(s, snap, st.hooks);
    check('stdin close restored every hooked function', stdinCloseBytes.every(([, b]) => b === 'original'),
      stdinCloseBytes.map(([n, b]) => `${n}=${b}`).join(' '));
    await E.setSpeed(s, 2.0);
    await sleep(300);
    process.kill(d2.pid, 'SIGKILL');
    await Promise.race([d2.engine.stop().catch(() => {}), sleep(3000)]);
    daemons.splice(daemons.indexOf(d2), 1);
    rmSync(d2.dir, { recursive: true, force: true });
    await sleep(300);
    r = await measure(2000);
    check('after daemon SIGKILL: rates stay at 2.0 (D12)', !!r && r.every(([, v]) => near(v, 2)), fmt(r));
    check('clocks.exe survives the daemon SIGKILL', alive(pid));

    const d3 = await startDaemon();
    s = await E.attach(d3.engine.client, pid);
    const orphan = await bytesMatch(s, snap, st.hooks);
    info(`orphaned hooks before recovery: ${orphan.map(([n, b]) => `${n}=${b}`).join(' ')}`);
    const rec = await E.getSpeed(s);
    check('fresh daemon speed_get reports 1.0', rec.speed === 1, JSON.stringify(rec));
    const recovered = await bytesMatch(s, snap, st.hooks);
    check('speed_get recovers the orphaned hooks (bytes restored)', recovered.every(([, b]) => b === 'original'),
      recovered.map(([n, b]) => `${n}=${b}`).join(' '));
    await sleep(300);
    r = await measure(2000);
    check('after recovery: rates back to 1.0', !!r && r.every(([, v]) => near(v, 1)), fmt(r));
    await s.detach();
  } catch (e) {
    writeFileSync(join(ROOT, '.superpowers/live-m2-proton-stderr.log'), stderr);
    throw e;
  } finally {
    await stopDaemons();
    track();
    // Kill only pids we saw as our descendants (pid + start time guard against reuse).
    for (const [p, start] of owned) if (statOf(p)?.start === start) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    // Then stop our own prefix's wineserver (it daemonizes, so it isn't a descendant).
    const ws = spawnSync(join(PROTON_DIR, 'files/bin/wineserver'), ['-k'], {
      env: { ...env, WINEPREFIX: join(pfx, 'pfx') }, timeout: 15000, stdio: 'ignore',
    });
    info(`wineserver -k (own prefix) exit ${ws.status}`);
    await sleep(500);
    const left = [...owned].filter(([p, start]) => statOf(p)?.start === start && statOf(p)?.comm !== undefined);
    info(`own processes left: ${left.length ? left.map(([p]) => `${p}:${statOf(p)?.comm}`).join(', ') : 'none'}`);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------- main

const mode = process.argv[2];
if (mode !== 'native' && mode !== 'proton') {
  console.error('usage: node scripts/live-m2.mjs native|proton');
  process.exit(2);
}
try {
  await (mode === 'native' ? native() : proton());
} catch (e) {
  failures++;
  console.log(`FAIL ${mode}: ${e.stack ?? e}`);
}
console.log(failures ? `${failures} check(s) failed` : 'all checks ok');
process.exit(failures ? 1 : 0);
