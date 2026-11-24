import { describe, it, expect } from 'vitest';
import { baselineCompile, measureTable, summarize, type TableCoverage } from '../src/coverage.js';

function ct(entries: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries>${entries}</CheatEntries></CheatTable>`;
}
const value = (id: number, name: string, addr = '"game.exe"+4030') =>
  `<CheatEntry><ID>${id}</ID><Description>"${name}"</Description><VariableType>4 Bytes</VariableType><Address>${addr}</Address></CheatEntry>`;
const aa = (id: number) =>
  `<CheatEntry><ID>${id}</ID><Description>"AA"</Description><VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]
nop
[DISABLE]
nop</AssemblerScript></CheatEntry>`;
const lua = (id: number) =>
  `<CheatEntry><ID>${id}</ID><Description>"Lua"</Description><LuaScript>print(1)</LuaScript></CheatEntry>`;
const header = (id: number, kids = '') =>
  `<CheatEntry><ID>${id}</ID><Description>"H"</Description><GroupHeader>1</GroupHeader>${kids ? `<CheatEntries>${kids}</CheatEntries>` : ''}</CheatEntry>`;

const row = (id: string, native: boolean, codes: Record<string, number> = {}): TableCoverage => ({
  id, records: 1, nativeRecords: native ? 1 : 0, native, codes, tableCodes: [],
});

describe('coverage', () => {
  it('baseline: a table of plain value records is native', () => {
    const t = measureTable('g', ct(value(1, 'target') + value(2, 'target2')), 'baseline');
    expect(t.native).toBe(true);
    expect(t.records).toBe(2);
    expect(t.nativeRecords).toBe(2);
  });

  it('baseline: an AA script record makes the table CE with aa:script', () => {
    const t = measureTable('g', ct(aa(1)), 'baseline');
    expect(t.native).toBe(false);
    expect(t.codes).toEqual({ 'aa:script': 1 });
  });

  it('baseline: a Lua record counts as lua:script', () => {
    const t = measureTable('g', ct(lua(1) + value(2, 'v')), 'baseline');
    expect(t.codes).toEqual({ 'lua:script': 1 });
    expect(t.nativeRecords).toBe(1);
    expect(t.native).toBe(false);
  });

  it('baseline: header-only tables are table:empty', () => {
    const t = measureTable('g', ct(header(1)), 'baseline');
    expect(t.tableCodes).toEqual(['table:empty']);
    expect(t.native).toBe(false);
    expect(t.records).toBe(0);
  });

  it('headers without scripts are not records', () => {
    const r = baselineCompile(ct(header(1, value(2, 'v'))));
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ id: 2, native: true });
  });

  it('address expressions and missing types get their codes', () => {
    const noType = `<CheatEntry><ID>3</ID><Description>"x"</Description><Address>1234</Address></CheatEntry>`;
    const r = baselineCompile(ct(value(1, 'e', '[[pPlayer]+8]*2+foo') + noType));
    expect(r.records.map((x) => x.code)).toEqual(['addr:expression', 'value:type']);
  });

  it('summarize computes percentages and ranks codes by tables', () => {
    const rep = summarize(
      [row('a', true), row('b', false, { 'aa:script': 2 }), row('c', false, { 'aa:script': 1, 'lua:script': 1 })],
      0, 'baseline',
    );
    expect(rep.tables).toEqual({ total: 3, native: 1, pct: 33.3 });
    expect(rep.records).toEqual({ total: 3, native: 1, pct: 33.3 });
    expect(rep.byCode[0]).toEqual({ code: 'aa:script', tables: 2, records: 3 });
  });

  it('failed fetches are reported but not counted', () => {
    const rep = summarize([row('a', true)], 4, 'baseline');
    expect(rep.failed).toBe(4);
    expect(rep.tables.total).toBe(1);
    expect(rep.tables.pct).toBe(100);
  });

  it('native compiler is not available before Task 8', () => {
    expect(() => measureTable('g', ct(value(1, 'v')), 'native')).toThrow('native compiler not built yet');
  });
});
