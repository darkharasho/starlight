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

  it('handles a single top-level entry (not an array)', () => {
    const recs = listCtRecords('<CheatTable><CheatEntries><CheatEntry><ID>5</ID><Description>"Solo"</Description></CheatEntry></CheatEntries></CheatTable>');
    expect(recs).toEqual([{ id: 5, name: 'Solo', isGroupHeader: false }]);
  });
});
