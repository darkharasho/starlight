#!/usr/bin/env node
// Builds better-sqlite3 for Electron's ABI. Runs on install, so `pnpm dev`,
// the tests (which run under Electron's Node, see package.json) and
// packaging all use the same build.
//
// Uses better-sqlite3's published Electron prebuild, and compiles from source
// only when there isn't one.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const sqliteDir = dirname(require.resolve('better-sqlite3/package.json'));
const electronVersion = require('electron/package.json').version;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: sqliteDir, stdio: 'inherit' });

try {
  const prebuildInstall = createRequire(join(sqliteDir, 'package.json')).resolve('prebuild-install/bin.js');
  run(process.execPath, [prebuildInstall, '--runtime', 'electron', '--target', electronVersion, '--arch', process.arch]);
} catch {
  console.warn(`native-electron: no better-sqlite3 prebuild for Electron ${electronVersion}; compiling it`);
  run('npx', ['--yes', 'node-gyp', 'rebuild', '--release', '--runtime=electron',
    `--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers']);
}
