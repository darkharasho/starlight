#!/usr/bin/env node
// Cut a desktop release: bump apps/desktop's version, commit, tag v<version>
// and push. The tag push starts .github/workflows/release.yml.
//
//   pnpm release patch|minor|major|<x.y.z>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'apps/desktop/package.json');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

const bump = process.argv[2];
if (!bump) fail('usage: pnpm release patch|minor|major|<x.y.z>');

if (git('branch', '--show-current') !== 'main') fail('releases are cut from main.');
if (git('status', '--porcelain')) fail('the working tree has uncommitted changes.');
git('fetch', 'origin', 'main', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not in sync with origin/main.');

const pkgText = readFileSync(pkgPath, 'utf8');
const current = JSON.parse(pkgText).version;
const [maj, min, pat] = current.split('.').map(Number);
const next =
  bump === 'major' ? `${maj + 1}.0.0` :
  bump === 'minor' ? `${maj}.${min + 1}.0` :
  bump === 'patch' ? `${maj}.${min}.${pat + 1}` :
  /^\d+\.\d+\.\d+$/.test(bump) ? bump :
  fail(`unknown bump "${bump}"`);

const tag = `v${next}`;
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists.`);

writeFileSync(pkgPath, pkgText.replace(`"version": "${current}"`, `"version": "${next}"`));
git('add', pkgPath);
git('commit', '-m', `chore(release): ${tag}`);
git('tag', '-a', tag, '-m', tag);
git('push', '--atomic', 'origin', 'main', tag);

console.log(`Pushed ${tag} (${current} -> ${next}). The Release workflow is building it:`);
console.log('  https://github.com/darkharasho/starlight/actions/workflows/release.yml');
