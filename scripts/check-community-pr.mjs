#!/usr/bin/env node
// CI check for a community cheat pull request. It never runs the cheat; it
// checks the pull request adds exactly one valid file under
// packages/catalog/community/ and that its description's summary describes
// exactly that file.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { checkCommunityPr } from '../packages/catalog/dist/community.js';

const base = process.env.GITHUB_BASE_REF || 'main';
const diff = execFileSync('git', ['diff', '--name-status', '--no-renames', `origin/${base}...HEAD`], { encoding: 'utf8' });
const changes = diff.split('\n').filter(Boolean).map((l) => {
  const [status, path] = l.split('\t');
  return { status: status.slice(0, 1), path };
});
const files = new Map();
for (const c of changes) {
  if (c.status === 'D') continue;
  files.set(c.path, await readFile(c.path, 'utf8').catch(() => ''));
}
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
const body = event.pull_request?.body ?? '';

const problems = await checkCommunityPr(changes, files, body);
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('community cheat: ok');
