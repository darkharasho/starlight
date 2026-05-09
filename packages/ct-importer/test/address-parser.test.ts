import { describe, it, expect } from 'vitest';
import { parseAddress, type ParsedAddress } from '../src/address-parser.js';

describe('parseAddress', () => {
  it('parses absolute hex with 0x prefix', () => {
    expect(parseAddress('0x4A2B3C')).toEqual<ParsedAddress>({
      kind: 'absolute', address: '0x4a2b3c',
    });
  });

  it('parses absolute hex without prefix', () => {
    expect(parseAddress('4A2B3C')).toEqual<ParsedAddress>({
      kind: 'absolute', address: '0x4a2b3c',
    });
  });

  it('parses quoted-module-relative', () => {
    expect(parseAddress('"game.exe"+1A2B3C')).toEqual<ParsedAddress>({
      kind: 'module', module: 'game.exe', offset: '0x1a2b3c',
    });
  });

  it('parses unquoted-module-relative', () => {
    expect(parseAddress('game.exe+1A2B3C')).toEqual<ParsedAddress>({
      kind: 'module', module: 'game.exe', offset: '0x1a2b3c',
    });
  });

  it('parses aobscanmodule with offset', () => {
    const r = parseAddress('aobscanmodule(SIG, target, DE AD BE EF)+0C');
    expect(r).toEqual<ParsedAddress>({
      kind: 'aob',
      module: 'target',
      pattern: 'DE AD BE EF',
      offset: '0xc',
    });
  });

  it('parses aobscanmodule without offset', () => {
    const r = parseAddress('aobscanmodule(SIG, target, DE AD BE EF)');
    expect(r).toEqual<ParsedAddress>({
      kind: 'aob',
      module: 'target',
      pattern: 'DE AD BE EF',
    });
  });

  it('returns null for Lua-eval style expressions', () => {
    expect(parseAddress('getAddress("foo") + 0x10')).toBeNull();
  });

  it('promotes to pointer when offsets are provided', () => {
    expect(parseAddress('"game.exe"+1A2B3C', [0, 16, 32])).toEqual<ParsedAddress>({
      kind: 'pointer',
      module: 'game.exe',
      baseOffset: '0x1a2b3c',
      offsets: ['0x0', '0x10', '0x20'],
    });
  });

  it('promotes absolute base to pointer with no module', () => {
    expect(parseAddress('0x4A2B3C', [16])).toEqual<ParsedAddress>({
      kind: 'pointer',
      baseOffset: '0x4a2b3c',
      offsets: ['0x10'],
    });
  });
});
