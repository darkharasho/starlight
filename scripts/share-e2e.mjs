#!/usr/bin/env node
// Local end-to-end check of cheat sharing: app share host → wrangler dev
// (the real Worker) → fake GitHub → Pages publish step → app community host.
// Nothing leaves this machine. Usage: node scripts/share-e2e.mjs
import { spawnSync } from 'node:child_process';

const r = spawnSync('pnpm', ['--filter', '@starlight/desktop', 'test', '--', '--maxWorkers=1', 'test/e2e/share.e2e.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SHARE_E2E: '1', NODE_BINARY: process.execPath },
});
process.exit(r.status ?? 1);
