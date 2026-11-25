#!/usr/bin/env node
// Surveys the CE Lua functions the cached catalog tables call (the cache ct-coverage.mjs fills):
// how many tables Lua alone keeps on Cheat Engine, the most-called functions in those tables,
// and how many tables the top-N functions would unlock. Makes no network requests.
// Usage: node scripts/ct-lua-survey.mjs   (after building packages/ct-importer)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { compileTable } = await import(join(root, 'packages/ct-importer/dist/index.js'));
const dir = join(process.env.HOME, '.cache/starlight/ct-coverage');
const sel = new Set(JSON.parse(readFileSync(join(root,'packages/catalog/index.json'),'utf8')).games.filter(g=>g.trainerSource).map(g=>g.id));
const dec = (s)=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const LUA_KW = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
const STD = /^(string|table|math|os|io|utf8|coroutine|debug)\.|^(print|pairs|ipairs|tostring|tonumber|type|select|error|assert|pcall|xpcall|unpack|next|rawget|rawset|setmetatable|getmetatable|require|load|loadstring)$/;
function calls(lua) {
  const s = lua.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g,' ').replace(/--[^\n]*/g,' ').replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\[(=*)\[[\s\S]*?\]\2\]/g,'""');
  const defined = new Set([...s.matchAll(/function\s+([\w.:]+)/g)].map(m=>m[1].split(/[.:]/).pop()));
  for (const m of s.matchAll(/local\s+function\s+(\w+)/g)) defined.add(m[1]);
  const out = new Set();
  for (const m of s.matchAll(/([A-Za-z_][\w]*(?:[.:][A-Za-z_]\w*)*)\s*\(/g)) {
    let n = m[1]; if (LUA_KW.has(n)) continue;
    const last = n.split(/[.:]/).pop(); if (defined.has(last) || defined.has(n)) continue;
    if (STD.test(n)) continue;
    // method calls on objects: keep the method name
    if (/[.:]/.test(n) && !/^(getAddressList|getMainForm|AddressList|memrec|MainForm)/.test(n)) n = '.'+last;
    out.add(n.toLowerCase());
  }
  for (const m of s.matchAll(/\b(memrec|getAddressList\(\)|AddressList)\b[.:](\w+)/gi)) out.add('memrec.'+m[2].toLowerCase());
  return out;
}
const perTable = {}; // table -> {fns:Set, other: bool}
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.ct')) continue; const id=f.slice(0,-3); if(!sel.has(id)) continue;
  const xml = readFileSync(join(dir,f),'utf8'); let t; try { t = compileTable(xml); } catch { continue; }
  const fns = new Set(); let other = false;
  const tl = dec(/<\/CheatEntries>\s*<UserdefinedSymbols[\s\S]*?<LuaScript>([\s\S]*?)<\/LuaScript>\s*<\/CheatTable>/.exec(xml)?.[1] ?? '');
  const scripts = {}; for (const m of xml.matchAll(/<ID>(\d+)<\/ID>[\s\S]*?<AssemblerScript>([\s\S]*?)<\/AssemblerScript>/g)) scripts[m[1]] = dec(m[2]);
  const recLua = {}; for (const m of xml.matchAll(/<ID>(\d+)<\/ID>(?:(?!<CheatEntry>)[\s\S])*?<LuaScript>([\s\S]*?)<\/LuaScript>/g)) recLua[m[1]] = dec(m[2]);
  for (const r of t.reasons) {
    if (r.code === 'lua:table-script') calls(tl).forEach(x=>fns.add(x));
    else if (r.code === 'lua:block') { for (const b of (scripts[r.recordId]??'').matchAll(/\{\$lua\}([\s\S]*?)(?:\{\$asm\}|$)/gi)) calls(b[1]).forEach(x=>fns.add(x)); }
    else if (r.code === 'lua:script') calls(recLua[r.recordId]??'').forEach(x=>fns.add(x));
    else if (r.code === 'aa:luacall') { fns.add('?luacall'); }
    else if (r.code !== 'sym:unresolved') other = true;
  }
  perTable[id] = { fns, other, lua: t.reasons.some(r=>r.code.startsWith('lua:')) };
}
const lua = Object.entries(perTable).filter(([,v])=>v.lua);
const clean = lua.filter(([,v])=>!v.other);
console.log('tables', Object.keys(perTable).length, 'with lua', lua.length, 'lua is the only non-symbol blocker', clean.length);
const freq = {}; for (const [,v] of clean) for (const f of v.fns) freq[f]=(freq[f]??0)+1;
console.log(Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,60).map(([k,v])=>`${v} ${k}`).join('\n'));
// greedy: tables unlocked as top-N functions are supported
const order = Object.entries(freq).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
for (const n of [10,20,30,40,60,80,120]) { const S=new Set(order.slice(0,n)); console.log(`top ${n}:`, clean.filter(([,v])=>[...v.fns].every(f=>S.has(f))).length); }
