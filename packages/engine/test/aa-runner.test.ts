import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { compileAaScript, type StarlightPatchCheat } from '@starlight/ct-importer';
import { attach, type Session } from '../src/session.js';
import { read, readMany } from '../src/memory.js';
import { disassemble, makeSignature } from '../src/code.js';
import { enableCheat, resolveCheatAddress, checkAssembles, definedLabels, expandReadmem } from '../src/cheats.js';
import { EngineError, ScanError, RpcCode } from '../src/errors.js';
import type { SymbolRegistry } from '../src/types.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: bigint | number) => '0x' + n.toString(16);
/** The desktop's isStaleTableError test (ce-session.ts), so a missing AOB reads as a stale table. */
const STALE = /aob|not found/i;

interface Site {
  /** bump_counter's signature, unique in `target`. */
  pattern: string;
  address: string;
  /** The instructions a 5-byte jmp displaces, and their length. */
  displaced: string[];
  length: number;
  original: Buffer;
}

describe('compiled Auto Assembler cheats', () => {
  let engine: Awaited<ReturnType<typeof startTestEngine>>;
  let target: SpawnedTarget | undefined;
  let session: Session | undefined;

  beforeAll(async () => { engine = await startTestEngine(); });
  afterAll(async () => { await engine.stop(); });
  afterEach(async () => {
    await session?.detach();
    await target?.kill();
    session = undefined;
    target = undefined;
  });

  async function setup(args: string[] = ['--writer', '--heap-chain']): Promise<{ s: Session; t: SpawnedTarget; site: Site }> {
    target = await spawnTarget({ args });
    session = await attach(engine.client, target.pid);
    const s = session;
    const address = hex(BigInt(target.addresses.bump_counter!));
    const sig = await makeSignature(s, address);
    expect(sig.unique).toBe(true);
    const ins = await disassemble(s, address, 8);
    const displaced: string[] = [];
    let length = 0;
    for (const i of ins) { if (length >= 5) break; length += i.length; displaced.push(i.text); }
    const original = (await readMany(s, [{ address, length }]))[0]!;
    return { s, t: target, site: { pattern: sig.pattern, address, displaced, length, original } };
  }

  const counter = async (s: Session, t: SpawnedTarget) => (await read(s, t.addresses.g_counter!, 'int32')) as number;
  const bytesAt = async (s: Session, address: string, n: number) => (await readMany(s, [{ address, length: n }]))[0]!;
  const spaced = (b: Buffer) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

  /** CE's AOB-injection template around bump_counter, with the cave adding 99 per call. */
  function template(t: SpawnedTarget, site: Site, o: {
    scan?: string; cave?: string[]; disable?: string; extraEnable?: string[]; extraDisable?: string[];
  } = {}): string {
    const nops = site.length - 5;
    return [
      '[ENABLE]',
      o.scan ?? `aobscanmodule(INJECT,target,${site.pattern})`,
      'alloc(newmem,$1000,INJECT)',
      'label(code)',
      'label(return)',
      '',
      'newmem:',
      ...(o.cave ?? [`  add dword ptr [${t.addresses.g_counter!.slice(2)}],#99`]),
      'code:',
      ...site.displaced.map((l) => '  ' + l),
      '  jmp return',
      '',
      'INJECT:',
      '  jmp newmem',
      ...(nops > 0 ? [`  nop ${nops.toString(16)}`] : []),
      'return:',
      'registersymbol(INJECT)',
      ...(o.extraEnable ?? []),
      '',
      '[DISABLE]',
      'INJECT:',
      `  db ${o.disable ?? spaced(site.original)}`,
      '',
      'unregistersymbol(INJECT)',
      ...(o.extraDisable ?? []),
      'dealloc(newmem)',
    ].join('\n');
  }

  function compile(script: string): StarlightPatchCheat {
    const r = compileAaScript(script, { id: 'aa', name: 'AA test' });
    if (!r.ok) throw new Error(`compile failed: ${r.code} ${r.detail} (line ${r.line})`);
    expect(r.cheat).not.toBeNull();
    return r.cheat!;
  }

  it('definedLabels lists every label a segment defines, lowercased', () => {
    expect(definedLabels('code:\nmov eax,1\n  Return: nop\nmov rax,fs:[30]\njmp code')).toEqual(['code', 'return']);
  });

  it('runs the CE injection template: the cave adds 99 per tick; disable restores the bytes', async () => {
    const { s, t, site } = await setup();
    const c0 = await counter(s, t);
    await sleep(300);
    const normal = (await counter(s, t)) - c0;
    expect(normal).toBeGreaterThan(0);

    const run = await enableCheat(s, compile(template(t, site)), { symbols: new Map() });
    expect(run.kind).toBe('patch');
    expect(run.address).toBe(site.address);
    const c1 = await counter(s, t);
    await sleep(300);
    const delta = (await counter(s, t)) - c1;
    // Every call now adds 100 instead of 1.
    expect(delta % 100).toBe(0);
    expect(delta).toBeGreaterThanOrEqual(100 * Math.max(1, normal - 2));

    await run.disable();
    expect((await bytesAt(s, site.address, site.length)).equals(site.original)).toBe(true);
    const c2 = await counter(s, t);
    await sleep(300);
    expect((await counter(s, t)) - c2).toBeLessThan(50);
    await run.disable();
  });

  it('forward labels: newmem jumps to return defined in the later site segment', async () => {
    const { s, t, site } = await setup();
    const registry: SymbolRegistry = new Map();
    const run = await enableCheat(s, compile(template(t, site, { extraEnable: ['registersymbol(newmem)'] })), { symbols: registry });
    const cave = registry.get('newmem')!;
    expect(cave).toBeDefined();
    const ins = await disassemble(s, cave, 12);
    const jmp = ins.find((i) => /^jmp\b/i.test(i.text))!;
    expect(BigInt(jmp.target!.address)).toBe(BigInt(site.address) + BigInt(site.length));
    // And the site jumps into the cave.
    const entry = (await disassemble(s, site.address, 1))[0]!;
    expect(BigInt(entry.target!.address)).toBe(BigInt(cave));
    await run.disable();
  });

  it('registersymbol exports to the registry; disable with unregistersymbol removes it', async () => {
    const { s, t, site } = await setup();
    const registry: SymbolRegistry = new Map([['other', '0x1234']]);
    const run = await enableCheat(s, compile(template(t, site)), { symbols: registry });
    expect(registry.get('inject')).toBe(site.address);
    expect(registry.get('other')).toBe('0x1234');
    await run.disable();
    expect(registry.has('inject')).toBe(false);
    expect(registry.get('other')).toBe('0x1234');
  });

  it('a symbol value address reads through the registry', async () => {
    const { s, t } = await setup();
    const registry: SymbolRegistry = new Map([['pplayer', t.addresses.g_root!]]);
    const address = { kind: 'symbol' as const, expr: 'pPlayer', offsets: ['0x18', '0x10'] };
    const at = await resolveCheatAddress(s, address, { symbols: registry });
    expect(await read(s, at, 'int32')).toBe(777);
    const run = await enableCheat(s, {
      id: 'v', name: 'v', type: 'freeze', valueType: 'int32', value: 778, address,
    }, { symbols: registry, intervalMs: 20 });
    await sleep(80);
    expect(await read(s, at, 'int32')).toBe(778);
    await run.disable();
    await expect(resolveCheatAddress(s, address, { symbols: new Map() })).rejects.toThrow("symbol pPlayer isn't registered");
  });

  it('a failing second segment rolls back the first and registers nothing', async () => {
    const { s, t, site } = await setup();
    const registry: SymbolRegistry = new Map();
    const script = template(t, site, { extraEnable: ['registersymbol(newmem)'] }).replace('  jmp newmem', '  jmp newmem\n  mov eax,');
    const cheat = compile(script);
    expect(cheat.enable.filter((st) => st.op === 'assemble')).toHaveLength(2);
    const err = await enableCheat(s, cheat, { symbols: registry }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe(RpcCode.AssembleFailed);
    expect((await bytesAt(s, site.address, site.length)).equals(site.original)).toBe(true);
    expect([...registry.keys()]).toEqual([]);
  });

  it('a failure after a write reverts it and restores the registry', async () => {
    const { s, site } = await setup();
    const registry: SymbolRegistry = new Map([['inject', '0x42']]);
    const cheat: StarlightPatchCheat = {
      id: 'p', name: 'p', type: 'patch',
      site: { kind: 'aob', module: 'target', pattern: site.pattern },
      enable: [
        { op: 'aobScan', name: 'INJECT', module: 'target', pattern: site.pattern },
        { op: 'registerSymbol', name: 'INJECT', at: 'INJECT' },
        { op: 'writeBytes', at: 'INJECT', bytes: 'c3' },
        // A patch over bytes this cheat already patched conflicts in the daemon.
        { op: 'writeBytes', at: 'INJECT', bytes: '90' },
      ],
    };
    await expect(enableCheat(s, cheat, { symbols: registry })).rejects.toBeInstanceOf(EngineError);
    expect((await bytesAt(s, site.address, site.length)).equals(site.original)).toBe(true);
    expect([...registry]).toEqual([['inject', '0x42']]);
  });

  it('a missing aob is a ScanError whose message says not found', async () => {
    const { s, t, site } = await setup();
    const cheat = compile(template(t, site, { scan: 'aobscanmodule(INJECT,target,DE AD BE EF 13 37 C0 DE 99)' }));
    const err = await enableCheat(s, cheat, { symbols: new Map() }).catch((e) => e);
    expect(err).toBeInstanceOf(ScanError);
    expect(err.message).toBe('AOB INJECT not found in target');
    expect(err.message).toMatch(/not found/);
    expect(STALE.test(err.message)).toBe(true);

    const exec = compile(template(t, site, { scan: 'aobscan(INJECT,DE AD BE EF 13 37 C0 DE 99)' }));
    const e2 = await enableCheat(s, exec).catch((e) => e);
    expect(e2).toBeInstanceOf(ScanError);
    expect(e2.message).toBe('AOB INJECT not found in executable memory');
  });

  it("disable keeps the recorded original when the table's restore bytes differ", async () => {
    const { s, t, site } = await setup();
    const lines: string[] = [];
    const run = await enableCheat(s, compile(template(t, site, { disable: 'c3' })), { symbols: new Map(), log: (l) => lines.push(l) });
    await run.disable();
    expect((await bytesAt(s, site.address, site.length)).equals(site.original)).toBe(true);
    expect(lines).toEqual(["disable bytes at INJECT differ from the game's original; kept the original"]);
  });

  it('aobscan without a module runs on executable memory', async () => {
    const { s, t, site } = await setup();
    const cheat = compile(template(t, site, { scan: `aobscan(INJECT,${site.pattern})` }));
    expect(cheat.site).toBeUndefined();
    expect(cheat.enable[0]).toEqual({ op: 'aobScan', name: 'INJECT', pattern: site.pattern });
    const registry: SymbolRegistry = new Map();
    const run = await enableCheat(s, cheat, { symbols: registry });
    expect(registry.get('inject')).toBe(site.address);
    const c1 = await counter(s, t);
    await sleep(300);
    expect(((await counter(s, t)) - c1) % 100).toBe(0);
    expect((await counter(s, t)) - c1).toBeGreaterThanOrEqual(100);
    await run.disable();
    expect((await bytesAt(s, site.address, site.length)).equals(site.original)).toBe(true);
  });

  it('$process names the main module', async () => {
    const { s, t, site } = await setup();
    const cheat = compile(template(t, site, { scan: `aobscanmodule(INJECT,$process,${site.pattern})` }));
    expect(cheat.site?.module).toBe('$process');
    await expect(enableCheat(s, cheat)).rejects.toThrow(/\$process/);
    const registry: SymbolRegistry = new Map();
    const run = await enableCheat(s, cheat, { symbols: registry, mainModule: 'target' });
    expect(run.address).toBe(site.address);
    expect(registry.get('inject')).toBe(site.address);
    await run.disable();
    expect((await bytesAt(s, site.address, site.length)).equals(site.original)).toBe(true);
  });

  it('readmem copies the original bytes, read before the hook is written', async () => {
    const { s, t, site } = await setup();
    const registry: SymbolRegistry = new Map();
    const script = template(t, site, {
      extraEnable: ['alloc(copy,$100,INJECT)', 'copy:', `  readmem(INJECT,${site.length})`, '  db 90', 'registersymbol(copy)'],
    });
    const cheat = compile(script);
    expect(await checkAssembles(engine.client, cheat)).toEqual({ ok: true });
    const run = await enableCheat(s, cheat, { symbols: registry });
    const copy = registry.get('copy')!;
    expect((await bytesAt(s, copy, site.length + 1)).equals(Buffer.concat([site.original, Buffer.from([0x90])]))).toBe(true);
    expect((await bytesAt(s, site.address, 1))[0]).toBe(0xe9); // the hook is in
    await run.disable();
    expect((await bytesAt(s, site.address, site.length)).equals(site.original)).toBe(true);
  });

  it('expandReadmem turns readmem lines into db, with a decimal size by default', async () => {
    const seen: Array<[string, number]> = [];
    const read = async (expr: string, n: number) => { seen.push([expr, n]); return Buffer.alloc(n, 0xab); };
    expect(await expandReadmem('mov eax,1\n  readmem(INJECT+2, 3)\nREADMEM(x,$2)\njmp return', read))
      .toBe('mov eax,1\ndb ab ab ab\ndb ab ab\njmp return');
    expect(seen).toEqual([['INJECT+2', 3], ['x', 2]]);
    await expect(expandReadmem('readmem(x,0)', read)).rejects.toThrow(/out of range/);
  });

  it('checkAssembles passes the template and reports a bad instruction with its step', async () => {
    const { t, site } = await setup();
    const good = compile(template(t, site));
    expect(await checkAssembles(engine.client, good)).toEqual({ ok: true });
    // Labels, aob and alloc names are matched case-insensitively (R16).
    const mixed = compile(template(t, site).replace('  jmp return', '  jmp RETURN').replace('  jmp newmem', '  jmp NewMem'));
    expect(await checkAssembles(engine.client, mixed)).toEqual({ ok: true });

    const bad = compile(template(t, site, { cave: ['  fld st(0)'] }));
    expect(bad.enable[2]!.op).toBe('assemble');
    const r = await checkAssembles(engine.client, bad);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, step: 2 });
    expect((r as { message: string }).message).toMatch(/line 1/);

    // A table symbol is a placeholder only when the table registers it.
    const uses = compile(template(t, site, { cave: ['  mov rax,[pPlayer]'] }));
    expect((await checkAssembles(engine.client, uses)).ok).toBe(false);
    expect(await checkAssembles(engine.client, uses, { known: ['PPLAYER'] })).toEqual({ ok: true });
  });
});
