import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { StarlightValueCheat, StarlightPatchCheat } from '@starlight/ct-importer';
import { attach, type Session } from '../src/session.js';
import { read, write, readMany } from '../src/memory.js';
import { assemble, disassemble, makeSignature } from '../src/code.js';
import { listModules } from '../src/modules.js';
import {
  parseAddressExpr, resolveAddressExpr, verifyCheat, enableCheat,
} from '../src/cheats.js';
import { NeedsUpdateError, EngineError, ScanError, RpcCode } from '../src/errors.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: bigint | number) => '0x' + n.toString(16);

describe('v2 cheats: verify and run', () => {
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

  async function setup(args: string[]): Promise<{ s: Session; t: SpawnedTarget }> {
    target = await spawnTarget({ args });
    session = await attach(engine.client, target.pid);
    return { s: session, t: target };
  }
  const counter = async (s: Session, t: SpawnedTarget) => (await read(s, t.addresses.g_counter!, 'int32')) as number;
  const bytesAt = async (s: Session, address: string, n: number) => (await readMany(s, [{ address, length: n }]))[0]!;

  const valueCheat = (over: Partial<StarlightValueCheat>): StarlightValueCheat => ({
    id: 'c', name: 'c', type: 'freeze', valueType: 'int32', value: 999,
    address: { kind: 'absolute', address: '0x0' }, ...over,
  } as StarlightValueCheat);

  async function patchSite(s: Session, t: SpawnedTarget) {
    const sig = await makeSignature(s, t.addresses.bump_counter!);
    const base = BigInt((await listModules(s)).find((m) => m.name === 'target')!.base);
    expect(sig.unique).toBe(true);
    return { sig, base, site: { kind: 'aob' as const, module: 'target', pattern: sig.pattern } };
  }
  const patchCheat = (site: StarlightPatchCheat['site'], enable: StarlightPatchCheat['enable'], over: Partial<StarlightPatchCheat> = {}): StarlightPatchCheat => ({
    id: 'p', name: 'p', type: 'patch', site, enable, verify: {}, ...over,
  });

  it('parseAddressExpr reads hex, module+hex and quoted module names', () => {
    expect(parseAddressExpr('0x10')).toEqual({ module: null, offset: 16n });
    expect(parseAddressExpr('target+0x1A')).toEqual({ module: 'target', offset: 26n });
    expect(parseAddressExpr('GameAssembly.dll+1A2B')).toEqual({ module: 'GameAssembly.dll', offset: 0x1a2bn });
    expect(parseAddressExpr('"My Game.exe"+10')).toEqual({ module: 'My Game.exe', offset: 16n });
    expect(parseAddressExpr('foo')).toBeNull();
    expect(parseAddressExpr('10')).toBeNull();
  });

  it('resolveAddressExpr rejects a module that is not loaded with ModuleNotFound', async () => {
    const { s } = await setup([]);
    const err = await resolveAddressExpr(s, 'nope.dll+10').catch((e) => e);
    expect(err).toBeInstanceOf(ScanError);
    expect(err.code).toBe(RpcCode.ModuleNotFound);
  });

  it('verifies a pointer cheat in range and flags one out of range (--heap-chain)', async () => {
    const { s, t } = await setup(['--heap-chain']);
    const base = BigInt((await listModules(s)).find((m) => m.name === 'target')!.base);
    const address = { kind: 'pointer' as const, module: 'target', baseOffset: hex(BigInt(t.addresses.g_root!) - base), offsets: ['0x18', '0x10'] };
    expect(await verifyCheat(s, valueCheat({ address, verify: { range: { min: 0, max: 1000 } } })))
      .toEqual({ status: 'ok', reasons: [] });
    expect(await verifyCheat(s, valueCheat({ address, verify: { range: { min: 0, max: 100 } } })))
      .toEqual({ status: 'needs-update', reasons: ['the value is 777, outside 0–100'] });
  });

  it('aob that matches twice needs updating', async () => {
    const { s } = await setup([]);
    const cheat = valueCheat({ address: { kind: 'aob', module: 'target', pattern: '00 00 00 00' }, verify: {} });
    const r = await verifyCheat(s, cheat);
    expect(r.status).toBe('needs-update');
    expect(r.reasons[0]).toMatch(/matches \d+ places in target/);
  });

  it('an aob that matches nothing needs updating', async () => {
    const { s } = await setup([]);
    const cheat = valueCheat({ address: { kind: 'aob', module: 'target', pattern: 'DE AD BE EF 13 37 C0 DE' }, verify: {} });
    expect(await verifyCheat(s, cheat)).toEqual({
      status: 'needs-update', reasons: ["the AOB pattern isn't in target any more"],
    });
  });

  it('a cheat whose module is not loaded needs updating', async () => {
    const { s } = await setup([]);
    const cheat = valueCheat({ address: { kind: 'module', module: 'gone.dll', offset: '0x10' }, verify: {} });
    expect(await verifyCheat(s, cheat)).toEqual({ status: 'needs-update', reasons: ["gone.dll isn't loaded"] });
  });

  it('a cheat without verify is unverified even when its AOB is gone', async () => {
    const { s } = await setup([]);
    const cheat = valueCheat({ address: { kind: 'aob', module: 'target', pattern: 'DE AD BE EF 13 37 C0 DE' } });
    expect(await verifyCheat(s, cheat)).toEqual({ status: 'unverified', reasons: [] });
  });

  it('verify.bytes compares against the live bytes', async () => {
    const { s, t } = await setup([]);
    const address = { kind: 'absolute' as const, address: t.addresses.g_health! };
    expect((await verifyCheat(s, valueCheat({ address, verify: { bytes: [{ expect: '64 00 ?? ??' }] } }))).status).toBe('ok');
    const bad = await verifyCheat(s, valueCheat({ address, verify: { bytes: [{ expect: '01 02' }] } }));
    expect(bad.status).toBe('needs-update');
    expect(bad.reasons[0]).toMatch(/^the bytes at site are .*, expected 01 02$/);
  });

  it('enables a freeze cheat; disable lets the game change it again', async () => {
    const { s, t } = await setup([]);
    const cheat = valueCheat({ address: { kind: 'absolute', address: t.addresses.g_health! }, value: 999 });
    const run = await enableCheat(s, cheat);
    expect(run.kind).toBe('value');
    await write(s, t.addresses.g_health!, 'int32', 5);
    await sleep(200);
    expect(await read(s, t.addresses.g_health!, 'int32')).toBe(999);
    await run.setValue(321);
    await sleep(200);
    expect(await read(s, t.addresses.g_health!, 'int32')).toBe(321);
    await run.disable();
    await run.disable();
    await write(s, t.addresses.g_health!, 'int32', 5);
    await sleep(200);
    expect(await read(s, t.addresses.g_health!, 'int32')).toBe(5);
  });

  it('patch writeBytes ret at bump_counter stops g_counter; disable restores the bytes (--writer)', async () => {
    const { s, t } = await setup(['--writer']);
    const { sig, base, site } = await patchSite(s, t);
    const siteAddr = hex(BigInt(t.addresses.bump_counter!));
    expect(sig.module).toBe('target');
    void base;
    const original = (await bytesAt(s, siteAddr, 1)).toString('hex');
    const run = await enableCheat(s, patchCheat(site, [{ op: 'writeBytes', at: 'site', bytes: 'c3', original }]));
    expect(run.kind).toBe('patch');
    await expect(run.setValue(1)).rejects.toBeInstanceOf(EngineError);
    const frozen = await counter(s, t);
    await sleep(300);
    expect(await counter(s, t)).toBe(frozen);
    await run.disable();
    await run.disable();
    expect((await bytesAt(s, siteAddr, 1)).toString('hex')).toBe(original);
    await sleep(300);
    expect(await counter(s, t)).toBeGreaterThan(frozen);
  });

  it('patch with alloc + assemble + registerSymbol runs a code cave', async () => {
    const { s, t } = await setup(['--writer']);
    const { site } = await patchSite(s, t);
    const siteAddr = hex(BigInt(t.addresses.bump_counter!));
    const ins = await disassemble(s, siteAddr, 8);
    let len = 0;
    const displaced: string[] = [];
    for (const i of ins) { if (len >= 5) break; len += i.length; displaced.push(i.text); }
    const originals = await bytesAt(s, siteAddr, len);
    const cave = `add dword ptr [${t.addresses.g_health!}],1\n${displaced.join('\n')}\njmp return`;
    const run = await enableCheat(s, patchCheat(site, [
      { op: 'alloc', name: 'newmem', size: 256, near: 'site' },
      { op: 'registerSymbol', name: 'return', at: `site+${len.toString(16)}` },
      { op: 'assemble', at: 'newmem', source: cave },
      { op: 'assemble', at: 'site', source: 'jmp newmem\n' + Array(len - 5).fill('nop').join('\n') },
    ]));
    const h0 = (await read(s, t.addresses.g_health!, 'int32')) as number;
    await sleep(400);
    expect((await read(s, t.addresses.g_health!, 'int32')) as number).toBeGreaterThan(h0);
    await run.disable();
    expect((await bytesAt(s, siteAddr, len)).equals(originals)).toBe(true);
    const h1 = (await read(s, t.addresses.g_health!, 'int32')) as number;
    await sleep(300);
    expect(await read(s, t.addresses.g_health!, 'int32')).toBe(h1);
  });

  it('a failing step rolls back the earlier ones', async () => {
    const { s, t } = await setup(['--writer']);
    const { site } = await patchSite(s, t);
    const siteAddr = hex(BigInt(t.addresses.bump_counter!));
    const before = await bytesAt(s, siteAddr, 4);
    const err = await enableCheat(s, patchCheat(site, [
      { op: 'writeBytes', at: 'site', bytes: 'c3' },
      { op: 'assemble', at: 'site+1', source: 'mov eax,' },
    ])).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe(RpcCode.AssembleFailed);
    expect((await bytesAt(s, siteAddr, 4)).equals(before)).toBe(true);
  });

  it('an unknown symbol is an EngineError and rolls back', async () => {
    const { s, t } = await setup(['--writer']);
    const { site } = await patchSite(s, t);
    const siteAddr = hex(BigInt(t.addresses.bump_counter!));
    const before = await bytesAt(s, siteAddr, 4);
    await expect(enableCheat(s, patchCheat(site, [
      { op: 'writeBytes', at: 'site', bytes: 'c3' },
      { op: 'writeBytes', at: 'nowhere+4', bytes: 'c3' },
    ]))).rejects.toThrow('unknown symbol nowhere');
    expect((await bytesAt(s, siteAddr, 4)).equals(before)).toBe(true);
  });

  it('patch with a changed original byte needs updating and writes nothing', async () => {
    const { s, t } = await setup(['--writer']);
    const { site } = await patchSite(s, t);
    const siteAddr = hex(BigInt(t.addresses.bump_counter!));
    const before = await bytesAt(s, siteAddr, 4);
    const cheat = patchCheat(site, [{ op: 'writeBytes', at: 'site', bytes: 'c3', original: '00' }]);
    const v = await verifyCheat(s, cheat);
    expect(v.status).toBe('needs-update');
    const err = await enableCheat(s, cheat).catch((e) => e);
    expect(err).toBeInstanceOf(NeedsUpdateError);
    expect(err.reasons[0]).toMatch(/^the code at site changed/);
    expect((await bytesAt(s, siteAddr, 4)).equals(before)).toBe(true);
  });

  it('a failed revert makes disable reject, keeps the cheat on, and a later disable retries (--writer)', async () => {
    const { s, t } = await setup(['--writer']);
    const { site } = await patchSite(s, t);
    const siteAddr = hex(BigInt(t.addresses.bump_counter!));
    const original = (await bytesAt(s, siteAddr, 1)).toString('hex');
    const run = await enableCheat(s, patchCheat(site, [{ op: 'writeBytes', at: 'site', bytes: 'c3', original }]));
    // Someone else changes the patched byte: the daemon refuses to revert over it (PatchConflict).
    await write(s, siteAddr, 'uint8', 0x90);
    const err = await run.disable().catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toMatch(/still on/);
    expect((await bytesAt(s, siteAddr, 1)).toString('hex')).toBe('90');
    // Put the patched byte back; the retry now reverts it.
    await write(s, siteAddr, 'uint8', 0xc3);
    await run.disable();
    expect((await bytesAt(s, siteAddr, 1)).toString('hex')).toBe(original);
    await run.disable();
  });

  it('refuses a cheat with disable steps', async () => {
    const { s, t } = await setup(['--writer']);
    const { site } = await patchSite(s, t);
    const cheat = patchCheat(site, [{ op: 'writeBytes', at: 'site', bytes: 'c3' }], {
      disable: [{ op: 'writeBytes', at: 'site', bytes: '90' }],
    });
    await expect(enableCheat(s, cheat)).rejects.toThrow('needs the native table runner');
  });
});
