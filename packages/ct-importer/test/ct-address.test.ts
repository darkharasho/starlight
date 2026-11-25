import { describe, it, expect } from 'vitest';
import { parseCtAddress, ctOffsetsInApplyOrder } from '../src/ct-address.js';
import { parseCt } from '../src/xml-parser.js';
import { convertEntry } from '../src/entry-converter.js';
import type { CtEntry } from '../src/xml-parser.js';

const twoOffsets = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable><CheatEntries><CheatEntry>
  <ID>1</ID><Description>"Gold"</Description><VariableType>4 Bytes</VariableType>
  <Address>"target"+403090</Address>
  <Offsets><Offset>10</Offset><Offset>1E5</Offset></Offsets>
</CheatEntry></CheatEntries></CheatTable>`;

describe('parseCtAddress', () => {
  it('module, quoted module and absolute forms', () => {
    expect(parseCtAddress('"target"+4030', undefined, null)).toEqual({ kind: 'module', module: 'target', offset: '0x4030' });
    expect(parseCtAddress('game.exe+00401A2B', undefined, null)).toEqual({ kind: 'module', module: 'game.exe', offset: '0x401a2b' });
    expect(parseCtAddress('7FF6A000', undefined, null)).toEqual({ kind: 'absolute', address: '0x7ff6a000' });
    expect(parseCtAddress('0x1000', undefined, null)).toEqual({ kind: 'absolute', address: '0x1000' });
    // R5: a number is the digits CE wrote, read as hex.
    expect(parseCtAddress(18, undefined, null)).toEqual({ kind: 'absolute', address: '0x18' });
  });

  it('symbols with offsets and brackets', () => {
    expect(parseCtAddress('pPlayer', undefined, null)).toEqual({ kind: 'symbol', expr: 'pPlayer' });
    expect(parseCtAddress('pPlayer+8', undefined, null)).toEqual({ kind: 'symbol', expr: 'pPlayer+8' });
    expect(parseCtAddress('[[pPlayer]+18]+4', undefined, null)).toEqual({ kind: 'symbol', expr: 'pPlayer', offsets: ['0x18', '0x4'] });
    expect(parseCtAddress('[pPlayer]', undefined, null)).toEqual({ kind: 'symbol', expr: 'pPlayer', offsets: ['0x0'] });
    expect(parseCtAddress('[pPlayer+8]-10', undefined, null)).toEqual({ kind: 'symbol', expr: 'pPlayer+8', offsets: ['-0x10'] });
    // A literal base inside brackets is the existing pointer form.
    expect(parseCtAddress('["target"+4030]+8', undefined, null)).toEqual({ kind: 'pointer', module: 'target', baseOffset: '0x4030', offsets: ['0x8'] });
    expect(parseCtAddress('[[pPlayer]+8]*2+foo', undefined, null)).toBeNull();
    expect(parseCtAddress('getAddress("x")+10', undefined, null)).toBeNull();
    expect(parseCtAddress('Player:Update+10', undefined, null)).toBeNull();
  });

  it('CT offsets are applied innermost-first, after bracket offsets', () => {
    expect(parseCtAddress('pBase', ['10', '18'], null)).toEqual({ kind: 'symbol', expr: 'pBase', offsets: ['0x18', '0x10'] });
    expect(parseCtAddress('[pBase]+4', ['10', '1E5'], null)).toEqual({ kind: 'symbol', expr: 'pBase', offsets: ['0x4', '0x1e5', '0x10'] });
    expect(parseCtAddress('"target"+403090', ['10', '1E5'], null)).toEqual({
      kind: 'pointer', module: 'target', baseOffset: '0x403090', offsets: ['0x1e5', '0x10'],
    });
    expect(parseCtAddress('400000', [10, 18], null)).toEqual({ kind: 'pointer', baseOffset: '0x400000', offsets: ['0x18', '0x10'] });
  });

  it('a child +10 folds into the parent address', () => {
    const mod = { kind: 'module' as const, module: 'target', offset: '0x4030' };
    expect(parseCtAddress('+10', undefined, mod)).toEqual({ kind: 'module', module: 'target', offset: '0x4040' });
    expect(parseCtAddress('-30', undefined, mod)).toEqual({ kind: 'module', module: 'target', offset: '0x4000' });
    const ptr = { kind: 'pointer' as const, module: 'target', baseOffset: '0x100', offsets: ['0x8', '0x10'] };
    expect(parseCtAddress('+10', undefined, ptr)).toEqual({ ...ptr, offsets: ['0x8', '0x20'] });
    expect(parseCtAddress('+10', undefined, { kind: 'symbol', expr: 'p' })).toEqual({ kind: 'symbol', expr: 'p+10' });
    expect(parseCtAddress('+10', undefined, { kind: 'symbol', expr: 'p', offsets: ['0x40'] })).toEqual({ kind: 'symbol', expr: 'p', offsets: ['0x50'] });
    expect(parseCtAddress('+10', undefined, { kind: 'absolute', address: '0x1000' })).toEqual({ kind: 'absolute', address: '0x1010' });
    // A relative child with its own offsets reads a pointer at parent+10.
    expect(parseCtAddress('+10', ['4'], mod)).toEqual({ kind: 'pointer', module: 'target', baseOffset: '0x4040', offsets: ['0x4'] });
  });

  it('constant arithmetic in the base, brackets and relative children is folded (CE evaluates it)', () => {
    expect(parseCtAddress('game.exe+2F7574+4', undefined, null)).toEqual({ kind: 'module', module: 'game.exe', offset: '0x2f7578' });
    expect(parseCtAddress('"target"+10-4', undefined, null)).toEqual({ kind: 'module', module: 'target', offset: '0xc' });
    expect(parseCtAddress('146F2FA3640+14', undefined, null)).toEqual({ kind: 'absolute', address: '0x146f2fa3654' });
    expect(parseCtAddress('pBase+10+8', undefined, null)).toEqual({ kind: 'symbol', expr: 'pBase+18' });
    expect(parseCtAddress('pBase+10-18', undefined, null)).toEqual({ kind: 'symbol', expr: 'pBase-8' });
    expect(parseCtAddress('[Ptr]-9C+4*2', undefined, null)).toEqual({ kind: 'symbol', expr: 'Ptr', offsets: ['-0x94'] });
    expect(parseCtAddress('[Ptr]-9C+0', undefined, null)).toEqual({ kind: 'symbol', expr: 'Ptr', offsets: ['-0x9c'] });
    const mod = { kind: 'module' as const, module: 'target', offset: '0x4030' };
    expect(parseCtAddress('+10*2', undefined, mod)).toEqual({ kind: 'module', module: 'target', offset: '0x4050' });
    expect(parseCtAddress('+0x10', undefined, mod)).toEqual({ kind: 'module', module: 'target', offset: '0x4040' });
  });

  it('$process is the main module', () => {
    expect(parseCtAddress('$process+27C0824', undefined, null)).toEqual({ kind: 'module', module: '$process', offset: '0x27c0824' });
    expect(parseCtAddress('[$process+5EAB88]', undefined, null)).toEqual({ kind: 'pointer', module: '$process', baseOffset: '0x5eab88', offsets: ['0x0'] });
    expect(parseCtAddress('$PROCESS', ['10'], null)).toEqual({ kind: 'pointer', module: '$process', baseOffset: '0x0', offsets: ['0x10'] });
  });

  it('what CE needs at run time stays unsupported', () => {
    expect(parseCtAddress('"THREADSTACK1"-000003A8', ['B3C'], null)).toBeNull();
    expect(parseCtAddress('[[[p]]+[p+4]]+[p+8]', undefined, null)).toBeNull();
    expect(parseCtAddress('pBase+foo', undefined, null)).toBeNull();
    expect(parseCtAddress('4*', undefined, null)).toBeNull();
  });

  it('a relative address with no parent is null', () => {
    expect(parseCtAddress('+10', undefined, null)).toBeNull();
    expect(parseCtAddress('-8', undefined, null)).toBeNull();
  });
});

describe('ctOffsetsInApplyOrder (R27)', () => {
  it('reverses CE <Offsets> and reads them as hex', () => {
    expect(ctOffsetsInApplyOrder(['10', '1E5'])).toEqual(['0x1e5', '0x10']);
    expect(ctOffsetsInApplyOrder([0, 18])).toEqual(['0x18', '0x0']);
    expect(ctOffsetsInApplyOrder(['zz'])).toBeNull();
  });

  it('offsets may be negative or constant arithmetic', () => {
    expect(ctOffsetsInApplyOrder(['-8', -10])).toEqual(['-0x10', '-0x8']);
    expect(ctOffsetsInApplyOrder(['64+3b0', '1*8+0x668', '0x144 * 0 + 0x11c', '168-1c'])).toEqual(['0x14c', '0x11c', '0x670', '0x414']);
    expect(ctOffsetsInApplyOrder(['0*2+3737'])).toEqual(['0x3737']);
    expect(ctOffsetsInApplyOrder(['Finance.currentBudget'])).toBeNull();
    expect(ctOffsetsInApplyOrder(['[EarthSepithOffset]-18'])).toBeNull();
  });

  it('the same two-offset fixture gives the same order in parseCtAddress and the importer', () => {
    const entry = parseCt(twoOffsets).CheatTable.CheatEntries.CheatEntry as unknown as CtEntry[];
    const e = entry[0]!;
    const expected = { kind: 'pointer', module: 'target', baseOffset: '0x403090', offsets: ['0x1e5', '0x10'] };
    const raw = (Array.isArray(e.Offsets!.Offset) ? e.Offsets!.Offset : [e.Offsets!.Offset]) as Array<string | number>;
    expect(parseCtAddress(e.Address!, raw, null)).toEqual(expected);
    const r = convertEntry(e);
    if (r.kind !== 'cheat' || ('unsupported' in r.cheat && r.cheat.unsupported)) throw new Error('expected a cheat');
    expect((r.cheat as { address: unknown }).address).toEqual(expected);
  });
});
