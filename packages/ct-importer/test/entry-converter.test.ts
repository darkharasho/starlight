import { describe, it, expect } from 'vitest';
import { convertEntry, type ConvertedEntry } from '../src/entry-converter.js';
import type { CtEntry } from '../src/xml-parser.js';

describe('convertEntry', () => {
  it('converts a simple static entry to a freeze cheat', () => {
    const entry: CtEntry = {
      ID: 1,
      Description: '"Health"',
      VariableType: '4 Bytes',
      Address: '"target"+0040303C',
    };
    const r = convertEntry(entry);
    expect(r.kind).toBe('cheat');
    if (r.kind !== 'cheat') return;
    expect(r.cheat).toMatchObject({
      id: 'cheat-1',
      name: 'Health',
      type: 'freeze',
      valueType: 'int32',
      address: { kind: 'module', module: 'target', offset: '0x40303c' },
    });
  });

  it('converts pointer-chain entries', () => {
    const entry: CtEntry = {
      ID: 2,
      Description: '"Player HP"',
      VariableType: '4 Bytes',
      Address: '"target"+00403090',
      Offsets: { Offset: [0, 0] },
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported cheat');
    expect(r.cheat.address).toMatchObject({
      kind: 'pointer',
      module: 'target',
      baseOffset: '0x403090',
      offsets: ['0x0', '0x0'],
    });
  });

  it('converts AOB scan entries', () => {
    const entry: CtEntry = {
      ID: 3,
      Description: '"AOB Hit"',
      VariableType: 'Float',
      Address: 'aobscanmodule(SIG, target, DE AD BE EF)+0C',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported cheat');
    expect(r.cheat.address).toMatchObject({
      kind: 'aob', module: 'target', pattern: 'DE AD BE EF', offset: '0xc',
    });
  });

  it('converts entries with a single Toggle Activation hotkey', () => {
    const entry: CtEntry = {
      ID: 4,
      Description: '"Infinite HP"',
      VariableType: '4 Bytes',
      Address: '"target"+0040303C',
      Hotkeys: { Hotkey: [{ Action: 'Toggle Activation', Keys: { Key: 112 } }] },
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported cheat');
    expect(r.cheat.hotkeys).toEqual({ toggle: 'F1' });
  });

  it('returns a category for GroupHeader entries', () => {
    const entry: CtEntry = {
      ID: 10,
      Description: '"Player"',
      GroupHeader: 1,
      CheatEntries: { CheatEntry: [{
        ID: 11, Description: '"Health"', VariableType: '4 Bytes', Address: '"target"+0040303C',
      }] },
    };
    const r = convertEntry(entry);
    expect(r.kind).toBe('category');
    if (r.kind !== 'category') return;
    expect(r.name).toBe('Player');
    expect(r.children).toHaveLength(1);
  });

  it('flags Lua scripts as unsupported', () => {
    const entry: CtEntry = {
      ID: 5,
      Description: '"Auto-Block"',
      LuaScript: 'function blockLoop() end',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || !r.cheat.unsupported) throw new Error('expected unsupported');
    expect(r.cheat.unsupportedReason).toMatch(/Lua/i);
    expect(r.cheat.originalSource).toContain('blockLoop');
  });

  it('flags entries with no usable VariableType+Address as unsupported', () => {
    const entry: CtEntry = {
      ID: 6,
      Description: '"Nothing"',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || !r.cheat.unsupported) throw new Error('expected unsupported');
    expect(r.cheat.unsupportedReason).toMatch(/missing/i);
  });

  it('flags Lua-eval addresses as unsupported with the original source', () => {
    const entry: CtEntry = {
      ID: 7,
      Description: '"Computed"',
      VariableType: '4 Bytes',
      Address: 'getAddress("foo") + 0x10',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || !r.cheat.unsupported) throw new Error('expected unsupported');
    expect(r.cheat.unsupportedReason).toMatch(/address/i);
    expect(r.cheat.originalSource).toBe('getAddress("foo") + 0x10');
  });

  it('strips wrapping quotes from Description', () => {
    const entry: CtEntry = {
      ID: 8, Description: '"Quoted"', VariableType: '4 Bytes', Address: '0x4A2B3C',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported');
    expect(r.cheat.name).toBe('Quoted');
  });
});
