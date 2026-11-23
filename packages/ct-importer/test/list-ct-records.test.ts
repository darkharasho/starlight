import { describe, it, expect } from 'vitest';
import { listCtRecords } from '../src/xml-parser.js';

const CT = `<?xml version="1.0"?>
<CheatTable CheatEngineTableVersion="45">
  <CheatEntries>
    <CheatEntry>
      <ID>10</ID>
      <Description>"== Player =="</Description>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
        <CheatEntry>
          <ID>11</ID>
          <Description>"Infinite HP"</Description>
        </CheatEntry>
        <CheatEntry>
          <ID>12</ID>
          <Description>"Infinite Money"</Description>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
    <CheatEntry>
      <Description>"No ID entry"</Description>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

describe('listCtRecords', () => {
  it('flattens depth-first (parent then children), matching CE order', () => {
    const recs = listCtRecords(CT);
    expect(recs.map((r) => r.name)).toEqual([
      '== Player ==', 'Infinite HP', 'Infinite Money', 'No ID entry',
    ]);
  });

  it('keeps the numeric <ID> and flags group headers', () => {
    const recs = listCtRecords(CT);
    expect(recs[0]).toMatchObject({ id: 10, name: '== Player ==', isGroupHeader: true });
    expect(recs[1]).toMatchObject({ id: 11, name: 'Infinite HP', isGroupHeader: false });
    expect(recs[2]).toMatchObject({ id: 12, name: 'Infinite Money' });
  });

  it('falls back to flat position when an entry has no <ID>', () => {
    const recs = listCtRecords(CT);
    // 4th record (index 3) has no <ID> -> id === its flat position (3)
    expect(recs[3]).toMatchObject({ id: 3, name: 'No ID entry' });
  });

  it('reports kind and nesting depth', () => {
    const recs = listCtRecords(`<CheatTable><CheatEntries><CheatEntry><ID>1</ID><Description>"Group"</Description><GroupHeader>1</GroupHeader>
      <CheatEntries><CheatEntry><ID>2</ID><Description>"God Mode"</Description><VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]</AssemblerScript>
        <CheatEntries><CheatEntry><ID>3</ID><Description>"HP"</Description><VariableType>4 Bytes</VariableType></CheatEntry></CheatEntries>
      </CheatEntry></CheatEntries></CheatEntry></CheatEntries></CheatTable>`);
    expect(recs.map((r) => [r.kind, r.depth])).toEqual([['header', 0], ['script', 1], ['value', 2]]);
  });

  it('handles a single top-level entry (not an array)', () => {
    const recs = listCtRecords('<CheatTable><CheatEntries><CheatEntry><ID>5</ID><Description>"Solo"</Description></CheatEntry></CheatEntries></CheatTable>');
    expect(recs).toEqual([{ id: 5, name: 'Solo', isGroupHeader: false, kind: 'value', depth: 0 }]);
  });

  it('reports the option flags a record carries', () => {
    const recs = listCtRecords(`<CheatTable><CheatEntries><CheatEntry><ID>1</ID><Description>"Enable"</Description><Options moHideChildren="1" moDeactivateChildrenAsWell="1"/><VariableType>Auto Assembler Script</VariableType></CheatEntry><CheatEntry><ID>2</ID><Description>"Plain"</Description></CheatEntry></CheatEntries></CheatTable>`);
    expect(recs[0]!.opts).toBe('moHideChildren,moDeactivateChildrenAsWell');
    expect(recs[1]!.opts).toBeUndefined();
  });
});
