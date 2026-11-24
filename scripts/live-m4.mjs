#!/usr/bin/env node
// Live verification for native engine milestone 4 (the native .CT runner).
//
//   node scripts/live-m4.mjs native   # the C test target, spawned here
//   node scripts/live-m4.mjs proton   # gold.exe under Proton, throwaway prefix and client dir
//
// Needs the Step 1 builds: `cargo build --release` and `cargo build` in packages/starlightd,
// `pnpm --filter @starlight/ct-importer build`, `pnpm --filter @starlight/engine build`,
// `pnpm --filter ./apps/desktop build`, `make -C packages/engine/test-target` and
// `make -C packages/engine/test-target/win`. PROTON overrides the Proton directory.
//
// The CTs are written at run time from the built binaries: the debug daemon (its own process,
// attached to our own target, detached again before the app starts) gives the injection site's
// signature and the instructions the jump displaces. A localhost HTTP server serves them to the
// app as direct .CT links.
//
// The dev app runs with a temporary XDG_CONFIG_HOME, on a private D-Bus session (a stub owns
// org.freedesktop.Notifications, so nothing reaches the desktop) and under `cage` with the
// headless wlroots backend (no window is shown). It is driven over CDP on port 9223.
//
// Safety (as live-m3.mjs): only processes this script starts are touched (pid + start time).
// Every tree runs under a child-subreaper wrapper so daemonized children (wine, wineserver, dbus
// services) stay its descendants. Proton runs only through `proton runinprefix` with a fresh temp
// STEAM_COMPAT_DATA_PATH and STEAM_COMPAT_CLIENT_INSTALL_PATH; cleanup kills only our own pids and
// stops only our own prefix's wineserver (`wineserver -k` with that prefix's WINEPREFIX).
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync,
  writeFileSync, writeSync, chmodSync, appendFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PY_DESCENDANTS, statOf, trackOwned } from './live-procs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const E = await import(join(ROOT, 'packages/engine/dist/index.js'));
const C = await import(join(ROOT, 'packages/ct-importer/dist/index.js'));
/** The debug daemon reads the built binaries to write the CTs; the app runs the release one. */
const DEBUG_DAEMON = join(ROOT, 'packages/starlightd/target/debug/starlightd');
const TARGET = join(ROOT, 'packages/engine/test-target/build/target');
const GOLD = join(ROOT, 'packages/engine/test-target/win/build/gold.exe');
const PROTON_DIR = process.env.PROTON ?? join(homedir(), '.steam/steam/steamapps/common/Proton 11.0');
const REAL_RUNTIME = join(homedir(), '.config/@starlight/desktop/runtime');
const CDP_PORT = 9223;
const LOG_DIR = join(ROOT, '.superpowers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + BigInt(n).toString(16);
const now = () => Number(process.hrtime.bigint()) / 1e6;

let failures = 0;
let skipped = 0;
const results = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  results.push({ name, status: ok ? 'ok' : 'FAIL', detail });
  if (ok) console.log(`ok   ${name}${detail ? ` (${detail})` : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
  return ok;
}
function skip(name, reason) {
  skipped++;
  results.push({ name, status: 'SKIPPED', detail: reason });
  console.log(`SKIP ${name}: ${reason}`);
}
const info = (msg) => console.log(`     ${msg}`);

async function waitFor(fn, ms, every = 200) {
  const end = now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (now() > end) return v;
    await sleep(every);
  }
}

// ------------------------------------------------------------- own processes (pid + start time)

// Signals only a process we recorded, and only while it is still that process.
function killOwn(pid, start, sig = 'SIGKILL') {
  if (!pid || start === undefined || statOf(pid)?.start !== start) return false;
  try { process.kill(pid, sig); return true; } catch { return false; }
}
/** Mount points under `dir` (from our own mount table). */
function mountsUnder(dir) {
  return readFileSync('/proc/self/mounts', 'utf8').split('\n')
    .map((l) => l.split(' ')[1]?.replace(/\\040/g, ' ')).filter((mp) => mp && mp.startsWith(dir + '/'));
}
/** Unmounts what is mounted under a temp dir, then removes it; if anything stays mounted, the dir is kept. */
function removeTmp(dir) {
  for (const mp of mountsUnder(dir)) {
    const r = spawnSync('fusermount3', ['-uz', mp], { stdio: 'ignore' });
    if (r.status !== 0) spawnSync('fusermount', ['-uz', mp], { stdio: 'ignore' });
    info(`unmounted ${mp}`);
  }
  const left = mountsUnder(dir);
  if (left.length) {
    failures++;
    results.push({ name: 'temp dir unmounted before removal', status: 'FAIL', detail: left.join(', ') });
    console.log(`FAIL still mounted, NOT removing ${dir}: ${left.join(', ')}`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid, start) => { const st = statOf(pid); return !!st && st.state !== 'Z' && (start === undefined || st.start === start); };

/** Every tree we started: { name, owned: Map<pid,start>, root, rootStart }. */
const trees = [];
const cleanups = [];
let cleanedUp = false;
function cleanupSync() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const f of cleanups.splice(0).reverse()) {
    try { f(); } catch (e) { console.log(`     cleanup error: ${e.message}`); }
  }
  // Last sweep: nothing we started may be left.
  const left = [];
  for (const t of trees) {
    if (t.track) t.track(); else trackOwned(t.owned);
    for (const [p, start] of t.owned) if (alive(p, start)) left.push(`${p}:${statOf(p)?.comm}`);
  }
  console.log(`     tracked (children-list walk from our roots): ${trees.map((t) => `${t.name}: ${t.peak ?? t.owned.size} pids at most`).join(', ')}`);
  console.log(`     own processes left after cleanup: ${left.length ? left.join(', ') : 'none'}`);
  if (left.length) { failures++; results.push({ name: 'cleanup leaves no own process', status: 'FAIL', detail: left.join(', ') }); }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { console.log(`FAIL interrupted by ${sig}`); cleanupSync(); process.exit(130); });
}
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => { console.log(`FAIL ${ev}: ${e?.stack ?? e}`); cleanupSync(); process.exit(1); });
}

// PR_SET_CHILD_SUBREAPER, run argv, reap every orphan until none is left. PR_SET_PDEATHSIG: if this
// script dies (even by SIGKILL), the wrapper gets SIGUSR1 and SIGKILLs its own descendants (found by
// walking its own children lists, so nothing else), then exits.
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
if os.getppid() != int(os.environ.get('LIVE_M4_PARENT', os.getppid())): on_parent_death()
subprocess.Popen(sys.argv[1:])
while True:
    try: os.wait()
    except ChildProcessError: break
`;

/** Spawns argv under a subreaper and tracks the whole tree. */
function spawnTree(name, argv, opts) {
  const child = spawn('python3', ['-I', '-c', SUBREAPER, ...argv], { ...opts, env: { ...(opts.env ?? process.env), LIVE_M4_PARENT: String(process.pid) } });
  const rootStart = child.pid ? statOf(child.pid)?.start : undefined;
  const owned = new Map();
  if (rootStart !== undefined) owned.set(child.pid, rootStart);
  const t = { name, child, owned, root: child.pid, rootStart, peak: owned.size };
  t.track = () => { trackOwned(owned); t.peak = Math.max(t.peak, owned.size); };
  trees.push(t);
  return t;
}
/** Kills a tree: stop the root (no reparenting), kill descendants, then the root. */
function killTree(t, extra = () => {}) {
  killOwn(t.root, t.rootStart, 'SIGSTOP');
  t.track();
  for (const [p, start] of t.owned) if (p !== t.root) killOwn(p, start);
  extra();
  sleepSync(300);
  t.track();
  for (const [p, start] of t.owned) if (p !== t.root) killOwn(p, start);
  killOwn(t.root, t.rootStart, 'SIGCONT');
  killOwn(t.root, t.rootStart);
  sleepSync(200);
}

// ------------------------------------------------------------------- /proc memory of our targets

function memRead(pid, address, length) {
  const fd = openSync(`/proc/${pid}/mem`, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, Number(BigInt(address)));
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}
function memWrite(pid, address, buf) {
  const fd = openSync(`/proc/${pid}/mem`, 'r+');
  try { writeSync(fd, buf, 0, buf.length, Number(BigInt(address))); } finally { closeSync(fd); }
}
const readI32 = (pid, a) => memRead(pid, a, 4).readInt32LE(0);
const readU64 = (pid, a) => memRead(pid, a, 8).readBigUInt64LE(0);
function writeI32(pid, a, v) { const b = Buffer.alloc(4); b.writeInt32LE(v); memWrite(pid, a, b); }
function tracerPid(pid) {
  try { return Number(/TracerPid:\s*(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? -1); } catch { return -1; }
}
/** Base of a module in our own target (first mapping whose file basename is `module`). */
function moduleBase(pid, module) {
  for (const line of readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n')) {
    const m = /^([0-9a-f]+)-[0-9a-f]+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+(.*)$/.exec(line.trim());
    if (m && m[3] && basename(m[3]).toLowerCase() === module.toLowerCase()) return BigInt('0x' + m[1]) - BigInt('0x' + m[2]);
  }
  return null;
}
// ------------------------------------------------------------------------------- native targets

/** Spawns the C test target and reads its address listing. */
async function spawnTarget(args) {
  const t = spawnTree(`target ${args.join(' ')}`, [TARGET, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const a = {};
  await new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('target did not print its listing')), 5000);
    t.child.stdout.setEncoding('utf8');
    t.child.stdout.on('data', (c) => {
      buf += c;
      for (const m of buf.matchAll(/^addr (\w+)=(0x[0-9a-f]+)$/gim)) a[m[1]] = m[2].toLowerCase();
      if (/^offset hp_in_stats=/m.test(buf)) { clearTimeout(timer); res(); }
    });
    t.child.once('exit', () => rej(new Error('target exited early')));
    t.child.once('error', rej);
  });
  // The target itself is the subreaper's child.
  await waitFor(() => { t.track(); return [...t.owned.keys()].some((p) => p !== t.root && statOf(p)?.comm === 'target'); }, 3000, 50);
  const pid = [...t.owned.keys()].find((p) => p !== t.root && statOf(p)?.comm === 'target');
  const target = { tree: t, pid, start: t.owned.get(pid), a };
  cleanups.push(() => killTree(t));
  return target;
}
function stopTarget(tg) { killTree(tg.tree); }

// ----------------------------------------------------------------------------------- CDP driver

async function portBusy(port) {
  return new Promise((r) => {
    const s = netConnect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); r(true); });
    s.once('error', () => r(false));
  });
}

async function cdpConnect(port) {
  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? null;
    } catch { return null; }
  }, 60_000, 300);
  if (!target) throw new Error('the app never opened its page on the CDP port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('CDP websocket failed')); });
  let id = 0;
  const pending = new Map();
  const dialogs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      dialogs.push(msg.params.message);
      info(`app dialog (auto-accepted): ${msg.params.message.split('\n')[0]}`);
      void send('Page.handleJavaScriptDialog', { accept: true });
    }
  };
  function send(method, params = {}) {
    return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  }
  await send('Page.enable');
  await send('Runtime.enable');
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${DOM_HELPERS}; ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  return { evaluate, dialogs, close: () => { try { ws.close(); } catch { /* gone */ } } };
}

// In-page helpers: find buttons by aria-label or leading text, inside an optional scope selector.
const DOM_HELPERS = `
  const $scope = (sel) => sel ? document.querySelector(sel) : document;
  const $button = (text, sel) => { const s = $scope(sel); if (!s) return null;
    return [...s.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === text || b.textContent.trim().startsWith(text)) ?? null; };
  const $click = (text, sel) => { const b = $button(text, sel); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; };
  const $text = (sel) => $scope(sel)?.innerText ?? null;
  const $type = (input, value) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
`;

// ------------------------------------------------------------------------------------- the app

// A do-nothing org.freedesktop.Notifications server for the private bus (Gio). argv[1]: ready file.
const NOTIFY_STUB = `
import sys
from gi.repository import Gio, GLib
XML = '''<node><interface name="org.freedesktop.Notifications">
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/>
<arg type="i" direction="in"/><arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
</interface></node>'''
node = Gio.DBusNodeInfo.new_for_xml(XML)
counter = [0]
def call(conn, sender, path, iface, method, params, inv):
    if method == 'Notify':
        counter[0] += 1
        inv.return_value(GLib.Variant('(u)', (counter[0],)))
    elif method == 'GetCapabilities':
        inv.return_value(GLib.Variant('(as)', (['body'],)))
    elif method == 'GetServerInformation':
        inv.return_value(GLib.Variant('(ssss)', ('live-m4-stub', 'starlight', '1', '1.2')))
    else:
        inv.return_value(None)
def acquired(conn, name):
    open(sys.argv[1], 'w').close()
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
bus.register_object('/org/freedesktop/Notifications', node.interfaces[0], call, None, None)
Gio.bus_own_name_on_connection(bus, 'org.freedesktop.Notifications', Gio.BusNameOwnerFlags.NONE, acquired, None)
GLib.MainLoop().run()
`;

/** Starts the dev app (temp config, private bus, headless cage) and connects CDP. */
async function startApp(label) {
  if (await portBusy(CDP_PORT)) {
    info(`waiting for port ${CDP_PORT} to be free`);
    if (!(await waitFor(async () => !(await portBusy(CDP_PORT)), 60_000, 500))) throw new Error(`port ${CDP_PORT} stays busy`);
  }
  const tmp = mkdtempSync(join(tmpdir(), `starlight-live-m4-${label}-`));
  const cfg = join(tmp, 'config');
  const rt = join(tmp, 'runtime-dir');
  mkdirSync(join(cfg, '@starlight/desktop'), { recursive: true });
  mkdirSync(rt, { mode: 0o700 });
  if (existsSync(REAL_RUNTIME)) {
    // A copy of the installed CE runtime, so the background install has nothing to download.
    cpSync(REAL_RUNTIME, join(cfg, '@starlight/desktop/runtime'), { recursive: true, verbatimSymlinks: true });
  }
  const notifyLog = join(tmp, 'notify.log');
  const appLog = join(tmp, 'app.log');
  const wrap = join(tmp, 'wrap.sh');
  const stub = join(tmp, 'notify-stub.py');
  const stubReady = join(tmp, 'notify-stub.ready');
  writeFileSync(stub, NOTIFY_STUB);
  writeFileSync(wrap, [
    '#!/bin/bash',
    `dbus-monitor "interface='org.freedesktop.Notifications'" > '${notifyLog}' 2>&1 &`,
    // A private bus has no notification server; libnotify then never sends Notify. The stub owns the
    // name (before the desktop's activatable one can be started) and only answers; it shows nothing.
    `python3 -I '${stub}' '${stubReady}' &`,
    `for i in $(seq 1 50); do [ -e '${stubReady}' ] && break; sleep 0.1; done`,
    `cd '${DESKTOP}'`,
    `WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 exec cage -- ./node_modules/.bin/electron . --remote-debugging-port=${CDP_PORT}`,
    '',
  ].join('\n'));
  chmodSync(wrap, 0o755);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY)$/.test(k) || /^(STEAM_COMPAT_|WINE|PROTON_|CLAUDE)/.test(k)) delete env[k];
  }
  env.XDG_CONFIG_HOME = cfg;
  env.XDG_RUNTIME_DIR = rt;
  const t = spawnTree('app', ['dbus-run-session', '--', wrap], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logStream = (c) => { try { appendFileSync(appLog, c); } catch { /* tmp gone */ } };
  t.child.stdout.on('data', logStream);
  t.child.stderr.on('data', logStream);
  const app = { tree: t, tmp, cfg, notifyLog, appLog, label, cdp: null, quitted: false };
  cleanups.push(() => {
    if (!app.quitted) killTree(t);
    try { cpSync(appLog, join(LOG_DIR, `live-m4-${label}-app.log`)); } catch { /* no log */ }
    try { cpSync(notifyLog, join(LOG_DIR, `live-m4-${label}-notify.log`)); } catch { /* no log */ }
    // dbus may have activated xdg-document-portal, which FUSE-mounts <XDG_RUNTIME_DIR>/doc.
    removeTmp(tmp);
  });
  app.cdp = await cdpConnect(CDP_PORT);
  // Wait for the bridge, then make sure nothing auto-attaches and cheat hotkeys stay off.
  await waitFor(() => app.cdp.evaluate('return !!window.starlight'), 20_000, 200);
  await app.cdp.evaluate(`await window.starlight.updateConfig({ patch: { preferences: { autoAttachOnDetect: false, cheatHotkeys: false } } }); return true;`);
  info(`app started (temp config ${cfg})`);
  return app;
}

/** Cheat Engine processes in the app's own tree. */
function ceProcs(app) {
  app.tree.track();
  return [...app.tree.owned].filter(([p, st]) => alive(p, st) && /cheatengine|ceserver/i.test(statOf(p)?.comm ?? '')).map(([p]) => `${p}:${statOf(p)?.comm}`);
}

const S = (app, call) => app.cdp.evaluate(`return await window.starlight.${call};`);

/** Quits through the window (before-quit runs), waits for the whole tree to exit. */
async function quitApp(app) {
  const t0 = now();
  await app.cdp.evaluate('window.starlight.windowClose(); return true;').catch(() => {});
  app.cdp.close();
  const t = app.tree;
  const gone = await waitFor(() => { t.track(); return ![...t.owned].some(([p, s]) => p !== t.root && alive(p, s)); }, 20_000, 200);
  info(`app tree exited ${gone ? 'by itself' : 'NOT by itself (killed)'} in ${(now() - t0).toFixed(0)} ms`);
  if (!gone) killTree(t);
  app.quitted = true;
  return !!gone;
}

// ------------------------------------------------------------- the debug daemon (CT authoring)

/** Starts the debug daemon as our own process, tracked like every other tree. */
async function startHelperDaemon() {
  if (!existsSync(DEBUG_DAEMON)) throw new Error(`need ${DEBUG_DAEMON} (cargo build in packages/starlightd)`);
  const dir = mkdtempSync(join(tmpdir(), 'starlight-live-m4-sock-'));
  const engine = await E.startEngine({ binary: DEBUG_DAEMON, socketPath: join(dir, 'sock') });
  const start = statOf(engine.pid)?.start;
  trees.push({ name: 'debug daemon', owned: new Map(start !== undefined ? [[engine.pid, start]] : []), peak: start !== undefined ? 1 : 0 });
  const d = { engine, pid: engine.pid, start, stopped: false };
  d.stop = async () => {
    if (d.stopped) return;
    d.stopped = true;
    await Promise.race([engine.stop().catch(() => {}), sleep(4000)]);
    killOwn(d.pid, d.start);
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(() => { killOwn(d.pid, d.start); rmSync(dir, { recursive: true, force: true }); });
  return d;
}

/**
 * The instructions a 5-byte `jmp newmem` at `site` displaces, from the daemon's disassembly.
 * Returns their CE-style text, the original bytes and how many nops pad the jump.
 */
async function displaced(s, site) {
  const ins = await E.disassemble(s, site, 6);
  const out = [];
  let len = 0;
  for (const i of ins) {
    if (len >= 5) break;
    if (/^(ret|jmp|call|j[a-z]+)\b/i.test(i.text)) throw new Error(`can't displace "${i.text}" at ${i.address}`);
    out.push(i);
    len += i.length;
  }
  return {
    texts: out.map((i) => i.text),
    bytes: out.map((i) => i.bytes).join(''),
    nops: len - 5,
    listing: out.map((i) => `${i.symbol ?? i.address}: ${i.bytes} - ${i.text}`),
  };
}

// --------------------------------------------------------------------------------- CT authoring

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const spaced = (hexStr) => hexStr.toUpperCase().match(/../g).join(' ');
const noPrefix = (h) => BigInt(h).toString(16).toUpperCase();

function ctEntry({ id, name, body, children }) {
  return `<CheatEntry><ID>${id}</ID><Description>"${xmlEsc(name)}"</Description>${body}` +
    `${children?.length ? `<CheatEntries>${children.join('')}</CheatEntries>` : ''}</CheatEntry>`;
}
const aaEntry = (id, name, script, children) =>
  ctEntry({ id, name, body: `<VariableType>Auto Assembler Script</VariableType><AssemblerScript>${xmlEsc(script)}</AssemblerScript>`, children });
const ctFile = (entries) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<CheatTable CheatEngineTableVersion="45">\n<CheatEntries>\n${entries.join('\n')}\n</CheatEntries>\n</CheatTable>\n`;

/** The AOB injection template: the cave runs `pre`, the displaced instructions, `post`, then jumps back. */
function injectScript({ module, sig, d, pre = [], post = [], comment }) {
  return [
    `{ ${comment} }`,
    '[ENABLE]',
    `aobscanmodule(INJECT,${module},${sig})`,
    'alloc(newmem,$100,INJECT)',
    'label(return)',
    'registersymbol(INJECT)',
    '',
    'newmem:',
    ...pre.map((l) => `  ${l}`),
    ...d.texts.map((l) => `  ${l}`),
    ...post.map((l) => `  ${l}`),
    '  jmp return',
    '',
    'INJECT:',
    '  jmp newmem',
    ...(d.nops > 0 ? [`  nop ${d.nops}`] : []),
    'return:',
    '',
    '[DISABLE]',
    'INJECT:',
    `  db ${spaced(d.bytes)}`,
    'unregistersymbol(INJECT)',
    'dealloc(newmem)',
    '',
  ].join('\n');
}

/** target-aa.CT and target-lua.CT, from the target's addresses and the daemon's view of bump_counter. */
function targetTables(t) {
  const health = ctEntry({
    id: 2, name: 'Health',
    body: `<VariableType>4 Bytes</VariableType><Address>"target"+${noPrefix(t.healthOff)}</Address>` +
      '<DropDownList DisplayValueAsItem="1">64:Full\n1:Low\n</DropDownList>' +
      '<Hotkeys><Hotkey><Action>Toggle Activation</Action><Keys><Key>113</Key></Keys><ID>0</ID></Hotkey></Hotkeys>',
  });
  const player = ctEntry({ id: 1, name: 'Player', body: '<Options moHideChildren="1"/><GroupHeader>1</GroupHeader>', children: [health] });
  const counter = aaEntry(3, 'Counter ×100', injectScript({
    module: 'target', sig: t.sig, d: t.d, pre: [`add dword ptr [${noPrefix(t.counter)}],#99`],
    comment: 'adds 99 to g_counter before each bump (x100)',
  }));
  const expose = aaEntry(4, 'Expose counter', [
    '[ENABLE]',
    'globalalloc(pCounter,8)',
    'pCounter:',
    // The target is non-PIE, so g_counter's address is fixed. (Module-relative forms don't work in
    // AA operands for an extension-less module: bare `target+off` is sym:unresolved at compile time
    // and the assembler rejects the quoted `"target"+off` as a string outside db.)
    `  dq ${noPrefix(t.counter)}`,
    '[DISABLE]',
    '',
  ].join('\n'), [ctEntry({ id: 5, name: 'Counter (via pCounter)', body: '<VariableType>4 Bytes</VariableType><Address>[pCounter]</Address>' })]);
  const lua = aaEntry(6, 'Lua helper', [
    '[ENABLE]',
    '{$lua}',
    'print("hello from Lua")',
    '{$asm}',
    '[DISABLE]',
    '',
  ].join('\n'));
  return { aa: ctFile([player, counter, expose]), lua: ctFile([player, counter, expose, lua]) };
}

/**
 * gold.CT: earn() gets a cave that adds 99 more to [rax+10] after the original code. The module is
 * written GOLD.EXE (the game's module is gold.exe), so the session must resolve it case-insensitively.
 */
const GOLD_CT_MODULE = 'GOLD.EXE';
function goldTable(g) {
  return ctFile([aaEntry(1, 'Gold ×100', injectScript({
    module: GOLD_CT_MODULE, sig: g.sig, d: g.d, post: ['add dword ptr [rax+10],#99'],
    comment: 'earn(): gold += 1, plus 99',
  }))]);
}

/** Serves `files` (name -> text) on 127.0.0.1; resolves to a URL builder. */
async function serveTables(files) {
  const served = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    served.push(name);
    if (!(name in files)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(files[name]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  const port = server.address().port;
  return { url: (name) => `http://127.0.0.1:${port}/${name}`, served };
}

/** The app's [ct-runner] log lines. */
function routeLines(app) {
  try { return readFileSync(app.appLog, 'utf8').split('\n').filter((l) => l.includes('[ct-runner]')); } catch { return []; }
}

const rec = (r, id) => r.records?.find((x) => x.id === id);
const near = (v, want, tol) => Math.abs(v - want) <= want * tol;
/** CE processes in the app's tree, sampled a few times over `ms`. */
async function ceAppears(app, ms) {
  const seen = new Set();
  const end = now() + ms;
  while (now() < end) { for (const p of ceProcs(app)) seen.add(p); await sleep(150); }
  return [...seen];
}

// ----------------------------------------------------------------------------------- native mode

async function native() {
  const T = await spawnTarget(['--writer', '--heap-chain', '--clocks', '--abs-sleep']);
  const a = T.a;
  const base = moduleBase(T.pid, 'target');
  info(`target pid ${T.pid}, module base ${hex(base)}, g_health ${a.g_health}, g_counter ${a.g_counter}, bump_counter ${a.bump_counter}`);

  // Original bytes of every site a session may patch (the table's site and the speed hooks).
  const SITES = [
    ['bump_counter', a.bump_counter, 32], ['clock_gettime', a.libc_clock_gettime, 16], ['gettimeofday GOT', a.got_gettimeofday, 8],
    ['clock_wrapper', a.clock_wrapper, 16], ['clock_nanosleep', a.libc_clock_nanosleep, 16],
    ['pthread_cond_timedwait', a.libc_pthread_cond_timedwait, 16], ['pthread_cond_clockwait', a.libc_pthread_cond_clockwait, 16],
    ['sem_timedwait', a.libc_sem_timedwait, 16], ['sem_clockwait', a.libc_sem_clockwait, 16],
  ].filter(([, ad]) => ad && ad !== '0x0');
  const orig = new Map(SITES.map(([n, ad, len]) => [n, memRead(T.pid, ad, len).toString('hex')]));
  const siteState = () => SITES.map(([n, ad, len]) => [n, memRead(T.pid, ad, len).toString('hex') === orig.get(n) ? 'original' : 'changed']);

  // The injection site: bump_counter's load of g_counter, as the debug daemon sees it.
  const helper = await startHelperDaemon();
  let t;
  {
    const s = await E.attach(helper.engine.client, T.pid);
    const ins = await E.disassemble(s, a.bump_counter, 8);
    const load = ins.find((i) => i.target?.address === a.g_counter && /^mov e[a-z]+,\[/i.test(i.text));
    if (!load) throw new Error(`no load of g_counter in bump_counter: ${ins.map((i) => i.text).join('; ')}`);
    const sig = await E.makeSignature(s, load.address);
    const d = await displaced(s, load.address);
    await s.detach();
    t = { sig: sig.pattern, site: load.address, d, healthOff: BigInt(a.g_health) - base, counter: a.g_counter };
    info(`site ${load.symbol} (${load.address}), signature ${sig.pattern} (${sig.module}, ${sig.unique ? 'unique' : `${sig.matches} matches`})`);
    for (const l of d.listing) info(`displaced ${l}`);
  }
  await helper.stop();
  check('the debug daemon has detached before the app starts', tracerPid(T.pid) === 0, `TracerPid ${tracerPid(T.pid)}`);

  const tables = targetTables(t);
  const ctDir = join(LOG_DIR, 'live-m4-cts');
  mkdirSync(ctDir, { recursive: true });
  writeFileSync(join(ctDir, 'target-aa.CT'), tables.aa);
  writeFileSync(join(ctDir, 'target-lua.CT'), tables.lua);
  info(`CTs written to ${ctDir}`);
  const srv = await serveTables({ 'target-aa.CT': tables.aa, 'target-lua.CT': tables.lua });

  // ---- Routing
  const luaC = C.compileTable(tables.lua);
  const aaC = C.compileTable(tables.aa);
  check('compileTable(target-lua.CT) → native: false with lua:block',
    luaC.native === false && luaC.reasons.some((r) => r.code === 'lua:block'), luaC.reasons.map((r) => `${r.recordId}:${r.code}`).join(' '));
  check('compileTable(target-aa.CT) → native: true', aaC.native === true, aaC.reasons.map((r) => `${r.recordId}:${r.code} ${r.detail}`).join(' ') || 'no reasons');

  const app = await startApp('native');
  await S(app, `updateConfig({ patch: { manualGames: [{ id: 'live-m4-target', name: 'target', exePath: ${JSON.stringify(TARGET)}, addedAt: new Date().toISOString() }] } })`);

  const pvLua = await S(app, `ceSessionStart(${JSON.stringify({ source: srv.url('target-lua.CT'), cacheKey: 'live-m4-lua' })})`);
  const ceLua = await ceAppears(app, 2000);
  check('preview of target-lua.CT (no pid): route.engine ce, no Cheat Engine process',
    pvLua.ok && pvLua.attached === false && pvLua.route?.engine === 'ce' && ceLua.length === 0,
    `ok ${pvLua.ok}, attached ${pvLua.attached}, route ${JSON.stringify(pvLua.route?.engine)} first ${pvLua.route?.first?.code}, CE: ${ceLua.join(' ') || 'none'}${pvLua.error ? `, ${pvLua.error}` : ''}`);
  const pvAa = await S(app, `ceSessionStart(${JSON.stringify({ source: srv.url('target-aa.CT'), cacheKey: 'live-m4-aa' })})`);
  check('preview of target-aa.CT (no pid): route.engine native',
    pvAa.ok && pvAa.attached === false && pvAa.route?.engine === 'native', `ok ${pvAa.ok}, route ${JSON.stringify(pvAa.route)}${pvAa.error ? `, ${pvAa.error}` : ''}`);

  // ---- The native session
  const r = await S(app, `ceSessionStart(${JSON.stringify({ source: srv.url('target-aa.CT'), cacheKey: 'live-m4-aa', pid: T.pid })})`);
  const ceRun = await ceAppears(app, 1500);
  if (!r.ok) throw new Error(`ceSessionStart with the pid failed: ${r.error}`);
  const sid = r.sessionId;
  const hdr = rec(r, 1); const hp = rec(r, 2); const ctr = rec(r, 3); const exp = rec(r, 4); const via = rec(r, 5);
  const opts = JSON.stringify(hp?.options ?? null);
  check('ceSessionStart with the pid: mode native, attached, the record tree (header, nesting, dropdown, F2), no CE process',
    r.mode === 'native' && r.engine === 'starlightd' && r.attached === true && ceRun.length === 0 &&
    hdr?.kind === 'header' && hdr.depth === 0 && hp?.kind === 'value' && hp.depth === 1 && hp.hotkey === 'F2' &&
    opts === JSON.stringify([{ value: '64', label: 'Full' }, { value: '1', label: 'Low' }]) &&
    ctr?.kind === 'script' && ctr.depth === 0 && exp?.kind === 'script' && via?.kind === 'value' && via.depth === 1,
    `mode ${r.mode}, engine ${r.engine}, attached ${r.attached}, CE: ${ceRun.join(' ') || 'none'}; ` +
    r.records.map((x) => `${x.id}:${x.kind}@${x.depth}${x.hotkey ? ` ${x.hotkey}` : ''}${x.options ? ` [${x.options.map((o) => `${o.value}:${o.label}`).join(',')}]` : ''}${x.value !== undefined ? ` =${x.value}` : ''}`).join(' | '));

  const setActive = (id, on) => S(app, `ceSessionSetActive(${JSON.stringify({ sessionId: sid, recordId: id, active: on })})`);
  const call = (method, params) => S(app, `ceSessionCall(${JSON.stringify({ sessionId: sid, method, ...(params ? { params } : {}) })})`);
  const counterRate = async (ms) => {
    const t0 = now(); const c0 = readI32(T.pid, a.g_counter);
    await sleep(ms);
    return (readI32(T.pid, a.g_counter) - c0) / ((now() - t0) / 1000);
  };

  // ---- Counter ×100
  const baseRate = await counterRate(1500);
  const on3 = await setActive(3, true);
  await sleep(200);
  const onRate = await counterRate(1500);
  check('Counter ×100 on: g_counter grows ≥ 50× faster', on3.ok && onRate >= 50 * baseRate && baseRate > 0,
    `${on3.error ?? ''} ${baseRate.toFixed(1)}/s → ${onRate.toFixed(1)}/s (×${(onRate / baseRate).toFixed(1)})`);
  const off3 = await setActive(3, false);
  const bytesBack = memRead(T.pid, a.bump_counter, 32).toString('hex') === orig.get('bump_counter');
  await sleep(200);
  const offRate = await counterRate(1500);
  check('Counter ×100 off: the site bytes are the originals and the rate is back to normal (±25%)',
    off3.ok && bytesBack && near(offRate, baseRate, 0.25), `${off3.error ?? ''} bytes ${bytesBack ? 'original' : 'changed'}, ${offRate.toFixed(1)}/s vs ${baseRate.toFixed(1)}/s`);

  // ---- Expose counter
  const on4 = await setActive(4, true);
  const c0 = readI32(T.pid, a.g_counter);
  const rf = await call('refresh');
  const c1 = readI32(T.pid, a.g_counter);
  const v5 = rf.states?.find((x) => x.id === 5)?.v;
  check('Expose counter on: [pCounter] shows g_counter (within the tick)', on4.ok && Number(v5) >= c0 && Number(v5) <= c1,
    `${on4.error ?? ''} [pCounter] = ${v5}, g_counter ${c0}..${c1}`);
  const off4 = await setActive(4, false);
  const rf2 = await call('refresh');
  const v5off = rf2.states?.find((x) => x.id === 5)?.v;
  check('Expose counter off: [pCounter] shows ??', off4.ok && v5off === '??', `${off4.error ?? ''} [pCounter] = ${v5off}`);

  // ---- Health: set_value, then freeze
  const sv = await call('set_value', { id: 2, value: '1' });
  await sleep(50);
  const h1 = readI32(T.pid, a.g_health);
  check('set_value on Health with 1 writes 1', sv.ok === true && h1 === 1, `${JSON.stringify(sv)}, g_health ${h1}`);
  const on2 = await setActive(2, true);
  await sleep(100);
  writeI32(T.pid, a.g_health, 5);
  const tw = now();
  const held = await waitFor(() => readI32(T.pid, a.g_health) === 1, 200, 5);
  const heldMs = now() - tw;
  check('Health on freezes it: a /proc write of 5 reads back 1 within 200 ms', on2.ok && !!held,
    `${on2.error ?? ''} ${held ? `back to 1 after ${heldMs.toFixed(0)} ms` : `still ${readI32(T.pid, a.g_health)}`}`);
  await setActive(2, false);
  writeI32(T.pid, a.g_health, 100);

  // ---- Speed through the session
  const clockRate = async (ms) => {
    const x = { mono: readU64(T.pid, a.g_mono_ns), raw: readU64(T.pid, a.g_mono_raw_ns), sl: readU64(T.pid, a.g_abs_sleeps), t: now() };
    await sleep(ms);
    const y = { mono: readU64(T.pid, a.g_mono_ns), raw: readU64(T.pid, a.g_mono_raw_ns), sl: readU64(T.pid, a.g_abs_sleeps), t: now() };
    return { clock: Number(y.mono - x.mono) / Number(y.raw - x.raw), sleeps: Number(y.sl - x.sl) / ((y.t - x.t) / 1000) };
  };
  const r1 = await clockRate(700);
  info(`speed 1.0 before: --clocks ${r1.clock.toFixed(3)}, g_abs_sleeps ${r1.sleeps.toFixed(1)}/s`);
  // Kept short so the game clock is < 1 s ahead when the session ends (D3 lands up to 1 s ahead).
  const sp2 = await call('set_speed', { speed: 2 });
  await sleep(100);
  const r2 = await clockRate(700);
  check('set_speed 2: --clocks rate 2.0 ±15%, g_abs_sleeps 100/s ±25%',
    sp2.ok === true && near(r2.clock, 2, 0.15) && near(r2.sleeps, 100, 0.25),
    `${JSON.stringify(sp2)}; clock ${r2.clock.toFixed(3)}, sleeps ${r2.sleeps.toFixed(1)}/s`);
  const sp1 = await call('set_speed', { speed: 1 });
  await sleep(200);
  const r3 = await clockRate(1500);
  check('set_speed 1: --clocks rate 1.0 ±10%', sp1.ok === true && near(r3.clock, 1, 0.10),
    `${JSON.stringify(sp1)}; clock ${r3.clock.toFixed(3)}, sleeps ${r3.sleeps.toFixed(1)}/s`);

  // ---- ceSessionEnd, with Counter ×100 on and the speed hooks still in (pass-through at 1.0, R24)
  await setActive(3, true);
  await sleep(200);
  info(`before ceSessionEnd: ${siteState().map(([n, st]) => `${n}=${st}`).join(' ')}, TracerPid ${tracerPid(T.pid)}`);
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) { samples.push(readU64(T.pid, a.g_mono_ns)); await sleep(5); }
  })();
  await sleep(200);
  const tEnd = now();
  const endP = S(app, `ceSessionEnd(${JSON.stringify({ sessionId: sid })})`);
  const restored = await waitFor(() => siteState().every(([, st]) => st === 'original') && tracerPid(T.pid) === 0, 2500, 10);
  const restoredMs = now() - tEnd;
  const end = await endP;
  await sleep(500);
  sampling = false;
  await sampler;
  let decreases = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i] < samples[i - 1]) decreases++;
  check('ceSessionEnd: within 2.5 s every patched site holds its original bytes and TracerPid is 0', end.ok && !!restored,
    `${restored ? `${restoredMs.toFixed(0)} ms` : 'not within 2.5 s'}: ${siteState().map(([n, st]) => `${n}=${st}`).join(' ')}, TracerPid ${tracerPid(T.pid)}`);
  check('the --clocks samples never decreased across the end', samples.length > 50 && decreases === 0, `${samples.length} samples, ${decreases} decrease(s)`);
  const after = await counterRate(1000);
  info(`after the end: g_counter ${after.toFixed(1)}/s`);

  const routing = (() => { try { return JSON.parse(readFileSync(join(app.cfg, '@starlight/desktop/ct-routing.json'), 'utf8')); } catch (e) { return { error: e.message }; } })();
  check('ct-routing.json counts one native table and one CE table', routing.tables?.native === 1 && routing.tables?.ce === 1,
    JSON.stringify({ tables: routing.tables, records: routing.records, reasons: routing.reasons, seen: routing.seen?.length, error: routing.error }));
  for (const l of routeLines(app)) info(`app: ${l.trim()}`);
  info(`CT server served: ${srv.served.join(', ')}`);
  await quitApp(app);
}

// ----------------------------------------------------------------------------------- proton mode

/** Proton's environment: our throwaway prefix and client dir, no display or session bus (R17, R18). */
function protonEnv(pfx, client) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(STEAM_COMPAT_|WINE|PROTON_)/.test(k) || /^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY)$/.test(k)) delete env[k];
  }
  env.STEAM_COMPAT_DATA_PATH = pfx;
  env.STEAM_COMPAT_CLIENT_INSTALL_PATH = client;
  return env;
}
function mapsImage(pid, image) {
  try { return readFileSync(`/proc/${pid}/maps`, 'utf8').includes(`/${image}`); } catch { return false; }
}

/** Runs gold.exe with `proton runinprefix` and finds its Linux pid among our own descendants. */
async function runGold(pfx, client, timeoutMs) {
  const protonBin = join(PROTON_DIR, 'proton');
  const t = spawnTree('proton gold.exe', [protonBin, 'runinprefix', GOLD], { env: protonEnv(pfx, client), stdio: ['ignore', 'pipe', 'pipe'] });
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
  while ((!pid || !a.g_player || !a.earn) && now() < deadline) {
    t.track();
    pid = [...t.owned.keys()].find((p) => statOf(p)?.comm === 'gold.exe' || mapsImage(p, 'gold.exe')) ?? 0;
    if (t.child.exitCode !== null) break;
    await sleep(250);
  }
  const g = { tree: t, pid, start: t.owned.get(pid), a, stderr: () => stderr, ok: !!pid && !!a.g_player && !!a.earn };
  return g;
}

// Wine export -> final code address (following forwarders and jmp thunks, as the daemon does), so
// the speed hooks' original bytes are known before any hook exists (live-m2.mjs).
async function snapshotTargets(s, pid) {
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
      snap.set(addr, memRead(pid, addr, 32).toString('hex'));
      const ins = await E.disassemble(s, addr, 4);
      let next = null;
      for (const i of ins) {
        if (/^nop/i.test(i.text) || /^lea rsp,\[rsp\]$/i.test(i.text.replace(/\s/g, ''))) continue;
        if (/^jmp/i.test(i.text) && i.target) {
          next = i.text.includes('[') ? hex(readU64(pid, i.target.address)) : i.target.address;
        }
        break;
      }
      addr = next && next !== '0x0' ? next : null;
    }
  }
  return snap;
}
const snapState = (pid, snap) => [...snap].map(([ad, want]) => [ad, memRead(pid, ad, 32).toString('hex') === want ? 'original' : 'changed']);

async function proton() {
  if (!existsSync(join(PROTON_DIR, 'proton')) || !existsSync(GOLD)) throw new Error(`need ${PROTON_DIR}/proton and ${GOLD}`);
  const tmp = mkdtempSync(join(tmpdir(), 'starlight-live-m4-pfx-'));
  const pfx = join(tmp, 'pfx');
  const client = join(tmp, 'client');
  mkdirSync(pfx);
  mkdirSync(client);
  info(`throwaway prefix ${pfx}, throwaway client install path ${client}`);
  const golds = [];
  const wsKill = (cl) => {
    const ws = spawnSync(join(PROTON_DIR, 'files/bin/wineserver'), ['-k'], {
      env: { ...protonEnv(pfx, cl), WINEPREFIX: join(pfx, 'pfx') }, timeout: 15000, stdio: 'ignore',
    });
    info(`wineserver -k (own prefix) exit ${ws.status}`);
  };
  let usedClient = client;
  cleanups.push(() => {
    for (const g of golds) killTree(g.tree, () => wsKill(usedClient));
    const ours = [];
    for (const g of golds) {
      g.tree.track();
      for (const [p, start] of g.tree.owned) if (alive(p, start) && /^wineserver/.test(statOf(p)?.comm ?? '')) ours.push(p);
    }
    info(`wineservers of our prefix left: ${ours.length ? ours.join(', ') : 'none'}`);
    if (ours.length) { failures++; results.push({ name: 'own prefix wineserver gone', status: 'FAIL', detail: ours.join(',') }); }
    removeTmp(tmp);
  });

  let g = await runGold(pfx, client, 240_000);
  golds.push(g);
  if (!g.ok) {
    writeFileSync(join(LOG_DIR, 'live-m4-proton-stderr-throwaway-client.log'), g.stderr());
    info(`gold.exe did not start with the throwaway client dir (pid ${g.pid}); stderr tail: ${g.stderr().slice(-400).replace(/\s+/g, ' ')}`);
    killTree(g.tree, () => wsKill(client));
    usedClient = join(homedir(), '.steam/steam');
    info(`R17 FALLBACK: retrying with STEAM_COMPAT_CLIENT_INSTALL_PATH=${usedClient} (read only by Proton)`);
    g = await runGold(pfx, usedClient, 240_000);
    golds.push(g);
    if (!g.ok) {
      writeFileSync(join(LOG_DIR, 'live-m4-proton-stderr.log'), g.stderr());
      throw new Error(`gold.exe did not start (pid ${g.pid}, g_player ${g.a.g_player}; own: ${[...g.tree.owned.keys()].map((p) => `${p}:${statOf(p)?.comm}`).join(' ')})`);
    }
  } else info('R17: Proton started with the throwaway client install path (no fallback)');
  const goldAddr = () => hex(readU64(g.pid, g.a.g_player) + 0x10n);
  const env = readFileSync(`/proc/${g.pid}/environ`, 'utf8').split('\0');
  const leaked = env.filter((e) => /^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS)=/.test(e)).map((e) => e.split('=')[0]);
  check('R18: gold.exe runs without DISPLAY, WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS', leaked.length === 0, leaked.join(' ') || 'none set');
  info(`gold.exe pid ${g.pid} comm ${statOf(g.pid)?.comm}, earn ${g.a.earn}, gold at ${goldAddr()} = ${readI32(g.pid, goldAddr())}`);

  // earn's signature and displaced instructions, and the speed hooks' original bytes.
  const helper = await startHelperDaemon();
  let gt; let snap;
  {
    const s = await E.attach(helper.engine.client, g.pid);
    const sig = await E.makeSignature(s, g.a.earn);
    const d = await displaced(s, g.a.earn);
    snap = await snapshotTargets(s, g.pid);
    await s.detach();
    gt = { sig: sig.pattern, d };
    info(`earn signature ${sig.pattern} (${sig.module}, ${sig.unique ? 'unique' : `${sig.matches} matches`})`);
    for (const l of d.listing) info(`displaced ${l}`);
    info(`speed-hook targets snapshotted: ${snap.size}`);
  }
  await helper.stop();
  const earnOrig = memRead(g.pid, g.a.earn, 16).toString('hex');

  const gold = goldTable(gt);
  const ctDir = join(LOG_DIR, 'live-m4-cts');
  mkdirSync(ctDir, { recursive: true });
  writeFileSync(join(ctDir, 'gold.CT'), gold);
  const gc = C.compileTable(gold);
  info(`gold.CT: aobscanmodule(INJECT,${GOLD_CT_MODULE},…); compiled site module ${gc.records[0]?.script?.cheat?.site?.module}`);
  check('compileTable(gold.CT) → native: true', gc.native === true, gc.reasons.map((x) => `${x.code} ${x.detail}`).join(' ') || 'no reasons');
  const srv = await serveTables({ 'gold.CT': gold });

  const app = await startApp('proton');
  const r = await S(app, `ceSessionStart(${JSON.stringify({ source: srv.url('gold.CT'), cacheKey: 'live-m4-gold', pid: g.pid })})`);
  const ceRun = await ceAppears(app, 1500);
  check(`the session for gold.CT routes native and opens mode native (the CT says ${GOLD_CT_MODULE}, the module is gold.exe)`,
    r.ok && r.route?.engine === 'native' && r.mode === 'native' && r.attached === true && r.proton === true && ceRun.length === 0,
    `ok ${r.ok}, route ${r.route?.engine}, mode ${r.mode}, attached ${r.attached}, proton ${r.proton}, process ${JSON.stringify(r.process)}, CE: ${ceRun.join(' ') || 'none'}${r.error ? `, ${r.error}` : ''}`);
  if (!r.ok || r.mode !== 'native') throw new Error('no native session on gold.exe; the rest needs one');
  const sid = r.sessionId;

  const deltas = async (ms) => {
    const out = [];
    let last = readI32(g.pid, goldAddr());
    const end = now() + ms;
    while (now() < end) {
      await sleep(25);
      const v = readI32(g.pid, goldAddr());
      if (v !== last) { out.push(v - last); last = v; }
    }
    return out;
  };
  const on = await S(app, `ceSessionSetActive(${JSON.stringify({ sessionId: sid, recordId: 1, active: true })})`);
  await sleep(100);
  const dOn = await deltas(3000);
  check('enabling makes gold grow by 100 per tick', on.ok && dOn.length >= 3 && dOn.every((x) => x === 100), `${on.error ?? ''} deltas ${dOn.join(',')}`);
  const off = await S(app, `ceSessionSetActive(${JSON.stringify({ sessionId: sid, recordId: 1, active: false })})`);
  const earnBack = memRead(g.pid, g.a.earn, 16).toString('hex') === earnOrig;
  await sleep(100);
  const dOff = await deltas(2500);
  check('disabling restores earn\'s bytes, and gold grows by 1', off.ok && earnBack && dOff.length >= 2 && dOff.every((x) => x === 1),
    `${off.error ?? ''} bytes ${earnBack ? 'original' : 'changed'}, deltas ${dOff.join(',')}`);

  const sp = await S(app, `ceSessionCall(${JSON.stringify({ sessionId: sid, method: 'set_speed', params: { speed: 2 } })})`);
  const hooks = Array.isArray(sp.hooks) ? sp.hooks : [];
  for (const h of hooks) info(`hook ${h.name} ${h.status}${h.reason ? ` (${h.reason})` : ''}`);
  const hooked = (re) => hooks.some((h) => re.test(h.name) && h.status === 'hooked');
  const changed = snapState(g.pid, snap).filter(([, st]) => st === 'changed').length;
  check('set_speed 2 reports the QPC/tick hooks as hooked', sp.ok === true && hooked(/QueryPerformanceCounter/) && hooked(/^GetTickCount(64)?$/),
    `${JSON.stringify({ ok: sp.ok, speed: sp.speed, error: sp.error })}, ${hooks.length} hook(s) reported, ${changed}/${snap.size} snapshotted functions changed in memory`);
  await sleep(500);
  const tEnd = now();
  const end = await S(app, `ceSessionEnd(${JSON.stringify({ sessionId: sid })})`);
  const back = await waitFor(() => snapState(g.pid, snap).every(([, st]) => st === 'original') && tracerPid(g.pid) === 0, 5000, 20);
  check('ceSessionEnd restores the speed hooks\' bytes', end.ok && changed > 0 && !!back,
    `${back ? `${(now() - tEnd).toFixed(0)} ms` : 'not within 5 s'}: ${snapState(g.pid, snap).map(([ad, st]) => `${ad}=${st}`).join(' ')}, TracerPid ${tracerPid(g.pid)}`);
  const dAfter = await deltas(1500);
  info(`after the end: gold deltas ${dAfter.join(',')}; gold.exe ${alive(g.pid, g.start) ? 'running' : 'GONE'}`);
  for (const l of routeLines(app)) info(`app: ${l.trim()}`);
  await quitApp(app);
}

// -------------------------------------------------------------------------------------- main

const mode = process.argv[2];
if (!['native', 'proton'].includes(mode)) {
  console.error('usage: node scripts/live-m4.mjs native|proton');
  process.exit(2);
}
try {
  await (mode === 'native' ? native() : proton());
} catch (e) {
  failures++;
  console.log(`FAIL ${mode}: ${e.stack ?? e}`);
} finally {
  cleanupSync();
}
const n = (s) => results.filter((r) => r.status === s).length;
console.log(`${n('ok')} ok, ${n('FAIL') + (failures - n('FAIL'))} failed, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
