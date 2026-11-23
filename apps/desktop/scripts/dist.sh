#!/usr/bin/env bash
# Local AppImage build. Rebuilds better-sqlite3 for Electron to package it,
# then puts the Node build back so vitest keeps working. (frida and
# uiohook-napi are N-API modules and work in both as-is.)
set -u
cd "$(dirname "$0")/.."
status=0
electron-vite build \
  && electron-rebuild --only better-sqlite3 \
  && electron-builder --linux AppImage --publish never \
  || status=$?
# better-sqlite3 has no prebuild for every Node version, so build it from source.
(cd "$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")" && npx --yes node-gyp rebuild --release >/dev/null 2>&1) \
  || echo "warning: couldn't rebuild better-sqlite3 for Node; run 'pnpm rebuild better-sqlite3'" >&2
exit $status
