#!/usr/bin/env node
// Live check for the Lua runtime (M1) against our own test target only: the debug starlightd,
// the C test target spawned here, and a .CT written at run time. It runs the same steps as the
// native backend: the table script, a deferred AA script whose {$lua} returns code, a record's
// own Lua script, and a table script that fails.
//
//   node scripts/live-lua.mjs
//
// Needs: `cargo build` in packages/starlightd, `make -C packages/engine/test-target`, and the
// ct-importer and engine packages built.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(join(ROOT, 'packages/engine/dist/index.js'));
const C = await import(join(ROOT, 'packages/ct-importer/dist/index.js'));
const DAEMON = join(ROOT, 'packages/starlightd/target/debug/starlightd');
const TARGET = join(ROOT, 'packages/engine/test-target/build/target');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Spawns the test target and reads its `addr name=0x…` listing. */
async function spawnTarget() {
  const child = spawn(TARGET, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  const addrs = {};
  const rl = createInterface({ input: child.stdout });
  await new Promise((res, rej) => {
    rl.on('line', (l) => {
      const m = /^addr (\w+)=(0x[0-9a-f]+)/i.exec(l);
      if (m) addrs[m[1]] = m[2];
      if (/^ready/.test(l) || addrs.g_after_aob) res();
    });
    child.on('exit', () => rej(new Error('target exited')));
  });
  return { child, pid: child.pid, addrs };
}

const dir = mkdtempSync(join(tmpdir(), 'starlight-live-lua-'));
const engine = await E.startEngine({ binary: DAEMON, socketPath: join(dir, 'sock') });
const target = await spawnTarget();
try {
  const s = await E.attach(engine.client, target.pid);
  const mods = await E.listModules(s);
  const main = mods.find((m) => m.name === 'target');
  const off = (BigInt(target.addrs.g_health) - BigInt(main.base)).toString(16);
  const entry = (id, name, inner) => `<CheatEntry><ID>${id}</ID><Description>"${name}"</Description>${inner}</CheatEntry>`;
  const xml = `<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries>
${entry(1, 'Health', '<VariableType>4 Bytes</VariableType><Address>pHealth</Address>')}
${entry(2, 'Lua cave', `<VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]
{$lua}
if syntaxcheck then return end
return "pHealth:\\ndd #777"
{$asm}
[DISABLE]
</AssemblerScript>`)}
${entry(3, 'Lua record', `<LuaScript>[ENABLE]
writeInteger("pHealth", 42)
[DISABLE]
writeInteger("pHealth", 100)</LuaScript>`)}
</CheatEntries><LuaScript>openProcess("target")
registerSymbol("pHealth", getAddress("target+${off}"))
writeInteger("pHealth", 500)</LuaScript></CheatTable>`;

  const t = C.compileTable(xml);
  check('table routes native', t.native, JSON.stringify(t.reasons));
  check('record 2 is deferred, record 3 is lua', t.records[1]?.script?.deferred !== undefined && t.records[2]?.kind === 'lua');

  // What native-backend does: one state, effects into the registry.
  const registry = new Map();
  const lua = await E.luaOpen(s, { process: 'target' });
  const run = async (chunk, name) => {
    const r = await lua.run(chunk, { name, symbols: registry });
    for (const e of r.effects) e.op === 'registerSymbol' ? registry.set(e.name.toLowerCase(), e.address) : registry.delete(e.name.toLowerCase());
    return r;
  };
  const health = async () => E.read(s, target.addrs.g_health, 'int32');

  const ts = await run(t.tableLua, 'table script');
  check('table script runs', ts.ok, ts.error);
  check('table script registered pHealth', registry.get('phealth') === target.addrs.g_health.toLowerCase(), registry.get('phealth'));
  check('table script wrote 500', (await health()) === 500, String(await health()));
  const v = await E.resolveCheatAddress(s, t.records[0].address, { symbols: registry, mainModule: 'target' });
  check('value record resolves through the registered name', v === target.addrs.g_health.toLowerCase(), v);

  const src = await C.expandLuaBlocks(t.records[1].script.deferred, ['pre', 'enable'], async (b) => {
    const r = await run(b.code, 'Lua cave');
    if (!r.ok) throw new Error(r.error);
    return r.returned;
  });
  const compiled = C.compileAaScript(src, { id: 'cave', name: 'Lua cave' });
  check('deferred script compiles after its Lua ran', compiled.ok && compiled.cheat, compiled.ok ? '' : compiled.detail);
  const on = await E.enableCheat(s, compiled.cheat, { symbols: registry, mainModule: 'target' });
  check('deferred script wrote 777', (await health()) === 777, String(await health()));
  await on.disable();
  check('disable restored 500', (await health()) === 500, String(await health()));

  const part = (code, sec) => code.split('\n').map((l) => (/^\s*\[(enable|disable)\]\s*$/i.test(l) ? (cur = l.trim().slice(1, -1).toLowerCase(), '') : (cur === sec ? l : ''))).join('\n');
  let cur = 'pre';
  const lr = await run(part(t.records[2].lua, 'enable'), 'Lua record');
  check('record Lua [ENABLE] wrote 42', lr.ok && (await health()) === 42, String(await health()));
  cur = 'pre';
  await run(part(t.records[2].lua, 'disable'), 'Lua record');
  check('record Lua [DISABLE] wrote 100', (await health()) === 100, String(await health()));

  const bad = await run('writeInteger("pHealth", 1)\nerror("boom")', 'table script');
  check('a failing script reports its line and keeps earlier effects', !bad.ok && bad.line === 2 && (await health()) === 1, JSON.stringify(bad));
  const loop = await run('while true do end', 'loop');
  check('an endless loop stops at the time limit', !loop.ok && /time limit/.test(loop.error), loop.error);

  await lua.close();
  await s.detach();
} finally {
  target.child.kill();
  await engine.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
