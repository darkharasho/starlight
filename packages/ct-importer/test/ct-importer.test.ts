import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCt } from '../src/ct-importer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(HERE, 'fixtures/synthetic', name), 'utf8');

describe('importCt', () => {
  it('imports basic-static.ct: 2 supported cheats in 1 default category', () => {
    const result = importCt(fixture('basic-static.ct'), {
      gameName: 'Test Target',
      processName: ['target'],
    });
    expect(result.stats).toEqual({ total: 2, supported: 2, unsupported: 0, categories: 1 });
    expect(result.trainer.categories).toHaveLength(1);
    expect(result.trainer.categories[0]!.cheats).toHaveLength(2);
    expect(result.trainer.game.name).toBe('Test Target');
  });

  it('imports grouped.ct: 2 categories with 1 cheat each', () => {
    const result = importCt(fixture('grouped.ct'), {
      gameName: 'Test Target',
      processName: ['target'],
    });
    expect(result.stats).toEqual({ total: 2, supported: 2, unsupported: 0, categories: 2 });
    expect(result.trainer.categories.map((c) => c.name)).toEqual(['Player', 'Stats']);
  });

  it('imports lua-script.ct as 1 unsupported entry', () => {
    const result = importCt(fixture('lua-script.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.stats).toEqual({ total: 1, supported: 0, unsupported: 1, categories: 1 });
    const cheat = result.trainer.categories[0]!.cheats[0]!;
    expect('unsupported' in cheat && cheat.unsupported).toBe(true);
  });

  it('imports mixed-real-shape.ct: counts stats correctly', () => {
    const result = importCt(fixture('mixed-real-shape.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.stats.total).toBe(4);
    expect(result.stats.supported).toBe(3);
    expect(result.stats.unsupported).toBe(1);
  });

  it('produced trainer validates against the schema', () => {
    const result = importCt(fixture('mixed-real-shape.ct'), {
      gameName: 'X', processName: ['x'],
    });
    return import('../src/starlight-format.js').then((m) => {
      expect(() => m.StarlightTrainerSchema.parse(result.trainer)).not.toThrow();
    });
  });

  it('puts top-level non-grouped cheats in a single "General" category', () => {
    const result = importCt(fixture('hotkeys.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.trainer.categories).toHaveLength(1);
    expect(result.trainer.categories[0]!.name).toBe('General');
  });

  it('handles a CheatTable with no CheatEntries (empty result, no crash)', () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?><CheatTable CheatEngineTableVersion="42"></CheatTable>';
    const result = importCt(xml, { gameName: 'Empty', processName: ['x'] });
    expect(result.stats).toEqual({ total: 0, supported: 0, unsupported: 0, categories: 0 });
    expect(result.trainer.categories).toEqual([]);
  });

  it('does not emit empty parent categories for nested groups', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>10</ID>
      <Description>"Outer"</Description>
      <Options moHideChildren="1"/>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
        <CheatEntry>
          <ID>20</ID>
          <Description>"Inner"</Description>
          <Options moHideChildren="1"/>
          <GroupHeader>1</GroupHeader>
          <CheatEntries>
            <CheatEntry>
              <ID>21</ID>
              <Description>"Health"</Description>
              <VariableType>4 Bytes</VariableType>
              <Address>"target"+0040303C</Address>
            </CheatEntry>
          </CheatEntries>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;
    const result = importCt(xml, { gameName: 'X', processName: ['x'] });
    // Outer is empty (only contains Inner, which is itself a group with no direct cheats... wait, Inner has Health).
    // Inner has 1 cheat. So Inner should appear with 1 cheat. Outer should NOT appear (it has no direct cheats).
    expect(result.trainer.categories).toHaveLength(1);
    expect(result.trainer.categories[0]!.name).toBe('Inner');
    expect(result.trainer.categories[0]!.cheats).toHaveLength(1);
    expect(result.stats).toEqual({ total: 1, supported: 1, unsupported: 0, categories: 1 });
  });

  it('de-duplicates cheat IDs when CE entries share the same numeric ID', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry><ID>1</ID><Description>"A"</Description><VariableType>4 Bytes</VariableType><Address>"target"+00001000</Address></CheatEntry>
    <CheatEntry><ID>1</ID><Description>"B"</Description><VariableType>4 Bytes</VariableType><Address>"target"+00002000</Address></CheatEntry>
    <CheatEntry><ID>1</ID><Description>"C"</Description><VariableType>4 Bytes</VariableType><Address>"target"+00003000</Address></CheatEntry>
  </CheatEntries>
</CheatTable>`;
    const result = importCt(xml, { gameName: 'X', processName: ['x'] });
    const ids = result.trainer.categories[0]!.cheats.map((c) => c.id);
    expect(ids).toEqual(['cheat-1', 'cheat-1-2', 'cheat-1-3']);
  });
});
