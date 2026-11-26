import { describe, it, expect } from 'vitest';
import type { EngineClient } from '../src/client.js';
import { attach } from '../src/session.js';
import { processInfo } from '../src/process-info.js';
import { checkAssembles } from '../src/cheats.js';
import { compileAaScript } from '@starlight/ct-importer';

/** A client that records every call and answers from `answers`. */
function fake(answers: Record<string, (p: any) => unknown>) {
  const calls: Array<{ method: string; params: any }> = [];
  const client: EngineClient = {
    async call<T>(method: string, params: object): Promise<T> {
      calls.push({ method, params });
      const a = answers[method];
      if (!a) throw new Error(`unexpected ${method}`);
      return a(params) as T;
    },
    onNotification: () => () => {},
    onClose: () => {},
    close: async () => {},
    closed: false,
    capabilities: [],
  };
  return { client, calls };
}

describe('bitness', () => {
  it('attach sends main_module and exposes processBits', async () => {
    const f = fake({ attach: () => ({ handle: 1, process_bits: 32, code_bits: null }) });
    const s = await attach(f.client, 42, { mainModule: 'game.exe' });
    expect(s.processBits).toBe(32);
    expect(f.calls[0]).toEqual({ method: 'attach', params: { pid: 42, main_module: 'game.exe' } });
    const g = fake({ attach: () => ({ handle: 1, process_bits: 64, code_bits: 64 }) });
    await attach(g.client, 42);
    expect(g.calls[0]!.params).toEqual({ pid: 42 });
  });

  it('codeBits calls target_info', async () => {
    const f = fake({
      attach: () => ({ handle: 7, process_bits: 64, code_bits: null }),
      target_info: () => ({ process_bits: 64, code_bits: 32 }),
    });
    const s = await attach(f.client, 1);
    expect(await s.codeBits()).toBe(32);
    expect(f.calls[1]).toEqual({ method: 'target_info', params: { handle: 7 } });
  });

  it('checkAssembles passes bits to every assemble', async () => {
    const r = compileAaScript('[ENABLE]\nalloc(newmem,100)\nnewmem:\npushad\npopad\nret\n[DISABLE]\nnewmem:\nnop\ndealloc(newmem)\n', { id: 'b', name: 'bits' });
    if (!r.ok) throw new Error(`compile failed: ${r.code} ${r.detail}`);
    const cheat = r.cheat!;
    const f = fake({ assemble: () => ({ bytes: '90', labels: {} }) });
    expect(await checkAssembles(f.client, cheat, { bits: 32 })).toEqual({ ok: true });
    const asm = f.calls.filter((c) => c.method === 'assemble');
    expect(asm.length).toBeGreaterThan(0);
    for (const c of asm) expect(c.params.bits).toBe(32);
    const g = fake({ assemble: () => ({ bytes: '90', labels: {} }) });
    await checkAssembles(g.client, cheat);
    for (const c of g.calls) expect('bits' in c.params).toBe(false);
  });

  it('processInfo maps snake_case', async () => {
    const f = fake({ process_info: () => ({ process_bits: 64, code_bits: null }) });
    expect(await processInfo(f.client, 9, 'w32.exe')).toEqual({ processBits: 64, codeBits: null });
    expect(f.calls[0]!.params).toEqual({ pid: 9, main_module: 'w32.exe' });
    const g = fake({ process_info: () => ({ process_bits: 32, code_bits: 32 }) });
    expect(await processInfo(g.client, 9)).toEqual({ processBits: 32, codeBits: 32 });
    expect(g.calls[0]!.params).toEqual({ pid: 9 });
  });
});
