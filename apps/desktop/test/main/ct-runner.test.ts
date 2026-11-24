// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EngineClient } from '@starlight/engine';
import { routeTable, recordRoute, routeSummary } from '../../src/main/ct-runner.js';

const FIXTURES = join(__dirname, '../../../../packages/ct-importer/test/fixtures/tables');
const fixture = (name: string) => join(FIXTURES, name);

const client = { closed: false } as unknown as EngineClient;
const ok = vi.fn(async () => ({ ok: true as const }));

function deps(extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  return {
    lines,
    d: {
      getClient: async () => client, enabled: true, check: ok as never, log: (l: string) => lines.push(l), label: 'k#0',
      ...extra,
    },
  };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ct-runner-')); ok.mockClear(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('ct-runner', () => {
  it('a fully compiling table routes native and logs it', async () => {
    const { d, lines } = deps();
    const r = await routeTable(fixture('dropdown-hotkeys.CT'), d);
    expect(r).toMatchObject({ engine: 'native', codes: {}, first: null, records: 3 });
    expect(r.compiled?.native).toBe(true);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lines).toEqual(['[ct-runner] k#0: native (3 records)']);

    // Every compiled script is pre-assembled through the daemon.
    const scripts = deps();
    const s = await routeTable(fixture('native-ok.CT'), scripts.d);
    expect(s.engine).toBe('native');
    expect(ok).toHaveBeenCalledTimes(1);
    expect((ok.mock.calls[0] as unknown[])[0]).toBe(client);
    expect(scripts.lines).toEqual(['[ct-runner] k#0: native (4 records)']);
  });

  it('a Lua record routes the whole table to CE with its code', async () => {
    const { d, lines } = deps();
    const r = await routeTable(fixture('with-lua-record.CT'), d);
    expect(r).toMatchObject({
      engine: 'ce', codes: { 'lua:block': 1 }, records: 2,
      first: { recordId: 2, name: 'Lua inside AA', code: 'lua:block' },
    });
    expect(ok).not.toHaveBeenCalled();
    expect(lines).toEqual(['[ct-runner] k#0: ce (lua:block ×1)']);
  });

  it('an instruction the assembler rejects routes CE as asm:error', async () => {
    const check = vi.fn(async () => ({ ok: false as const, step: 2, message: 'unknown instruction: vfmadd231ps' }));
    const { d, lines } = deps({ check });
    const r = await routeTable(fixture('native-ok.CT'), d);
    expect(r).toMatchObject({
      engine: 'ce', codes: { 'asm:error': 1 },
      first: { recordId: 5, name: 'Infinite ammo', code: 'asm:error', detail: 'unknown instruction: vfmadd231ps' },
    });
    expect(lines).toEqual(['[ct-runner] k#0: ce (asm:error ×1)']);
    expect(routeSummary(r)!.first!.copy).toBe("A script uses an instruction Starlight can't assemble yet.");
  });

  it('an unreachable engine routes CE', async () => {
    const { d, lines } = deps({ getClient: async () => { throw new Error('connect ENOENT'); } });
    const r = await routeTable(fixture('native-ok.CT'), d);
    expect(r).toMatchObject({ engine: 'ce', codes: {}, first: { detail: 'engine unavailable' } });
    expect(lines).toEqual(['[ct-runner] k#0: ce (engine unavailable)']);

    // The connection dropping mid-check is the same.
    const dropped = deps({ check: vi.fn(async () => { throw new Error('connection closed'); }) });
    expect(await routeTable(fixture('native-ok.CT'), dropped.d)).toMatchObject({ engine: 'ce', first: { detail: 'engine unavailable' } });
  });

  it('turned off in Settings routes CE', async () => {
    const getClient = vi.fn(async () => client);
    const { d, lines } = deps({ enabled: false, getClient });
    const r = await routeTable(fixture('dropdown-hotkeys.CT'), d);
    expect(r).toMatchObject({ engine: 'ce', compiled: null, codes: {}, first: { recordId: null, detail: 'turned off in Settings' } });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(getClient).not.toHaveBeenCalled();
    expect(lines).toEqual(['[ct-runner] k#0: ce (turned off in Settings)']);
  });

  it('recordRoute counts each table once by sha256', async () => {
    const file = join(dir, 'ct-routing.json');
    const native = await routeTable(fixture('dropdown-hotkeys.CT'), deps().d);
    const ce = await routeTable(fixture('with-lua-record.CT'), deps().d);
    await recordRoute(file, native);
    await recordRoute(file, native);
    await recordRoute(file, ce);
    const j = JSON.parse(await readFile(file, 'utf8'));
    expect(j).toEqual({
      version: 1,
      tables: { native: 1, ce: 1 },
      records: { native: 3, ce: 2 },
      reasons: { 'lua:block': 1 },
      seen: [native.sha256, ce.sha256],
    });
  });

  it('recordRoute starts over from a corrupt file and keeps at most 2000 shas', async () => {
    const file = join(dir, 'ct-routing.json');
    await writeFile(file, '{nope');
    const d = await routeTable(fixture('dropdown-hotkeys.CT'), deps().d);
    const seen = Array.from({ length: 2000 }, (_, i) => `s${i}`);
    await recordRoute(file, d);
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), seen }));
    await recordRoute(file, d);
    const j = JSON.parse(await readFile(file, 'utf8'));
    expect(j.tables).toEqual({ native: 2, ce: 0 });
    expect(j.seen).toHaveLength(2000);
    expect(j.seen[0]).toBe('s1');
    expect(j.seen.at(-1)).toBe(d.sha256);
  });
});
