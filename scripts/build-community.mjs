#!/usr/bin/env node
// Publishes community cheats into the Pages deploy:
//   node scripts/build-community.mjs <catalogDir> <deployCatalogDir>
// Reads <catalogDir>/community/<appId>/<hash12>.json, writes
// <deploy>/community/index.json and the files, and adds catalog entries for
// games that only have community cheats to <deploy>/index.json. A bad file is
// reported and left out; it never fails the deploy.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCommunity } from '../packages/catalog/dist/community.js';

const [catalogDir, deployDir] = process.argv.slice(2);
if (!catalogDir || !deployDir) {
  console.error('usage: build-community.mjs <catalogDir> <deployCatalogDir>');
  process.exit(2);
}

const src = join(catalogDir, 'community');
const files = [];
for (const app of await readdir(src, { withFileTypes: true }).catch(() => [])) {
  if (!app.isDirectory()) continue;
  for (const f of await readdir(join(src, app.name))) {
    if (!f.endsWith('.json')) continue;
    files.push({ path: `${app.name}/${f}`, text: await readFile(join(src, app.name, f), 'utf8') });
  }
}

const indexPath = join(deployDir, 'index.json');
const catalog = JSON.parse(await readFile(indexPath, 'utf8').catch(() => readFile(join(catalogDir, 'index.json'), 'utf8')));
const r = await buildCommunity(files, catalog, new Date());
for (const e of r.errors) console.error(`community: skipped ${e}`);

await mkdir(join(deployDir, 'community'), { recursive: true });
const published = new Set(r.index.games.flatMap((g) => g.cheats.map((c) => c.file)));
for (const f of files) {
  if (!published.has(f.path)) continue;
  await mkdir(join(deployDir, 'community', f.path.split('/')[0]), { recursive: true });
  await writeFile(join(deployDir, 'community', f.path), f.text);
}
await writeFile(join(deployDir, 'community', 'index.json'), JSON.stringify(r.index, null, 2) + '\n');
await writeFile(indexPath, JSON.stringify(r.catalog, null, 2) + '\n');
console.log(`community: ${published.size} cheats for ${r.index.games.length} games; ${r.catalog.games.length - catalog.games.length} new catalog entries`);
