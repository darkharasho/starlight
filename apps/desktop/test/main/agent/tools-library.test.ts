// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, VerifyResult } from '@starlight/engine';
import { libraryTools } from '../../../src/main/agent/tools-library.js';
import { loadUserTrainer } from '../../../src/main/user-cheats.js';
import type { AgentClient, AttachedContext, ToolContext, ToolDef } from '../../../src/main/agent/tools.js';
import type { GameIdentity } from '../../../src/main/game-identity.js';
import { connectTools } from './harness.js';

const CLIENT: AgentClient = { mcpSessionId: 's1', name: 'claude-code', version: '2.1.0', label: 'Claude' };
const GAME: GameIdentity = {
  pid: 10, name: '9 Kings', key: '9kings', exeName: '9Kings.exe', proton: true,
  steamAppId: 2784470, buildId: '17012345', exeHash: 'ab'.repeat(32), catalogId: 'cat-9kings',
};
const DRAFT = {
  name: 'Infinite gold', type: 'freeze', valueType: 'int32', value: 999,
  address: { kind: 'aob', module: 'target', pattern: '48 8B ?? 10', offset: '0x4' },
  verify: { range: { min: 0, max: 100000 } },
};
const OK: VerifyResult = { status: 'ok', reasons: [] };

let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); dirs = []; });

async function setup(o: { verify?: VerifyResult; catalog?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tl-'));
  dirs.push(dir);
  const verify = vi.fn(async () => o.verify ?? OK);
  const onSaved = vi.fn();
  const catalogTrainerFor = vi.fn(async () => (o.catalog ?? null) as never);
  const defs = libraryTools({ dir, verify: verify as never, onSaved, catalogTrainerFor, now: () => new Date('2026-11-23T12:00:00.000Z') });
  const ac = new AbortController();
  const attached = { gen: 1, session: { id: 'x' } as unknown as Session, signal: ac.signal, game: GAME, client: CLIENT, describe: async () => null, track: {} } as unknown as AttachedContext;
  const ctx: ToolContext = { mcpSessionId: 's1', client: CLIENT, attached };
  const tool = (n: string): ToolDef<any> => defs.find((d) => d.name === n)!; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { dir, verify, onSaved, catalogTrainerFor, defs, ctx, tool, stop: () => ac.abort() };
}

describe('save_cheat', () => {
  it('rejects absolute addresses with the exact message', async () => {
    const s = await setup();
    const bad = { ...DRAFT, address: { kind: 'absolute', address: '0x1000' } };
    await expect(s.tool('save_cheat').run({ cheat: bad }, s.ctx)).rejects.toThrow(
      "address: agent-made cheats can't use absolute addresses; use an aob, pointer or module address");
  });

  it('requires verify.range for value cheats', async () => {
    const s = await setup();
    const { verify: _v, ...noVerify } = DRAFT;
    await expect(s.tool('save_cheat').run({ cheat: noVerify }, s.ctx)).rejects.toThrow(/verify/);
    expect(s.verify).not.toHaveBeenCalled();
  });

  it('refuses a cheat that does not match the running game', async () => {
    const s = await setup({ verify: { status: 'needs-update', reasons: ['pattern not found', 'value 5000000 out of range'] } });
    await expect(s.tool('save_cheat').run({ cheat: DRAFT }, s.ctx)).rejects.toThrow(
      "This cheat doesn't match the running game: pattern not found; value 5000000 out of range");
    expect(await loadUserTrainer(s.dir, '9kings')).toBeNull();
    expect(s.onSaved).not.toHaveBeenCalled();
  });

  it('adds agent provenance with the build id and exe hash', async () => {
    const s = await setup();
    const r = await s.tool('save_cheat').run({ cheat: DRAFT }, s.ctx) as { saved: { id: string; name: string; game: string }; verify: VerifyResult };
    expect(r.saved).toEqual({ id: 'infinite-gold', name: 'Infinite gold', game: '9 Kings' });
    expect(r.verify).toEqual(OK);
    const t = await loadUserTrainer(s.dir, '9kings');
    const c = t!.categories[0]!.cheats[0]! as { provenance?: unknown };
    expect(c.provenance).toEqual({
      kind: 'agent', agent: 'claude-code 2.1.0', createdAt: '2026-11-23T12:00:00.000Z',
      game: { steamAppId: 2784470, buildId: '17012345', exeHash: 'ab'.repeat(32) },
    });
    expect(s.tool('save_cheat').summarize({ cheat: DRAFT }, r)).toBe('save_cheat "Infinite gold" → 9 Kings');
  });

  it('omits provenance game fields that are unknown', async () => {
    const s = await setup();
    s.ctx.attached!.game = { ...GAME, steamAppId: null, buildId: null, exeHash: null };
    await s.tool('save_cheat').run({ cheat: DRAFT }, s.ctx);
    const t = await loadUserTrainer(s.dir, '9kings');
    expect((t!.categories[0]!.cheats[0]! as { provenance?: { game: unknown } }).provenance!.game).toEqual({});
  });

  it('with replaces repairs the cheat in place', async () => {
    const s = await setup();
    await s.tool('save_cheat').run({ cheat: DRAFT }, s.ctx);
    const r = await s.tool('save_cheat').run({ cheat: { ...DRAFT, value: 5 }, replaces: 'infinite-gold' }, s.ctx) as { saved: { id: string } };
    expect(r.saved.id).toBe('infinite-gold');
    const t = await loadUserTrainer(s.dir, '9kings');
    expect(t!.categories[0]!.cheats).toHaveLength(1);
    expect((t!.categories[0]!.cheats[0] as { value?: number }).value).toBe(5);
  });

  it('tells the game page', async () => {
    const s = await setup();
    await s.tool('save_cheat').run({ cheat: DRAFT, category: 'Gold' }, s.ctx);
    expect(s.onSaved).toHaveBeenCalledWith('9kings');
  });

  it('does not save once the agent was stopped', async () => {
    const s = await setup();
    s.stop();
    await expect(s.tool('save_cheat').run({ cheat: DRAFT }, s.ctx)).rejects.toThrow(/Stopped by the player/);
    expect(await loadUserTrainer(s.dir, '9kings')).toBeNull();
  });

  it('caps category at 40 characters through the SDK', async () => {
    const s = await setup();
    const client = await connectTools(s.defs, { access: { require: async () => s.ctx.attached }, activity: { start: () => 1, finish: () => undefined } });
    const bad = await client.callTool({ name: 'save_cheat', arguments: { cheat: DRAFT, category: 'x'.repeat(41) } });
    expect(bad.isError).toBe(true);
  });
});

const CATALOG = {
  schemaVersion: 2, id: 'cat', game: { name: '9 Kings', processName: ['9Kings.exe'], platform: ['linux-proton'] }, metadata: {},
  categories: [{ name: 'Main', cheats: [
    { id: 'c1', name: 'God mode', type: 'freeze', valueType: 'int32', value: 1, address: { kind: 'module', module: 'target', offset: '0x10' } },
    { id: 'c2', name: 'Broken', unsupported: true, unsupportedReason: 'needs lua' },
  ] }],
};

describe('list_cheats', () => {
  it('returns library and catalog cheats with verify status, paged', async () => {
    const s = await setup({ catalog: CATALOG });
    await s.tool('save_cheat').run({ cheat: DRAFT }, s.ctx);
    await s.tool('save_cheat').run({ cheat: { ...DRAFT, name: 'More gold' } }, s.ctx);
    s.verify.mockClear();
    const r = await s.tool('list_cheats').run({ offset: 1, limit: 1 }, s.ctx) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.game).toEqual({ key: '9kings', name: '9 Kings', buildId: '17012345' });
    expect(r.library.count).toBe(2);
    expect(r.library.cheats).toHaveLength(1);
    expect(r.library.cheats[0]).toMatchObject({ id: 'more-gold', name: 'More gold', type: 'freeze', verify: OK });
    expect(r.library.cheats[0].cheat.name).toBe('More gold');
    expect(r.catalog.count).toBe(2);
    expect(r.catalog.cheats).toHaveLength(1);
    expect(r.catalog.cheats[0]).toMatchObject({ id: 'c2' });
    expect(s.verify).toHaveBeenCalledTimes(1); // only the page's supported cheats: library page only (c2 is unsupported)
  });

  it('lists unsupported catalog cheats with their reason', async () => {
    const s = await setup({ catalog: CATALOG });
    const r = await s.tool('list_cheats').run({ source: 'catalog' }, s.ctx) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.library).toEqual({ count: 0, cheats: [] });
    expect(r.catalog.cheats[0]).toMatchObject({ id: 'c1', name: 'God mode', type: 'freeze', verify: OK });
    expect(r.catalog.cheats[1]).toEqual({ id: 'c2', name: 'Broken', unsupported: 'needs lua', verify: { status: 'unverified', reasons: [] } });
  });

  it('works for a game with no catalog entry', async () => {
    const s = await setup();
    const r = await s.tool('list_cheats').run({}, s.ctx) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.catalog).toEqual({ count: 0, cheats: [] });
    expect(r.library).toEqual({ count: 0, cheats: [] });
  });
});
