import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTable, type CompiledRecord } from '../src/table-compiler.js';
import { listCtRecords } from '../src/xml-parser.js';
import { REASON_CODES } from '../src/reasons.js';
import { StarlightPatchCheatSchema } from '../src/starlight-format.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const table = (name: string) => readFileSync(resolve(HERE, 'fixtures/tables', name), 'utf8');
const byId = (recs: CompiledRecord[], id: number) => {
  const r = recs.find((x) => x.id === id);
  if (!r) throw new Error(`no record ${id}`);
  return r;
};
const ct = (entries: string, extra = '') =>
  `<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries>${entries}</CheatEntries>${extra}</CheatTable>`;

describe('compileTable', () => {
  it('a table of supported records is native with matching ids', () => {
    const xml = table('native-ok.CT');
    const t = compileTable(xml);
    expect(t.reasons).toEqual([]);
    expect(t.native).toBe(true);
    expect(t.records.map((r) => r.id)).toEqual(listCtRecords(xml).map((r) => r.id));
    expect(t.records.map((r) => r.depth)).toEqual(listCtRecords(xml).map((r) => r.depth));
    expect(byId(t.records, 0)).toMatchObject({ kind: 'header', script: null, name: 'Player', opts: 'moHideChildren' });
    expect(byId(t.records, 1)).toMatchObject({
      kind: 'value', valueType: 'uint32', address: { kind: 'module', module: 'target', offset: '0x4030' },
    });
    // R5: offsets are hex text, not numbers ("10" is 0x10, "1E5" is 0x1e5).
    expect(byId(t.records, 2)).toMatchObject({
      kind: 'value', address: { kind: 'pointer', module: 'target', baseOffset: '0x403090', offsets: ['0x1e5', '0x10'] },
    });
    const s = byId(t.records, 5);
    if (s.kind !== 'script') throw new Error('expected a script');
    expect(s.script.cheat).not.toBeNull();
    StarlightPatchCheatSchema.parse(s.script.cheat);
    expect(s.hotkeys).toEqual([{ action: 'toggle', accelerator: 'Ctrl+A' }]);
  });

  it('one Lua record sends the whole table to CE with lua:block', () => {
    const t = compileTable(table('with-lua-record.CT'));
    expect(t.native).toBe(false);
    expect(byId(t.records, 1).kind).toBe('value');
    expect(byId(t.records, 2)).toMatchObject({ kind: 'unsupported', code: 'lua:block' });
    expect(t.reasons).toEqual([expect.objectContaining({ recordId: 2, name: 'Lua inside AA', code: 'lua:block' })]);
  });

  it('a per-record Lua script is lua:script', () => {
    const t = compileTable(ct('<CheatEntry><ID>4</ID><Description>"L"</Description><LuaScript>print(1)</LuaScript></CheatEntry>'));
    expect(t.records[0]).toMatchObject({ kind: 'unsupported', code: 'lua:script' });
  });

  it('a table-level Lua script is lua:table-script; comment-only Lua is ignored', () => {
    const t = compileTable(table('table-lua.CT'));
    expect(t.native).toBe(false);
    expect(t.reasons).toEqual([expect.objectContaining({ recordId: null, code: 'lua:table-script' })]);
    expect(t.records[0]!.kind).toBe('value');
    // native-ok.CT has a comment-only table script.
    expect(compileTable(table('native-ok.CT')).native).toBe(true);
  });

  it('a header-only table is table:empty', () => {
    const t = compileTable(ct('<CheatEntry><ID>1</ID><Description>"H"</Description><GroupHeader>1</GroupHeader></CheatEntry>'));
    expect(t.native).toBe(false);
    expect(t.reasons.map((r) => [r.recordId, r.code])).toEqual([[null, 'table:empty']]);
    expect(compileTable(ct('')).reasons.map((r) => r.code)).toEqual(['table:empty']);
  });

  it('children addressed through a registered symbol compile and resolve to the registering record', () => {
    const t = compileTable(table('symbol-children.CT'));
    expect(t.registeredBy).toMatchObject({ pplayer: 10 });
    expect(byId(t.records, 10)).toMatchObject({ kind: 'script' });
    expect(byId(t.records, 11)).toMatchObject({ kind: 'value', address: { kind: 'symbol', expr: 'pPlayer', offsets: ['0x10'] } });
    // +8 under [pPlayer]+40 folds into the parent's last offset.
    expect(byId(t.records, 13)).toMatchObject({ kind: 'value', address: { kind: 'symbol', expr: 'pPlayer', offsets: ['0x48'] } });
    // A script that uses pPlayer finds it registered by record 10.
    expect(byId(t.records, 14)).toMatchObject({ kind: 'script' });
  });

  it('a used symbol nobody registers is sym:unresolved on that record', () => {
    const t = compileTable(table('symbol-children.CT'));
    expect(byId(t.records, 20)).toMatchObject({ kind: 'unsupported', code: 'sym:unresolved', detail: 'penemy' });
    expect(t.reasons).toEqual([{ recordId: 20, name: 'Uses an unknown name', code: 'sym:unresolved', detail: 'penemy' }]);
    expect(t.native).toBe(false);
  });

  it('a used Mono name is sym:mono', () => {
    const script = `[ENABLE]
alloc(newmem,$1000,PlayerController:Update+1A)
label(return)
newmem:
  jmp return
PlayerController:Update+1A:
  jmp newmem
return:
[DISABLE]
PlayerController:Update+1A:
  db F3 0F 10 43 3C
dealloc(newmem)`;
    const t = compileTable(ct(`<CheatEntry><ID>3</ID><Description>"Mono"</Description><VariableType>Auto Assembler Script</VariableType><AssemblerScript>${script}</AssemblerScript></CheatEntry>`));
    expect(t.records[0]).toMatchObject({ kind: 'unsupported', code: 'sym:mono' });
  });

  it('dropdown lists and links become options', () => {
    const t = compileTable(table('dropdown-hotkeys.CT'));
    const opts = [{ value: '0', label: 'Off' }, { value: '1', label: 'On' }];
    expect(byId(t.records, 1)).toMatchObject({ kind: 'value', valueType: 'uint8', options: opts });
    expect(byId(t.records, 2)).toMatchObject({ kind: 'value', options: opts });
    expect('options' in byId(t.records, 3)).toBe(false);
  });

  it('table hotkeys compile with their actions and values', () => {
    const t = compileTable(table('dropdown-hotkeys.CT'));
    expect(byId(t.records, 3).hotkeys).toEqual([
      { action: 'set', accelerator: 'F3', value: '999' },
      { action: 'inc', accelerator: 'Shift+PageUp', value: '0010' },
      { action: 'dec', accelerator: 'Num0', value: '0.5' },
      { action: 'activate', accelerator: 'Alt+F1' },
      { action: 'deactivate', accelerator: 'Alt+F2' },
    ]);
    expect(byId(t.records, 1).hotkeys).toEqual([]);
  });

  it('ShowAsHex and ShowAsSigned are read', () => {
    const t = compileTable(table('custom-type.CT'));
    // R26: 2/4/8-byte types are unsigned unless ShowAsSigned=1.
    expect(byId(t.records, 5)).toMatchObject({ kind: 'value', valueType: 'int16', showAsSigned: true, showAsHex: false });
    expect(byId(t.records, 6)).toMatchObject({ kind: 'value', valueType: 'uint64', showAsSigned: false, showAsHex: true });
    expect(byId(t.records, 3)).toMatchObject({ kind: 'value', valueType: 'bytes', length: 8 });
    expect(byId(t.records, 4)).toMatchObject({ kind: 'value', valueType: 'string', length: 16 });
  });

  it('custom and binary types are value:type with the type name', () => {
    const t = compileTable(table('custom-type.CT'));
    expect(byId(t.records, 1)).toMatchObject({ kind: 'unsupported', code: 'value:type', detail: 'Custom: 4 Byte Big Endian' });
    expect(byId(t.records, 2)).toMatchObject({ kind: 'unsupported', code: 'value:type', detail: 'Binary' });
    expect(byId(t.records, 7)).toMatchObject({ kind: 'unsupported', code: 'addr:expression', detail: '[[pPlayer]+8]*2+foo' });
    expect(t.reasons.map((r) => r.code).sort()).toEqual(['addr:expression', 'value:type', 'value:type']);
    for (const r of t.reasons) expect(REASON_CODES).toContain(r.code);
  });

  it('an empty script record compiles to a no-op', () => {
    const s = byId(compileTable(table('native-ok.CT')).records, 6);
    if (s.kind !== 'script') throw new Error('expected a script');
    expect(s.script.cheat).toBeNull();
  });

  it('a relative child with no addressed ancestor is addr:expression', () => {
    const t = compileTable(ct('<CheatEntry><ID>1</ID><Description>"C"</Description><VariableType>4 Bytes</VariableType><Address>+10</Address></CheatEntry>'));
    expect(t.records[0]).toMatchObject({ kind: 'unsupported', code: 'addr:expression' });
  });
});
