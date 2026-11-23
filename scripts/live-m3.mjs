#!/usr/bin/env node
// Live verification for native engine milestone 3 (the local MCP agent server).
//
//   node scripts/live-m3.mjs native                      # Steps 2-3: the C test target, spawned here
//   node scripts/live-m3.mjs proton                      # Step 4: gold.exe under Proton, throwaway prefix
//   STARLIGHT_LIVE_CLAUDE=1 node scripts/live-m3.mjs claude   # Step 5: a real `claude -p` run
//
// Needs the Step 1 builds: `cargo build --release` in packages/starlightd, `pnpm -r build`,
// `make -C packages/engine/test-target` and `make -C packages/engine/test-target/win`.
// PROTON overrides the Proton directory.
//
// The dev app runs with a temporary XDG_CONFIG_HOME (the CE runtime is copied in, so nothing is
// downloaded), on a private D-Bus session (dbus-monitor logs the Notify calls; no notification
// reaches the desktop) and under `cage` with the headless wlroots backend (no window is shown).
// It is driven over CDP on port 9223: window.starlight.* and clicks on the real buttons.
//
// Safety: this script only touches processes it starts itself (pid + start time, as in
// live-m2.mjs). Every tree runs under a child-subreaper wrapper so daemonized children (wine,
// wineserver, dbus services) stay its descendants. The Proton prefix is a fresh temp dir; cleanup
// kills only our own pids and stops only our own prefix's wineserver. list_games shows the
// player's real games too: targets are always picked by the pid we spawned.
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync,
  writeFileSync, writeSync, chmodSync, appendFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const SDK = join(DESKTOP, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
const TARGET = join(ROOT, 'packages/engine/test-target/build/target');
const GOLD = join(ROOT, 'packages/engine/test-target/win/build/gold.exe');
const PROTON_DIR = process.env.PROTON ?? join(homedir(), '.steam/steam/steamapps/common/Proton 11.0');
const REAL_RUNTIME = join(homedir(), '.config/@starlight/desktop/runtime');
const CDP_PORT = 9223;
const LOG_DIR = join(ROOT, '.superpowers');
/** The Library tile of the manual game "target" (with or without a catalog table). */
const TILE = 'button[title^="target — "], button[title="Open target trainer"]';

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

function statOf(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], ppid: Number(rest[1]), start: rest[19], comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')) };
  } catch { return null; }
}
function procTable() {
  const table = new Map();
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    const st = statOf(Number(e));
    if (st) table.set(Number(e), st);
  }
  return table;
}
// Grows `owned` (pid -> start time) with the descendants of its live entries; a recycled pid is dropped first.
function trackOwned(owned) {
  const table = procTable();
  for (const [p, start] of owned) if (table.get(p)?.start !== start) owned.delete(p);
  const children = new Map();
  for (const [p, st] of table) {
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(p);
  }
  const queue = [...owned.keys()];
  while (queue.length) {
    for (const c of children.get(queue.shift()) ?? []) {
      if (owned.has(c)) continue;
      owned.set(c, table.get(c).start);
      queue.push(c);
    }
  }
}
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
    trackOwned(t.owned);
    for (const [p, start] of t.owned) if (alive(p, start)) left.push(`${p}:${statOf(p)?.comm}`);
  }
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
// the ppid walk below it, so nothing else), then exits.
const SUBREAPER = `
import ctypes, os, signal, subprocess, sys
libc = ctypes.CDLL(None)
libc.prctl(36, 1, 0, 0, 0)
def descendants():
    kids = {}
    for e in os.listdir('/proc'):
        if not e.isdigit(): continue
        try:
            s = open('/proc/%s/stat' % e).read()
            kids.setdefault(int(s[s.rindex(')') + 2:].split()[1]), []).append(int(e))
        except Exception: pass
    out, q = [], [os.getpid()]
    while q:
        for c in kids.get(q.pop(), []):
            out.append(c); q.append(c)
    return out
def on_parent_death(*_):
    for _ in range(3):
        for p in descendants():
            try: os.kill(p, signal.SIGKILL)
            except Exception: pass
    os._exit(1)
signal.signal(signal.SIGUSR1, on_parent_death)
libc.prctl(1, signal.SIGUSR1, 0, 0, 0)
if os.getppid() != int(os.environ.get('LIVE_M3_PARENT', os.getppid())): on_parent_death()
subprocess.Popen(sys.argv[1:])
while True:
    try: os.wait()
    except ChildProcessError: break
`;

/** Spawns argv under a subreaper and tracks the whole tree. */
function spawnTree(name, argv, opts) {
  const child = spawn('python3', ['-I', '-c', SUBREAPER, ...argv], { ...opts, env: { ...(opts.env ?? process.env), LIVE_M3_PARENT: String(process.pid) } });
  const rootStart = child.pid ? statOf(child.pid)?.start : undefined;
  const owned = new Map();
  if (rootStart !== undefined) owned.set(child.pid, rootStart);
  const t = { name, child, owned, root: child.pid, rootStart, track: () => trackOwned(owned) };
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
/** A saved value cheat's address, resolved from /proc (CE pointer semantics: the last offset isn't dereferenced). */
function resolveSaved(pid, address) {
  if (address.kind === 'module') return moduleBase(pid, address.module) + BigInt(address.offset);
  if (address.kind === 'pointer') {
    let p = (address.module ? moduleBase(pid, address.module) : 0n) + BigInt(address.baseOffset);
    const offs = address.offsets.map((o) => BigInt(o));
    p = readU64(pid, p);
    for (let i = 0; i < offs.length; i++) p = i === offs.length - 1 ? p + offs[i] : readU64(pid, p + offs[i]);
    return p;
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
        inv.return_value(GLib.Variant('(ssss)', ('live-m3-stub', 'starlight', '1', '1.2')))
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
  const tmp = mkdtempSync(join(tmpdir(), `starlight-live-m3-${label}-`));
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
    try { cpSync(appLog, join(LOG_DIR, `live-m3-${label}-app.log`)); } catch { /* no log */ }
    try { cpSync(notifyLog, join(LOG_DIR, `live-m3-${label}-notify.log`)); } catch { /* no log */ }
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

async function notifyCalls(app) {
  let text = '';
  try { text = readFileSync(app.notifyLog, 'utf8'); } catch { /* none */ }
  const calls = text.split(/\n(?=method call )/).filter((b) => /member=Notify\b/.test(b));
  return calls.map((b) => [...b.matchAll(/string "([^"]*)"/g)].map((m) => m[1]).join(' | '));
}

// ------------------------------------------------------------------------------------ MCP client

async function connectAgent(info_, name = 'live-m3') {
  const { Client } = await import(join(SDK, 'client/index.js'));
  const { StreamableHTTPClientTransport } = await import(join(SDK, 'client/streamableHttp.js'));
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(info_.url), {
    requestInit: { headers: { Authorization: `Bearer ${info_.token}` } },
  });
  await client.connect(transport);
  const calls = [];
  async function call(tool, args = {}) {
    calls.push(tool);
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 });
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) return { error: text };
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  return { client, transport, call, calls, close: () => client.close().catch(() => {}) };
}

/** Answers the approval card by clicking the real Allow button. Returns the card's title. */
async function clickAllow(app) {
  const title = await waitFor(() => app.cdp.evaluate(`return $text('[role=alertdialog][aria-label="Agent attach request"] h2');`), 30_000, 150);
  const r = await app.cdp.evaluate(`return $click('Allow', '[role=alertdialog][aria-label="Agent attach request"]');`);
  if (r !== 'clicked') throw new Error(`could not click Allow (${r})`);
  return title;
}
/** Clicks Yes on the question card. */
async function clickYes(app) {
  const q = await waitFor(() => app.cdp.evaluate(`return $text('section[aria-label=Question]');`), 30_000, 150);
  const r = await app.cdp.evaluate(`return $click('Yes', 'section[aria-label=Question]');`);
  if (r !== 'clicked') throw new Error(`could not click Yes (${r})`);
  return q;
}

async function curlStatus(url, headers) {
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-H', 'content-type: application/json',
    '--data', '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'];
  for (const h of headers) args.push('-H', h);
  return spawnSync('curl', [...args, url], { encoding: 'utf8' }).stdout.trim();
}

async function setModify(app, on) {
  await app.cdp.evaluate(`location.hash = '#/agent'; return true;`);
  const cur = await waitFor(() => app.cdp.evaluate(`const b = document.querySelector('button[role=switch][aria-label="Agent can modify the game"]'); return b ? b.getAttribute('aria-checked') : null;`), 5000);
  if (cur === null) throw new Error('no "Agent can modify the game" switch');
  if ((cur === 'true') !== on) await app.cdp.evaluate(`document.querySelector('button[role=switch][aria-label="Agent can modify the game"]').click(); return true;`);
  return waitFor(async () => (await S(app, 'agentGetState()')).canModify === on, 3000, 100);
}

/** The activity panel lists every tool call the client made (by tool name), as the snapshot does. */
async function checkActivity(app, agent) {
  await app.cdp.evaluate(`location.hash = '#/agent'; return true;`);
  await sleep(400);
  const st = await S(app, 'agentGetState()');
  const li = await app.cdp.evaluate(`return [...document.querySelectorAll('section[aria-label=Activity] li')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim());`);
  const toolEntries = st.activity.filter((e) => e.tool !== null);
  const want = new Map();
  for (const c of agent.calls) want.set(c, (want.get(c) ?? 0) + 1);
  const have = new Map();
  for (const e of toolEntries) have.set(e.tool, (have.get(e.tool) ?? 0) + 1);
  const missing = [...want].filter(([k, n]) => (have.get(k) ?? 0) < n).map(([k, n]) => `${k}×${n - (have.get(k) ?? 0)}`);
  const shown = st.activity.every((e) => li.some((t) => t.includes(e.summary)));
  check('the activity panel lists every call', missing.length === 0 && li.length === st.activity.length && shown,
    `${agent.calls.length} calls, ${toolEntries.length} tool entries, ${li.length} rows${missing.length ? `, missing ${missing.join(' ')}` : ''}${shown ? '' : ', a summary is not shown'}`);
}

// ----------------------------------------------------------------------------------- native mode

async function native() {
  const tmp = mkdtempSync(join(tmpdir(), 'starlight-live-m3-ac-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const acDll = join(tmp, 'EasyAntiCheat_x64.dll');
  writeFileSync(acDll, Buffer.alloc(8192, 0x90));

  let A = await spawnTarget(['--heap-chain', '--writer']);
  const B = await spawnTarget(['--map', acDll]);
  info(`target A pid ${A.pid} (heap_value ${A.a.heap_value}, g_counter ${A.a.g_counter}), anti-cheat target B pid ${B.pid}`);
  const bumpOrig = memRead(A.pid, A.a.bump_counter, 16).toString('hex');

  const app = await startApp('native');
  await S(app, `updateConfig({ patch: { manualGames: [{ id: 'live-m3-target', name: 'target', exePath: ${JSON.stringify(TARGET)}, addedAt: new Date().toISOString() }] } })`);
  const conn = await S(app, 'agentConnectInfo()');
  info(`MCP ${conn.url}${conn.portIsFallback ? ' (fallback port)' : ''}`);

  // ---- Step 2
  check('curl without a token → 401', (await curlStatus(conn.url, [])) === '401');
  check('curl with Origin: http://example.com → 403', (await curlStatus(conn.url, ['Origin: http://example.com', `Authorization: Bearer ${conn.token}`])) === '403');

  const agent = await connectAgent(conn);
  cleanups.push(() => { void agent.close(); });
  const lg = await agent.call('list_games');
  const ga = lg.games?.find((g) => g.pid === A.pid);
  const gb = lg.games?.find((g) => g.pid === B.pid);
  check('list_games lists both targets; the second has antiCheat set', !!ga && !!gb && !ga.antiCheat && !!gb.antiCheat,
    `A ${JSON.stringify(ga)} B ${JSON.stringify(gb)}`);

  const acAttach = await agent.call('attach', { pid: B.pid });
  await sleep(300);
  const stAc = await S(app, 'agentGetState()');
  const cardAc = await app.cdp.evaluate(`return !!document.querySelector('[role=alertdialog][aria-label="Agent attach request"]');`);
  check('attach to the anti-cheat target fails with the anti-cheat message, no approval card',
    !!acAttach.error && /anti-cheat/i.test(acAttach.error) && stAc.approval === null && !cardAc, acAttach.error ?? JSON.stringify(acAttach));

  const attachP = agent.call('attach', { pid: A.pid });
  const title = await clickAllow(app);
  const att = await attachP;
  check('attach shows "… wants to attach to target — Allow?"', /wants to attach to target — Allow\?$/.test(title ?? ''), title);
  const hash = await waitFor(() => app.cdp.evaluate(`return location.hash === '#/agent' && !!document.querySelector('button[role=switch]') ? location.hash : null;`), 5000);
  check('clicking Allow attaches and the Agent view opens', att.attached === true && hash === '#/agent', `${JSON.stringify(att.game)} ${hash}`);
  if (!att.attached) throw new Error('not attached; the rest needs an attach');
  await setModify(app, true);

  // Value scan → ask_player → pointer scan.
  const sf = await agent.call('scan_first', { type: 'int32', mode: 'exact', value: '777' });
  const inScan = sf.results?.some((r) => r.address === A.a.heap_value);
  const askP = agent.call('ask_player', { question: 'Is your heap value 777 right now?', answer: 'confirm' });
  const qText = await clickYes(app);
  const ask = await askP;
  check('scan_first int32 exact 777 → ask_player confirm answered with Yes',
    sf.count >= 1 && inScan && ask.answered === true && ask.answer === true, `${sf.count} match(es), heap_value ${inScan ? 'among them' : 'missing'}; card "${qText?.split('\n')[0]}"; ${JSON.stringify(ask)}`);
  const ps = await agent.call('pointer_scan', { address: A.a.heap_value });
  const path = ps.paths?.find((p) => p.module === 'target' && p.offsets.join() === '0x18,0x10');
  check('pointer_scan finds target+… → 0x18 → 0x10', !!path, path ? path.text : `${ps.count} path(s) ${ps.error ?? ''}`);

  const notes = await notifyCalls(app);
  check('dbus-monitor sees the approval and the ask_player notifications',
    notes.some((n) => /attach/i.test(n)) && notes.some((n) => n.includes('Is your heap value 777')), notes.join(' || ') || 'no Notify call');

  // Pointer freeze through test_cheat, then save (range 0–100000) and the R18 narrow-range cheat (0–1000).
  const ptrAddr = path ? { kind: 'pointer', module: 'target', baseOffset: path.base, offsets: path.offsets } : null;
  const ptrCheat = { name: 'Heap value 9999', type: 'freeze', valueType: 'int32', value: 9999, address: ptrAddr };
  const tc = await agent.call('test_cheat', { action: 'apply', cheat: ptrCheat });
  await sleep(400);
  const frozen = readI32(A.pid, A.a.heap_value);
  const rv = await agent.call('test_cheat', { action: 'revert', test: tc.test });
  writeI32(A.pid, A.a.heap_value, 777);
  await sleep(200);
  const afterRevert = readI32(A.pid, A.a.heap_value);
  check('test_cheat freezes heap_value at 9999 (/proc reads 9999), then reverts',
    tc.test !== undefined && frozen === 9999 && rv.reverted === true && afterRevert === 777, `${tc.error ?? ''} read ${frozen}, after revert + write 777 ${afterRevert}`);
  const sv1 = await agent.call('save_cheat', { cheat: { ...ptrCheat, verify: { range: { min: 0, max: 100000 } } } });
  check('save_cheat saves the pointer cheat with range 0–100000', !!sv1.saved?.id, sv1.error ?? sv1.saved?.id);
  const narrow = { name: 'Heap value narrow', type: 'freeze', valueType: 'int32', value: 500, address: ptrAddr, verify: { range: { min: 0, max: 1000 } } };
  const sv3 = await agent.call('save_cheat', { cheat: narrow });
  check('R18: save_cheat saves a third cheat with range 0–1000 while heap_value reads 777', !!sv3.saved?.id, sv3.error ?? sv3.saved?.id);

  // Write watch → signature → `ret` patch on bump_counter.
  const ww = await agent.call('watch_writes', { address: A.a.g_counter, duration_ms: 2000 });
  const bump = BigInt(A.a.bump_counter);
  const site = ww.sites?.find((s) => BigInt(s.address) >= bump && BigInt(s.address) < bump + 0x16n);
  check('watch_writes on g_counter reports a site inside bump_counter', !!site, site ? `${site.address} ${site.where} "${site.text}" ×${site.count}` : JSON.stringify(ww).slice(0, 300));
  let patchCheat = null;
  if (site) {
    const sig = await agent.call('make_signature', { address: site.address });
    const off = BigInt(site.address) - bump;
    patchCheat = {
      name: 'Stop the counter', type: 'patch', site: sig.aob,
      enable: [{ op: 'writeBytes', at: `site-0x${off.toString(16)}`, bytes: 'c3', original: bumpOrig.slice(0, 2) }],
    };
    info(`make_signature ${sig.unique ? 'unique' : sig.matches + ' matches'}: ${sig.pattern} (${sig.module}); ret at site-0x${off.toString(16)}`);
    const tp = await agent.call('test_cheat', { action: 'apply', cheat: patchCheat });
    await sleep(200);
    const c0 = readI32(A.pid, A.a.g_counter); await sleep(400); const c1 = readI32(A.pid, A.a.g_counter);
    await agent.call('test_cheat', { action: 'revert', test: tp.test });
    await sleep(400);
    const c2 = readI32(A.pid, A.a.g_counter);
    const restored = memRead(A.pid, A.a.bump_counter, 16).toString('hex') === bumpOrig;
    check('make_signature → test_cheat with writeBytes c3 stops g_counter; revert resumes it',
      sig.unique && tp.test !== undefined && c1 === c0 && c2 > c1 && restored, `${tp.error ?? ''} ${c0} ${c1} ${c2}, bytes ${restored ? 'original' : 'changed'}`);
    const sv2 = await agent.call('save_cheat', { cheat: patchCheat });
    check('save_cheat saves the patch', !!sv2.saved?.id, sv2.error ?? sv2.saved?.id);
  }

  await checkActivity(app, agent);

  // The player's switch.
  await setModify(app, false);
  const wr = await agent.call('write', { address: A.a.heap_value, type: 'int32', value: '1' });
  check('switch off → write refuses with MODIFY_OFF', !!wr.error && /turned off "Agent can modify the game"/.test(wr.error), wr.error ?? JSON.stringify(wr));
  await setModify(app, true);

  // Stop, with a freeze and a test patch live.
  const fz = await agent.call('freeze', { address: A.a.heap_value, type: 'int32', value: '4242' });
  const tp2 = patchCheat ? await agent.call('test_cheat', { action: 'apply', cheat: patchCheat }) : {};
  await sleep(300);
  const preTracer = tracerPid(A.pid);
  const preBytes = memRead(A.pid, A.a.bump_counter, 1).toString('hex');
  writeI32(A.pid, A.a.heap_value, 1);
  await sleep(300);
  const preHeld = readI32(A.pid, A.a.heap_value);
  const pre = `freeze ${fz.freeze ?? fz.error}, test ${tp2.test ?? tp2.error}, TracerPid ${preTracer}, bump_counter[0] ${preBytes}, heap_value after writing 1: ${preHeld}`;
  check('before Stop: the freeze holds heap_value at 4242, the test patch is on bump_counter, the game is traced',
    fz.freeze !== undefined && tp2.test !== undefined && preBytes === 'c3' && preHeld === 4242 && preTracer > 0, pre);
  await app.cdp.evaluate(`location.hash = '#/agent'; return true;`);
  await sleep(200);
  const t0 = now();
  const clicked = await app.cdp.evaluate(`return $click('Stop', 'main');`);
  const done = await waitFor(() => tracerPid(A.pid) === 0 && memRead(A.pid, A.a.bump_counter, 16).toString('hex') === bumpOrig, 1000, 20);
  const elapsed = now() - t0;
  writeI32(A.pid, A.a.heap_value, 1234);
  await sleep(400);
  const stuck = readI32(A.pid, A.a.heap_value);
  check('Stop: within 1 s TracerPid is 0, bump_counter bytes are original, a direct write to heap_value sticks',
    fz.freeze !== undefined && tp2.test !== undefined && preBytes === 'c3' && preHeld === 4242 && preTracer > 0 &&
    clicked === 'clicked' && !!done && elapsed <= 1000 && stuck === 1234,
    `clicked ${clicked}, ${elapsed.toFixed(0)} ms, TracerPid ${tracerPid(A.pid)}, heap_value ${stuck}`);
  writeI32(A.pid, A.a.heap_value, 777);
  await agent.close();

  // ---- Step 3: restart survival from the game page
  stopTarget(B);
  stopTarget(A);
  await sleep(500);
  A = await spawnTarget(['--heap-chain', '--writer']);
  const bumpOrig2 = memRead(A.pid, A.a.bump_counter, 16).toString('hex');
  info(`restarted target pid ${A.pid} (heap_value ${A.a.heap_value})`);
  await app.cdp.evaluate(`location.hash = '#/library'; return true;`);
  const tile = await waitFor(() => app.cdp.evaluate(`return document.querySelector(${JSON.stringify(TILE)})?.title ?? null;`), 20_000, 300);
  if (!tile) throw new Error('no Library tile for the manual game "target"');
  info(`Library tile: "${tile}"`);
  await app.cdp.evaluate(`document.querySelector(${JSON.stringify(TILE)}).click(); return true;`);
  const names = ['Heap value 9999', 'Stop the counter', 'Heap value narrow'];
  const rows = await waitFor(() => app.cdp.evaluate(`
    const s = document.querySelector('section[aria-label="My cheats"]'); if (!s) return null;
    const t = s.innerText; return ${JSON.stringify(names)}.every((n) => t.includes(n)) ? t : null;`), 60_000, 500);
  const page = await app.cdp.evaluate(`return document.querySelector('main')?.innerText.slice(0, 600) ?? '';`);
  check('My cheats shows the cheats as yours', !!rows && (rows.match(/Yours/g) ?? []).length >= 3, rows ? rows.replace(/\s+/g, ' ').slice(0, 200) : page.replace(/\s+/g, ' '));
  if (!rows) throw new Error('the game page has no My cheats section; the rest of Step 3 needs it');

  const toggle = async (name) => app.cdp.evaluate(`
    const b = [...document.querySelectorAll('section[aria-label="My cheats"] button[aria-pressed]')].find((x) => x.getAttribute('aria-label')?.startsWith(${JSON.stringify(name + ':')}));
    if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';`);
  const isOn = async (name) => app.cdp.evaluate(`
    const b = [...document.querySelectorAll('section[aria-label="My cheats"] button[aria-pressed]')].find((x) => x.getAttribute('aria-label')?.startsWith(${JSON.stringify(name + ':')}));
    return b ? b.getAttribute('aria-pressed') === 'true' : null;`);
  // Wait until the page's session settles (rows enabled), so the toggle isn't disabled.
  await waitFor(async () => (await app.cdp.evaluate(`
    const b = [...document.querySelectorAll('section[aria-label="My cheats"] button[aria-pressed]')]; return b.length > 0 && b.every((x) => !x.disabled);`)), 60_000, 500);
  const tg = await toggle('Heap value 9999');
  const confirmShown = await waitFor(() => app.cdp.evaluate(`return !!document.querySelector('[role=alertdialog][aria-label="Close the Cheat Engine table"]');`), 4000, 150);
  if (confirmShown) {
    const before = ceProcs(app);
    const cont = await app.cdp.evaluate(`return $click('Continue', '[role=alertdialog][aria-label="Close the Cheat Engine table"]');`);
    const closed = await waitFor(() => ceProcs(app).length === 0, 10_000, 200);
    check('a CE session ran: toggling the pointer cheat shows the close-table confirm; Continue closes CE', cont === 'clicked' && before.length > 0 && closed,
      `toggle ${tg}, continue ${cont}, CE processes before: ${before.join(' ') || 'none'}, after: ${ceProcs(app).join(' ') || 'none'}`);
  } else {
    skip('close-table confirm → Continue closes CE', `no CE session held the game page (toggle ${tg}); the brief makes this check conditional`);
  }
  const on1 = await waitFor(() => isOn('Heap value 9999'), 8000, 200);
  await sleep(400);
  const v1 = readI32(A.pid, A.a.heap_value);
  writeI32(A.pid, A.a.heap_value, 5);
  await sleep(400);
  const v2 = readI32(A.pid, A.a.heap_value);
  check('the pointer cheat freezes the new heap_value at 9999', on1 === true && v1 === 9999 && v2 === 9999, `on ${on1}, read ${v1}, after writing 5: ${v2}`);

  const tp = await toggle('Stop the counter');
  const pOn = await waitFor(() => isOn('Stop the counter'), 8000, 200);
  await sleep(300);
  const p0 = readI32(A.pid, A.a.g_counter); await sleep(400); const p1 = readI32(A.pid, A.a.g_counter);
  await toggle('Stop the counter');
  const pOff = await waitFor(async () => (await isOn('Stop the counter')) === false, 8000, 200);
  await sleep(400);
  const p2 = readI32(A.pid, A.a.g_counter);
  check('the patch cheat stops g_counter; toggling it off resumes it', tp === 'clicked' && pOn === true && p1 === p0 && !!pOff && p2 > p1, `${p0} ${p1} ${p2}`);

  // R18: the narrow-range cheat needs updating once the value is 5000.
  await toggle('Heap value 9999');
  await waitFor(async () => (await isOn('Heap value 9999')) === false, 8000, 200);
  await sleep(300);
  writeI32(A.pid, A.a.heap_value, 5000);
  await app.cdp.evaluate(`location.hash = '#/'; return true;`);
  await sleep(500);
  await app.cdp.evaluate(`location.hash = '#/active'; return true;`);
  // The store keeps the last list across the remount; wait for the reload the remount starts.
  const badges = () => app.cdp.evaluate(`
    return [...document.querySelectorAll('section[aria-label="My cheats"] [aria-label^="Needs updating"]')].map((e) => e.getAttribute('aria-label')).join(' | ') || null;`);
  const badge = (await waitFor(async () => ((await badges()) ?? '').includes('the value is 5000') ? badges() : null, 15_000, 300)) ?? (await badges());
  check('R18: the narrow cheat shows Needs updating "the value is 5000, outside 0–1000"', !!badge && badge.includes('the value is 5000, outside 0–1000'), badge ?? 'no badge');
  await waitFor(async () => (await isOn('Heap value narrow')) !== null, 5000, 200);
  const tn = await toggle('Heap value narrow');
  await sleep(1500);
  const narrowOn = await isOn('Heap value narrow');
  const narrowErr = await app.cdp.evaluate(`
    const rows = [...document.querySelectorAll('section[aria-label="My cheats"] > div > div')]; const r = rows.find((x) => x.innerText.includes('Heap value narrow'));
    return r?.querySelector('[role=alert]')?.innerText ?? null;`);
  const v3 = readI32(A.pid, A.a.heap_value);
  check('R18: enabling the narrow cheat refuses', narrowOn === false && v3 === 5000, `toggle ${tn}, on ${narrowOn}, value ${v3}, error "${narrowErr}"`);

  // Quit with the patch on: bump_counter's bytes come back.
  await toggle('Stop the counter');
  const pOn2 = await waitFor(() => isOn('Stop the counter'), 8000, 200);
  await sleep(300);
  const patched = memRead(A.pid, A.a.bump_counter, 16).toString('hex') !== bumpOrig2;
  await quitApp(app);
  const q0 = readI32(A.pid, A.a.g_counter); await sleep(400); const q1 = readI32(A.pid, A.a.g_counter);
  const bytesBack = memRead(A.pid, A.a.bump_counter, 16).toString('hex') === bumpOrig2;
  check('quitting the app restores bump_counter bytes', pOn2 === true && patched && bytesBack && q1 > q0 && tracerPid(A.pid) === 0,
    `patch was ${patched ? 'applied' : 'NOT applied'}, bytes ${bytesBack ? 'original' : 'changed'}, counter ${q0} → ${q1}, TracerPid ${tracerPid(A.pid)}`);
}

// ----------------------------------------------------------------------------------- proton mode

function protonEnv(pfx) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('STEAM_COMPAT_') || k.startsWith('WINE') || k.startsWith('PROTON_')) delete env[k];
  env.STEAM_COMPAT_DATA_PATH = pfx;
  env.STEAM_COMPAT_CLIENT_INSTALL_PATH = join(homedir(), '.steam/steam');
  return env;
}
function mapsImage(pid, image) {
  try { return readFileSync(`/proc/${pid}/maps`, 'utf8').includes(`/${image}`); } catch { return false; }
}

/** Runs gold.exe with `proton runinprefix` and finds its Linux pid among our own descendants. */
async function runGold(pfx, exclude = new Set()) {
  const protonBin = join(PROTON_DIR, 'proton');
  // `runinprefix`, not `run`: `run` starts Proton's steam.exe launcher, which waits for a Steam client.
  const t = spawnTree('proton gold.exe', [protonBin, 'runinprefix', GOLD], { env: protonEnv(pfx), stdio: ['ignore', 'pipe', 'pipe'] });
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
  const deadline = now() + 240_000;
  while ((!pid || !a.g_player || !a.earn) && now() < deadline) {
    t.track();
    pid = [...t.owned.keys()].find((p) => !exclude.has(p) && (statOf(p)?.comm === 'gold.exe' || mapsImage(p, 'gold.exe'))) ?? 0;
    if (t.child.exitCode !== null) break;
    await sleep(250);
  }
  if (!pid || !a.g_player) {
    writeFileSync(join(LOG_DIR, 'live-m3-proton-stderr.log'), stderr);
    throw new Error(`gold.exe did not start (pid ${pid}, g_player ${a.g_player}; own: ${[...t.owned.keys()].map((p) => `${p}:${statOf(p)?.comm}`).join(' ')})`);
  }
  return { tree: t, pid, start: t.owned.get(pid), a, stderr: () => stderr };
}
const goldAddr = (g) => readU64(g.pid, g.a.g_player) + 0x10n;

async function proton() {
  if (!existsSync(join(PROTON_DIR, 'proton')) || !existsSync(GOLD)) throw new Error(`need ${PROTON_DIR}/proton and ${GOLD}`);
  const tmp = mkdtempSync(join(tmpdir(), 'starlight-live-m3-pfx-'));
  const pfx = join(tmp, 'pfx');
  mkdirSync(pfx);
  info(`throwaway prefix ${pfx}`);
  const golds = [];
  cleanups.push(() => {
    // Our trees first (stopping our prefix's wineserver in between), then the prefix itself.
    for (const g of golds) {
      killTree(g.tree, () => {
        const ws = spawnSync(join(PROTON_DIR, 'files/bin/wineserver'), ['-k'], {
          env: { ...protonEnv(pfx), WINEPREFIX: join(pfx, 'pfx') }, timeout: 15000, stdio: 'ignore',
        });
        info(`wineserver -k (own prefix) exit ${ws.status}`);
      });
    }
    // Our prefix's wineserver daemonizes under our subreaper, so it is in our own tracked set.
    const ours = [];
    for (const g of golds) {
      g.tree.track();
      for (const [p, start] of g.tree.owned) if (alive(p, start) && /^wineserver/.test(statOf(p)?.comm ?? '')) ours.push([p]);
    }
    info(`wineservers of our prefix left: ${ours.length ? ours.map(([p]) => p).join(', ') : 'none'}`);
    if (ours.length) { failures++; results.push({ name: 'own prefix wineserver gone', status: 'FAIL', detail: ours.map(([p]) => p).join(',') }); }
    removeTmp(tmp);
  });

  let g = await runGold(pfx);
  golds.push(g);
  info(`gold.exe pid ${g.pid} comm ${statOf(g.pid)?.comm}, g_player ${g.a.g_player}, earn ${g.a.earn}, gold at ${hex(goldAddr(g))} = ${readI32(g.pid, goldAddr(g))}`);

  const app = await startApp('proton');
  const conn = await S(app, 'agentConnectInfo()');
  const agent = await connectAgent(conn);
  cleanups.push(() => { void agent.close(); });

  const lg = await agent.call('list_games');
  const gg = lg.games?.find((x) => x.pid === g.pid);
  check('list_games shows gold.exe with proton: true', gg?.proton === true, JSON.stringify(gg));

  const attachP = agent.call('attach', { pid: g.pid });
  const title = await clickAllow(app);
  const att = await attachP;
  check('attach (approved by clicking Allow over CDP)', att.attached === true, `${title} → ${JSON.stringify(att.game ?? att)}`);
  if (!att.attached) throw new Error('not attached');
  await setModify(app, true);

  const gaddr = hex(goldAddr(g));
  const cur = readI32(g.pid, gaddr);
  const sf = await agent.call('scan_first', { type: 'int32', mode: 'range', min: '500', max: String(cur + 1000) });
  const askP = agent.call('ask_player', { question: 'Did your gold go up?', answer: 'confirm' });
  await clickYes(app);
  const ask = await askP;
  let count = sf.count;
  let last = null;
  for (let i = 0; i < 6 && (count > 3 || !last?.results?.some((r) => r.address === gaddr)); i++) {
    await sleep(700);
    last = await agent.call('scan_next', { scan: sf.scan, mode: 'increased' });
    count = last.count;
  }
  const found = last?.results?.some((r) => r.address === gaddr);
  check('scan for 500 and up → ask_player → scan_next increased finds gold', ask.answered === true && ask.answer === true && !!found,
    `${sf.count} → ${count} match(es), gold ${found ? 'among them' : 'missing'}${last?.error ? ' ' + last.error : ''}`);

  const ww = await agent.call('watch_writes', { address: gaddr, duration_ms: 2000 });
  const site = ww.sites?.[0];
  check('watch_writes reports a site whose where starts with gold.exe+0x', /^gold\.exe\+0x/i.test(site?.where ?? ''), site ? `${site.address} ${site.where} "${site.text}" ×${site.count}` : JSON.stringify(ww).slice(0, 300));
  if (!site) throw new Error('no watch site');
  const sig = await agent.call('make_signature', { address: site.address });
  const off = BigInt(site.address) - BigInt(g.a.earn);
  const orig = memRead(g.pid, g.a.earn, 1).toString('hex');
  const patchCheat = {
    name: 'Stop gold', type: 'patch', site: sig.aob,
    enable: [{ op: 'writeBytes', at: off === 0n ? 'site' : `site-0x${off.toString(16)}`, bytes: 'c3', original: orig }],
  };
  info(`make_signature ${sig.unique ? 'unique' : sig.matches + ' matches'}: ${sig.pattern} (${sig.module}); ret at earn = site-0x${off.toString(16)}`);
  const tp = await agent.call('test_cheat', { action: 'apply', cheat: patchCheat });
  await sleep(300);
  const c0 = readI32(g.pid, gaddr); await sleep(1200); const c1 = readI32(g.pid, gaddr);
  await agent.call('test_cheat', { action: 'revert', test: tp.test });
  await sleep(1200);
  const c2 = readI32(g.pid, gaddr);
  check('make_signature → test_cheat patch stops gold; revert resumes', sig.unique && tp.test !== undefined && c1 === c0 && c2 > c1, `${tp.error ?? ''} ${c0} ${c1} ${c2}`);
  const sv = await agent.call('save_cheat', { cheat: patchCheat });
  check('save_cheat saves the gold patch', !!sv.saved?.id, sv.error ?? `${sv.saved.id} for ${sv.saved.game}`);
  await checkActivity(app, agent);
  await agent.close();

  // Restart gold.exe in the same prefix; the tools-only page (from Running now) lists the cheat.
  const oldPid = g.pid;
  killOwn(g.pid, g.start);
  await waitFor(() => !alive(oldPid), 5000, 100);
  await waitFor(async () => (await S(app, 'agentGetState()')).status === 'idle', 10_000, 300);
  g = await runGold(pfx, new Set([oldPid]));
  golds.push(g);
  const gaddr2 = hex(goldAddr(g));
  info(`restarted gold.exe pid ${g.pid}, gold at ${gaddr2}`);
  await app.cdp.evaluate(`location.hash = '#/active'; return true;`);
  const btn = await waitFor(() => app.cdp.evaluate(`
    return !!document.querySelector('main') && [...document.querySelectorAll('main button')].some((b) => b.innerText.includes('pid ${g.pid} '));`), 30_000, 500);
  if (!btn) throw new Error(`gold.exe (pid ${g.pid}) is not under Running now`);
  await app.cdp.evaluate(`[...document.querySelectorAll('main button')].find((b) => b.innerText.includes('pid ${g.pid} ')).click(); return true;`);
  const rows = await waitFor(() => app.cdp.evaluate(`const s = document.querySelector('section[aria-label="My cheats"]'); return s && s.innerText.includes('Stop gold') ? s.innerText : null;`), 120_000, 500);
  const page = await app.cdp.evaluate(`return document.querySelector('main')?.innerText.slice(0, 600) ?? '';`);
  check('the tools-only game page lists the saved cheat', !!rows, rows ? rows.replace(/\s+/g, ' ') : page.replace(/\s+/g, ' '));
  if (rows) {
    await waitFor(() => app.cdp.evaluate(`const b = document.querySelector('section[aria-label="My cheats"] button[aria-pressed]'); return !!b && !b.disabled;`), 120_000, 500);
    const tg = await app.cdp.evaluate(`const b = document.querySelector('section[aria-label="My cheats"] button[aria-label^="Stop gold:"]'); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';`);
    const confirm = await waitFor(() => app.cdp.evaluate(`return !!document.querySelector('[role=alertdialog][aria-label="Close the Cheat Engine table"]');`), 4000, 150);
    if (confirm) {
      info('close-table confirm shown (a CE session ran on gold.exe); clicking Continue');
      await app.cdp.evaluate(`return $click('Continue', '[role=alertdialog][aria-label="Close the Cheat Engine table"]');`);
    }
    const on = await waitFor(() => app.cdp.evaluate(`return document.querySelector('section[aria-label="My cheats"] button[aria-label^="Stop gold:"]')?.getAttribute('aria-pressed') === 'true';`), 15_000, 300);
    await sleep(300);
    const d0 = readI32(g.pid, gaddr2); await sleep(1200); const d1 = readI32(g.pid, gaddr2);
    const err = await app.cdp.evaluate(`return document.querySelector('section[aria-label="My cheats"] [role=alert]')?.innerText ?? null;`);
    check('enabling the cheat on the restarted gold.exe stops gold', tg === 'clicked' && on && d1 === d0, `toggle ${tg}, on ${on}, gold ${d0} → ${d1}${err ? `, error "${err}"` : ''}`);
  }
  await quitApp(app);
}

// ----------------------------------------------------------------------------------- claude mode

/** A pass-through HTTP proxy that records each request's method and headers (to see what the client sends). */
function headerProxy(upstreamPort) {
  const log = [];
  const server = createServer((req, res) => {
    log.push({ method: req.method, origin: req.headers.origin ?? null, ua: req.headers['user-agent'] ?? null, headers: Object.keys(req.headers) });
    const up = httpRequest({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` } }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, log })));
}

async function claudeMode() {
  if (process.env.STARLIGHT_LIVE_CLAUDE !== '1') { skip('Step 5 real agent', 'STARLIGHT_LIVE_CLAUDE=1 not set'); return; }
  const claudeBin = spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  if (!claudeBin) { skip('Step 5 real agent', 'the claude CLI is not installed'); return; }

  let A = await spawnTarget(['--heap-chain']);
  info(`target pid ${A.pid}, heap_value ${A.a.heap_value}`);
  const app = await startApp('claude');
  await S(app, `updateConfig({ patch: { manualGames: [{ id: 'live-m3-target', name: 'target', exePath: ${JSON.stringify(TARGET)}, addedAt: new Date().toISOString() }] } })`);
  const conn = await S(app, 'agentConnectInfo()');

  // Codex: the Settings snippet parses and lists the server.
  const codexBin = spawnSync('bash', ['-lc', 'command -v codex'], { encoding: 'utf8' }).stdout.trim();
  if (codexBin) {
    const codexHome = mkdtempSync(join(tmpdir(), 'starlight-live-m3-codex-'));
    cleanups.push(() => rmSync(codexHome, { recursive: true, force: true }));
    writeFileSync(join(codexHome, 'config.toml'), conn.codexConfig);
    const r = spawnSync(codexBin, ['mcp', 'list'], { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8', timeout: 60_000 });
    check('codex mcp list (CODEX_HOME with codexConfig) lists starlight', r.status === 0 && /\bstarlight\b/.test(r.stdout), `exit ${r.status} ${(r.stdout + r.stderr).replace(/\s+/g, ' ').slice(0, 300)}`);
  } else skip('codex mcp list', 'codex is not installed');

  const proxy = await headerProxy(conn.port);
  cleanups.push(() => proxy.server.close());
  const work = mkdtempSync(join(tmpdir(), 'starlight-live-m3-claude-'));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  const mcpConfig = join(work, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { starlight: { type: 'http', url: `http://127.0.0.1:${proxy.port}/mcp`, headers: { Authorization: `Bearer ${conn.token}` } } } }));
  const prompt = `Use the starlight tools: attach to the game named target (pid ${A.pid}), find the 32-bit value that is 777 right now, build a cheat that freezes it at 9999 that survives a restart, test it and save it.`;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_?CODE|^CLAUDECODE$/.test(k)) delete env[k];
  const transcriptPath = join(LOG_DIR, 'live-m3-claude-transcript.jsonl');
  writeFileSync(transcriptPath, '');
  const ct = spawnTree('claude -p', [claudeBin, '-p', prompt, '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', 'mcp__starlight', 'ToolSearch',
    // Anything not allowed above is refused without asking, built-in tools are denied outright, and only
    // the (empty) project's settings load, so the user's own permissions and hooks can't widen this.
    '--permission-mode', 'dontAsk', '--setting-sources', 'project',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill',
    '--model', 'sonnet', '--max-turns', '60', '--output-format', 'stream-json', '--verbose'],
  { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => killTree(ct));
  let resultMsg = null;
  let lines = 0;
  let toolUses = [];
  let obuf = '';
  ct.child.stdout.setEncoding('utf8');
  ct.child.stdout.on('data', (c) => {
    appendFileSync(transcriptPath, c);
    obuf += c;
    let nl;
    while ((nl = obuf.indexOf('\n')) !== -1) {
      const line = obuf.slice(0, nl); obuf = obuf.slice(nl + 1);
      if (!line.trim()) continue;
      lines++;
      try {
        const m = JSON.parse(line);
        if (m.type === 'result') resultMsg = m;
        for (const part of m.message?.content ?? []) if (part.type === 'tool_use') { toolUses.push(part.name); info(`claude → ${part.name} ${JSON.stringify(part.input).slice(0, 160)}`); }
      } catch { /* partial */ }
    }
  });
  let cerr = '';
  ct.child.stderr.setEncoding('utf8');
  ct.child.stderr.on('data', (c) => { cerr = (cerr + c).slice(-5000); });
  const exited = new Promise((r) => ct.child.once('exit', (code) => r(code)));

  // Play the player: Allow, Yes, and numbers read from /proc.
  const played = [];
  const wrongAttach = [];
  let running = true;
  const player = (async () => {
    while (running) {
      try {
        const st = await S(app, 'agentGetState()');
        if (st.approval && st.approval.pid === A.pid) { const t = await clickAllow(app); played.push(`allow: ${t}`); }
        else if (st.approval) {
          // Never let the agent attach to a process this script didn't spawn (the player's games are listed too).
          const r = await app.cdp.evaluate(`return $click('Deny', '[role=alertdialog][aria-label="Agent attach request"]');`);
          if (r !== 'clicked') await S(app, `agentRespondApproval({ id: ${JSON.stringify(st.approval.id)}, allow: false })`);
          wrongAttach.push(`${st.approval.pid} (${st.approval.game})`);
          played.push(`DENY: attach to pid ${st.approval.pid} ${st.approval.game}`);
        }
        for (const q of st.questions) {
          if (q.answer === 'confirm') {
            await app.cdp.evaluate(`location.hash = '#/agent'; return true;`);
            await clickYes(app); played.push(`yes: ${q.question}`);
          } else if (q.answer === 'number') {
            const v = readI32(A.pid, A.a.heap_value);
            await app.cdp.evaluate(`location.hash = '#/agent'; return true;`);
            await waitFor(() => app.cdp.evaluate(`return !!document.querySelector('input[aria-label="Your answer"]');`), 5000);
            await app.cdp.evaluate(`const i = document.querySelector('input[aria-label="Your answer"]'); $type(i, ${JSON.stringify(String(v))}); await new Promise((r) => setTimeout(r, 50)); i.form.requestSubmit(); return true;`);
            played.push(`number ${v}: ${q.question}`);
          } else {
            await S(app, `agentAnswer({ id: ${JSON.stringify(q.id)}, value: ${JSON.stringify(q.choices?.[0] ?? '')} })`);
            played.push(`choice ${q.choices?.[0]}: ${q.question}`);
          }
          await sleep(300);
        }
      } catch (e) { info(`player: ${e.message}`); }
      await sleep(300);
    }
  })();
  const code = await Promise.race([exited, sleep(30 * 60_000).then(() => 'timeout')]);
  const tExit = now();
  // R18: once the agent exits, the session is idle and the game isn't traced. Claude Code sends no
  // DELETE, so the host ends the session when its GET stream has been closed for 15 s (I1); allow 5 s more.
  const idle = await waitFor(async () => (await S(app, 'agentGetState()')).status === 'idle' && tracerPid(A.pid) === 0, 20_000, 100);
  const exitMs = now() - tExit;
  const stAfter = await S(app, 'agentGetState()');
  running = false;
  await player;
  info(`claude exit ${code}; ${lines} stream lines; tools: ${toolUses.join(', ')}`);
  for (const p of played) info(`player ${p}`);
  if (resultMsg) info(`result: subtype ${resultMsg.subtype}, turns ${resultMsg.num_turns}, cost $${resultMsg.total_cost_usd}, duration ${resultMsg.duration_ms} ms, usage ${JSON.stringify(resultMsg.usage)}`);
  if (resultMsg?.result) info(`claude said: ${String(resultMsg.result).replace(/\s+/g, ' ').slice(0, 600)}`);
  if (cerr.trim()) info(`claude stderr: ${cerr.replace(/\s+/g, ' ').slice(0, 400)}`);
  const origins = proxy.log.filter((l) => l.origin !== null);
  info(`claude MCP requests: ${proxy.log.length} (${[...new Set(proxy.log.map((l) => l.method))].join(',')}), user-agent ${proxy.log[0]?.ua}, Origin header ${origins.length ? `SENT (${origins[0].origin})` : 'never sent'}, DELETE ${proxy.log.some((l) => l.method === 'DELETE') ? 'sent' : 'not sent'}`);
  check('claude only asked to attach to the target pid it was given (others are denied)', wrongAttach.length === 0,
    wrongAttach.length ? `denied ${wrongAttach.join(', ')}` : `target ${A.pid}`);
  check('claude -p runs to the end', code === 0 && resultMsg?.subtype === 'success', `exit ${code}, ${resultMsg?.subtype}`);
  check('claude\'s MCP client never sends an Origin header', proxy.log.length > 0 && origins.length === 0, `${proxy.log.length} requests`);
  check('R18: within 20 s (15 s stream grace + 5 s) of claude exiting the agent session is idle and TracerPid is 0', !!idle,
    `${exitMs.toFixed(0)} ms, status ${stAfter.status}, TracerPid ${tracerPid(A.pid)}`);
  if (!idle) {
    // Record how long it takes after all (D4 gap), up to 60 s.
    const later = await waitFor(async () => (await S(app, 'agentGetState()')).status === 'idle', 60_000, 500);
    info(`D4 gap: session ${later ? 'went idle later' : 'still not idle after 60 s'}`);
  }

  // The library has an agent cheat whose address resolves to heap_value.
  const list = await S(app, `userCheatsList({ key: 'target', pid: ${A.pid} })`);
  const agentCheats = list.filter((v) => v.cheat.provenance?.kind === 'agent');
  const resolved = agentCheats.map((v) => {
    try { return { v, at: v.cheat.address ? hex(resolveSaved(A.pid, v.cheat.address)) : null }; } catch { return { v, at: null }; }
  });
  const good = resolved.find((r) => r.at === A.a.heap_value);
  check('a library cheat is saved and its address resolves to heap_value', !!good,
    resolved.map((r) => `${r.v.cheat.name} ${r.v.cheat.type} ${JSON.stringify(r.v.cheat.address)} → ${r.at}`).join(' | ') || `${list.length} cheat(s), none from the agent`);
  if (good) info(`saved cheat: ${JSON.stringify(good.v.cheat)}`);

  // After a restart it toggles from the game page.
  if (good) {
    stopTarget(A);
    await sleep(500);
    A = await spawnTarget(['--heap-chain']);
    await app.cdp.evaluate(`location.hash = '#/library'; return true;`);
    await waitFor(() => app.cdp.evaluate(`return !!document.querySelector(${JSON.stringify(TILE)});`), 20_000, 300);
    await app.cdp.evaluate(`document.querySelector(${JSON.stringify(TILE)}).click(); return true;`);
    const name = good.v.cheat.name;
    const sel = `[...document.querySelectorAll('section[aria-label="My cheats"] button[aria-pressed]')].find((x) => x.getAttribute('aria-label')?.startsWith(${JSON.stringify(name + ':')}))`;
    await waitFor(() => app.cdp.evaluate(`const b = ${sel}; return !!b && !b.disabled;`), 60_000, 500);
    const tg = await app.cdp.evaluate(`const b = ${sel}; if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';`);
    if (await waitFor(() => app.cdp.evaluate(`return !!document.querySelector('[role=alertdialog][aria-label="Close the Cheat Engine table"]');`), 4000, 150)) {
      await app.cdp.evaluate(`return $click('Continue', '[role=alertdialog][aria-label="Close the Cheat Engine table"]');`);
    }
    const on = await waitFor(() => app.cdp.evaluate(`return ${sel}?.getAttribute('aria-pressed') === 'true';`), 10_000, 200);
    await sleep(400);
    const want = good.v.cheat.type === 'freeze' ? Number(good.v.cheat.value) : null;
    const v = readI32(A.pid, A.a.heap_value);
    await app.cdp.evaluate(`const b = ${sel}; b?.click(); return true;`);
    const off = await waitFor(() => app.cdp.evaluate(`return ${sel}?.getAttribute('aria-pressed') === 'false';`), 10_000, 200);
    check('after a target restart the agent cheat toggles from the game page', tg === 'clicked' && on && off && (want === null || v === want),
      `toggle ${tg}, on ${on}, heap_value ${v}${want !== null ? ` (want ${want})` : ''}, off ${off}`);
  }
  await quitApp(app);
  writeFileSync(join(LOG_DIR, 'live-m3-claude-summary.json'), JSON.stringify({
    exit: code, lines, toolUses, played, result: resultMsg, proxy: proxy.log.map((l) => ({ method: l.method, origin: l.origin, ua: l.ua })),
    r18: { idle: !!idle, ms: exitMs, status: stAfter.status },
  }, null, 2));
}

// -------------------------------------------------------------------------------------- main

const mode = process.argv[2];
if (!['native', 'proton', 'claude'].includes(mode)) {
  console.error('usage: node scripts/live-m3.mjs native|proton|claude');
  process.exit(2);
}
try {
  await (mode === 'native' ? native() : mode === 'proton' ? proton() : claudeMode());
} catch (e) {
  failures++;
  console.log(`FAIL ${mode}: ${e.stack ?? e}`);
} finally {
  cleanupSync();
}
const n = (s) => results.filter((r) => r.status === s).length;
console.log(`${n('ok')} ok, ${n('FAIL') + (failures - n('FAIL'))} failed, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
