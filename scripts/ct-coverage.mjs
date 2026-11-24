#!/usr/bin/env node
// Measures how many catalog .CT tables could run without Cheat Engine.
// Usage: node scripts/ct-coverage.mjs [--sample 400 | --all] [--fetch] [--compiler baseline|native]
//        [--assemble] [--json <file>] [--corpus <dir>]
// Without --fetch it makes no network requests and measures what is cached.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const compiler = opt('--compiler', 'baseline');
if (!['baseline', 'native'].includes(compiler)) { console.error(`unknown --compiler ${compiler}`); process.exit(2); }
if (flag('--assemble')) {
  // --compiler native --assemble also assembles every native script with the engine's
  // checkAssembles and counts failures as asm:error. That check arrives with the engine.
  if (compiler !== 'native') { console.error('--assemble needs --compiler native'); process.exit(2); }
  console.error("--assemble needs the engine's checkAssembles (Task 9)");
  process.exit(2);
}
const corpus = resolve(opt('--corpus', join(homedir(), '.cache', 'starlight', 'ct-coverage')));
const sample = flag('--all') ? Infinity : Number(opt('--sample', '400'));
const jsonOut = opt('--json', null);

const { measureTable, summarize } = await import(join(root, 'packages/indexer/dist/coverage.js'));

const catalog = JSON.parse(readFileSync(join(root, 'packages/catalog/index.json'), 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const selected = catalog.games
  .filter((g) => g.trainerSource)
  .map((g) => ({ id: g.id, source: g.trainerSource, key: sha(g.id) }))
  .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  .slice(0, sample);

mkdirSync(corpus, { recursive: true });
const manifestPath = join(corpus, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const ctPath = (id) => join(corpus, `${id}.ct`);

if (flag('--fetch')) {
  // fetchTrainer uses globalThis.fetch (two requests per forum thread), so the
  // polite-fetching guarantees live in a wrapper around it.
  const realFetch = globalThis.fetch;
  const UA = 'starlight-coverage/1';
  const SPACING = 2000;
  let last = 0;
  let blocked = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set('User-Agent', UA);
    for (let attempt = 0; ; attempt++) {
      const wait = last + SPACING - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let res;
      try {
        res = await realFetch(input, { ...init, headers });
      } catch (err) {
        if (attempt === 0) continue;
        throw err;
      }
      if (res.status === 403 || res.status === 429 || res.headers.get('cf-mitigated')) {
        blocked = `HTTP ${res.status}${res.headers.get('cf-mitigated') ? ' (Cloudflare challenge)' : ''}`;
        return res;
      }
      if (res.status >= 500 && attempt === 0) continue;
      return res;
    }
  };
  const { fetchTrainer } = await import(join(root, 'packages/indexer/dist/fetch.js'));
  const todo = selected.filter((g) => !manifest[g.id]);
  console.error(`fetching ${todo.length} of ${selected.length} (cached: ${selected.length - todo.length})`);
  let n = 0;
  for (const g of todo) {
    n += 1;
    try {
      const buf = await fetchTrainer(g.source);
      writeFileSync(ctPath(g.id), buf);
      manifest[g.id] = { id: g.id, source: g.source, sha256: sha(buf), fetchedAt: new Date().toISOString() };
    } catch (err) {
      if (blocked) {
        console.error(`STOP: forum is blocking requests (${blocked}); not recording ${g.id}, not retrying.`);
        break;
      }
      manifest[g.id] = { id: g.id, source: g.source, error: String(err?.message ?? err) };
    }
    if (blocked) { console.error(`STOP: forum is blocking requests (${blocked}).`); saveManifest(); break; }
    if (n % 10 === 0) { saveManifest(); console.error(`  ${n}/${todo.length}`); }
  }
  saveManifest();
}

const rows = [];
let failed = 0;
let missing = 0;
for (const g of selected) {
  const m = manifest[g.id];
  if (!m) { missing += 1; continue; }
  if (m.error || !existsSync(ctPath(g.id))) { failed += 1; continue; }
  try {
    rows.push(measureTable(g.id, readFileSync(ctPath(g.id), 'utf8'), compiler));
  } catch {
    failed += 1; // unparseable
  }
}

const report = summarize(rows, failed, compiler);
console.log(`compiler: ${compiler}   selected: ${selected.length}   missing (not fetched): ${missing}   failed: ${report.failed}`);
console.log(`tables:  ${report.tables.native}/${report.tables.total} native (${report.tables.pct}%)`);
console.log(`records: ${report.records.native}/${report.records.total} native (${report.records.pct}%)`);
console.log('top codes (tables / records):');
for (const c of report.byCode.slice(0, 15)) console.log(`  ${c.code.padEnd(18)} ${String(c.tables).padStart(5)} ${String(c.records).padStart(7)}`);
if (jsonOut) {
  mkdirSync(dirname(resolve(jsonOut)), { recursive: true });
  writeFileSync(resolve(jsonOut), JSON.stringify({ ...report, selected: selected.length, missing }, null, 2) + '\n');
}
