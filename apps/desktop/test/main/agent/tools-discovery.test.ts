// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@starlight/engine';
import { discoveryTools } from '../../../src/main/agent/tools-discovery.js';
import type { AttachedContext, ActivitySink, ToolContext, ToolDef } from '../../../src/main/agent/tools.js';
import { connectTools } from './harness.js';

const MODS = [{ name: 'target', base: 0x400000, size: 0x100000 }];

function fakeCtx(o: { aborted?: boolean } = {}): { ctx: ToolContext; track: { pointerScan: ReturnType<typeof vi.fn> }; attached: AttachedContext } {
  const track = { pointerScan: vi.fn() };
  const ac = new AbortController();
  if (o.aborted) ac.abort();
  const attached = {
    gen: 3, session: { id: 'sess' } as unknown as Session, signal: ac.signal, track,
    game: {}, client: {},
    describe: async (a: string) => {
      const n = Number(BigInt(a));
      const m = MODS.find((x) => n >= x.base && n < x.base + x.size);
      return m ? `${m.name}+0x${(n - m.base).toString(16)}` : null;
    },
  } as unknown as AttachedContext;
  return { ctx: { mcpSessionId: 's1', client: { mcpSessionId: 's1', name: 'c', version: '1', label: 'C' }, attached }, track, attached };
}

function tool(defs: ToolDef<any>[], name: string): ToolDef<any> { return defs.find((d) => d.name === name)!; }
const sink = (): ActivitySink => ({ start: () => 1, finish: () => {} });
const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text;

function fakeEngine() {
  return {
    resolveAddressExpr: vi.fn(async (_s: unknown, e: string) => (e === 'target+0x10' ? '0x400010' : e)),
    scanFirst: vi.fn(async () => ({ scan: 7, count: 2 })),
    scanNext: vi.fn(async () => ({ count: 1 })),
    scanResults: vi.fn(async () => ({ count: 2, results: [{ address: '0x400020', value: '100' }, { address: '0x9000', value: null }] })),
    read: vi.fn(async () => 42),
    readMany: vi.fn(async () => [Buffer.from([0xde, 0xad])]),
    pointerScan: vi.fn(async () => ({ id: 5, count: 30, truncated: false })),
    pointerResults: vi.fn(async () => ({ count: 30, paths: [{ module: 'target', baseAddress: '0x4010', offsets: ['0x18', '0x10'] }] })),
    pointerRescan: vi.fn(async () => ({ count: 1 })),
    disassemble: vi.fn(async () => [{ address: '0x400010', length: 2, bytes: '90 90', text: 'jmp 0x400020', symbol: null, target: { address: '0x400020', symbol: null } }]),
    makeSignature: vi.fn(async () => ({ pattern: '48 8B ?? 10', module: 'target', length: 4, unique: true, matches: 1 })),
  };
}

describe('discovery tools', () => {
  it('scan_first includes results only when there are 50 or fewer', async () => {
    const e = fakeEngine();
    const defs = discoveryTools(e as never);
    const { ctx } = fakeCtx();
    const small = await tool(defs, 'scan_first').run({ type: 'int32', mode: 'exact', value: '100' }, ctx) as { scan: number; results?: unknown[] };
    expect(small.scan).toBe(7);
    expect(small.results).toEqual([
      { address: '0x400020', where: 'target+0x20', value: '100' },
      { address: '0x9000', where: null, value: null },
    ]);
    e.scanFirst.mockResolvedValueOnce({ scan: 8, count: 1204 });
    const big = await tool(defs, 'scan_first').run({ type: 'int32', mode: 'exact', value: '100' }, ctx) as Record<string, unknown>;
    expect(big).toEqual({ scan: 8, count: 1204 });
  });

  it('scan_results annotates addresses with module+offset and caps limit at 500', async () => {
    const e = fakeEngine();
    const defs = discoveryTools(e as never);
    const { ctx } = fakeCtx();
    await tool(defs, 'scan_first').run({ type: 'int32', mode: 'exact', value: '1' }, ctx);
    const r = await tool(defs, 'scan_results').run({ scan: 7, limit: 2 }, ctx) as { results: Array<{ where: string | null }> };
    expect(r.results[0]!.where).toBe('target+0x20');
    const client = await connectTools(defs, { access: { require: async () => ctx.attached }, activity: sink() });
    const bad = await client.callTool({ name: 'scan_results', arguments: { scan: 7, limit: 501 } });
    expect(bad.isError).toBe(true);
    const ok = await client.callTool({ name: 'scan_results', arguments: { scan: 7, limit: 500 } });
    expect(ok.isError).toBeFalsy();
  });

  it('scan_next on an unknown scan id is a tool error', async () => {
    const defs = discoveryTools(fakeEngine() as never);
    const { ctx } = fakeCtx();
    await expect(tool(defs, 'scan_next').run({ scan: 99, mode: 'changed' }, ctx)).rejects.toThrow('Unknown scan 99; start one with scan_first.');
    await expect(tool(defs, 'scan_results').run({ scan: 99 }, ctx)).rejects.toThrow('Unknown scan 99; start one with scan_first.');
    // another session's scan id is unknown too
    await tool(defs, 'scan_first').run({ type: 'int32', mode: 'exact', value: '1' }, ctx);
    const other = fakeCtx();
    await expect(tool(defs, 'scan_next').run({ scan: 7, mode: 'changed' }, other.ctx)).rejects.toThrow('Unknown scan 7');
    await expect(tool(defs, 'scan_next').run({ scan: 7, mode: 'changed' }, ctx)).resolves.toMatchObject({ count: 1 });
  });

  it('read resolves module expressions and requires length for bytes', async () => {
    const e = fakeEngine();
    const defs = discoveryTools(e as never);
    const { ctx } = fakeCtx();
    const r = await tool(defs, 'read').run({ address: 'target+0x10', type: 'int32' }, ctx);
    expect(e.resolveAddressExpr).toHaveBeenCalledWith(ctx.attached!.session, 'target+0x10');
    expect(r).toEqual({ address: '0x400010', where: 'target+0x10', value: '42' });
    await expect(tool(defs, 'read').run({ address: '0x400010', type: 'bytes' }, ctx)).rejects.toThrow(/length/);
    const b = await tool(defs, 'read').run({ address: '0x400010', type: 'bytes', length: 2 }, ctx) as { value: string };
    expect(b.value).toBe('dead');
  });

  it('read of a string uses the encoding and length as maxLength', async () => {
    const e = fakeEngine();
    e.read.mockResolvedValueOnce('hi' as never);
    const defs = discoveryTools(e as never);
    const { ctx } = fakeCtx();
    await tool(defs, 'read').run({ address: '0x400010', type: 'string', length: 16, encoding: 'utf-16le' }, ctx);
    expect(e.read).toHaveBeenCalledWith(ctx.attached!.session, '0x400010', { type: 'string', encoding: 'utf-16le', maxLength: 16 });
    await tool(defs, 'read').run({ address: '0x400010', type: 'string', length: 8 }, ctx);
    expect(e.read).toHaveBeenLastCalledWith(ctx.attached!.session, '0x400010', { type: 'string', encoding: 'utf-8', maxLength: 8 });
  });

  it('pointer_scan returns the first 20 paths with readable text and tracks the id', async () => {
    const e = fakeEngine();
    const defs = discoveryTools(e as never);
    const { ctx, track } = fakeCtx();
    const r = await tool(defs, 'pointer_scan').run({ address: '0x400010', max_offset: '0x2000' }, ctx) as { id: number; paths: Array<{ text: string }> };
    expect(e.pointerResults).toHaveBeenCalledWith(ctx.attached!.session, 5, { limit: 20 });
    expect(e.pointerScan.mock.calls[0]![1]).toMatchObject({ address: '0x400010', maxOffset: '0x2000' });
    expect(r.paths[0]).toEqual({ module: 'target', base: '0x4010', offsets: ['0x18', '0x10'], text: 'target+0x4010 → 0x18 → 0x10' });
    expect(track.pointerScan).toHaveBeenCalledWith(3, 5);
    const client = await connectTools(defs, { access: { require: async () => ctx.attached }, activity: sink() });
    expect((await client.callTool({ name: 'pointer_scan', arguments: { address: '0x1', max_offset: '0x10001' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'pointer_scan', arguments: { address: '0x1', max_depth: 8 } })).isError).toBe(true);
  });

  it('pointer_rescan returns the first 20 paths', async () => {
    const e = fakeEngine();
    const defs = discoveryTools(e as never);
    const { ctx } = fakeCtx();
    const r = await tool(defs, 'pointer_rescan').run({ id: 5, address: 'target+0x10' }, ctx) as { count: number; paths: unknown[] };
    expect(e.pointerRescan).toHaveBeenCalledWith(ctx.attached!.session, 5, '0x400010');
    expect(r.count).toBe(1);
    expect(r.paths).toHaveLength(1);
  });

  it('make_signature returns a ready aob address', async () => {
    const defs = discoveryTools(fakeEngine() as never);
    const { ctx } = fakeCtx();
    const r = await tool(defs, 'make_signature').run({ address: '0x400010' }, ctx) as { aob: unknown };
    expect(r.aob).toEqual({ kind: 'aob', module: 'target', pattern: '48 8B ?? 10' });
  });

  it('disassemble caps count at 100', async () => {
    const e = fakeEngine();
    const defs = discoveryTools(e as never);
    const { ctx } = fakeCtx();
    const client = await connectTools(defs, { access: { require: async () => ctx.attached }, activity: sink() });
    expect((await client.callTool({ name: 'disassemble', arguments: { address: '0x400010', count: 101 } })).isError).toBe(true);
    const ok = await client.callTool({ name: 'disassemble', arguments: { address: '0x400010', count: 100 } });
    expect(ok.isError).toBeFalsy();
    expect(e.disassemble).toHaveBeenCalledWith(ctx.attached!.session, '0x400010', 100);
    expect(JSON.parse(text(ok)).instructions[0]).toEqual({
      address: '0x400010', where: 'target+0x10', bytes: '90 90', text: 'jmp 0x400020', target: { address: '0x400020', where: 'target+0x20' },
    });
  });

  it('refuses to start once the context is stopped, and without an attach', async () => {
    const e = fakeEngine();
    const defs = discoveryTools(e as never);
    const { ctx } = fakeCtx({ aborted: true });
    await expect(tool(defs, 'disassemble').run({ address: '0x1' }, ctx)).rejects.toThrow(/Stopped by the player/);
    expect(e.disassemble).not.toHaveBeenCalled();
    await expect(tool(defs, 'read').run({ address: '0x1', type: 'int8' }, { ...ctx, attached: null })).rejects.toThrow(/Not attached/);
  });

  it('are read-only attached-tier tools', () => {
    for (const d of discoveryTools(fakeEngine() as never)) { expect(d.tier).toBe('attached'); expect(d.readOnly).toBe(true); }
  });

  it('summaries use the exact formats', async () => {
    const defs = discoveryTools(fakeEngine() as never);
    const s = (n: string, a: unknown, r: unknown): string => tool(defs, n).summarize(a, r);
    expect(s('scan_first', { type: 'int32', mode: 'exact', value: '100' }, { count: 1204 })).toBe('scan_first int32 exact 100 → 1,204 matches');
    expect(s('scan_first', { type: 'int32', mode: 'unknown' }, { count: 5 })).toBe('scan_first int32 unknown → 5 matches');
    expect(s('scan_next', { mode: 'increased' }, { count: 3 })).toBe('scan_next increased → 3 matches');
    expect(s('read', { address: 'x' }, { address: '0x1', where: 'target+0x1', value: '5' })).toBe('read target+0x1 = 5');
    expect(s('read', { address: 'x' }, { address: '0x1', where: null, value: '5' })).toBe('read 0x1 = 5');
    expect(s('pointer_scan', { address: 'target+0x10' }, { count: 30 })).toBe('pointer_scan target+0x10 → 30 paths');
    expect(s('make_signature', { address: 'target+0x10' }, { unique: true, matches: 1 })).toBe('make_signature target+0x10 → unique');
    expect(s('make_signature', { address: 'target+0x10' }, { unique: false, matches: 3 })).toBe('make_signature target+0x10 → 3 matches');
  });
});
