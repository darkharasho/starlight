import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures/synthetic');

/* The CLI is built into dist/cli.js. The test builds the package first
 * via pnpm and then invokes node on the built script. */
function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'node',
    [resolve(HERE, '../dist/cli.js'), ...args],
    { encoding: 'utf8' },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('cli', () => {
  it('prints --help with usage and exits 0', () => {
    const r = runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout).toMatch(/--game-name/);
  });

  it('imports a fixture file and writes JSON output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ct-import-'));
    try {
      const out = join(tmp, 'out.json');
      const r = runCli([
        join(FIXTURES, 'basic-static.ct'),
        '--game-name', 'Test',
        '--process', 'target',
        '--out', out,
      ]);
      expect(r.code).toBe(0);
      const json = JSON.parse(readFileSync(out, 'utf8'));
      expect(json.schemaVersion).toBe(1);
      expect(json.game.name).toBe('Test');
      expect(json.categories[0].cheats).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exits non-zero when game-name is missing', () => {
    const r = runCli([join(FIXTURES, 'basic-static.ct'), '--process', 'target']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/required|game-name/i);
  });

  it('prints stats summary to stderr', () => {
    const r = runCli([
      join(FIXTURES, 'mixed-real-shape.ct'),
      '--game-name', 'Test', '--process', 'target',
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/total:\s*4/i);
    expect(r.stderr).toMatch(/supported:\s*3/i);
    expect(r.stderr).toMatch(/unsupported:\s*1/i);
  });
});
