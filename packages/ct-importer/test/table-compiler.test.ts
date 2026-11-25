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

  it('an AA script with supported {$lua} compiles to a deferred script; the table stays native', () => {
    const t = compileTable(table('with-lua-record.CT'));
    expect(t.reasons).toEqual([]);
    expect(t.native).toBe(true);
    expect(byId(t.records, 1).kind).toBe('value');
    const r = byId(t.records, 2);
    if (r.kind !== 'script') throw new Error('expected a script');
    expect(r.script.cheat).toBeNull();
    expect(r.script.deferred).toContain('{$lua}');
  });

  it('{$lua} with something the runtime lacks is lua:unsupported with the function', () => {
    const aa = (body: string) => ct('<CheatEntry><ID>3</ID><Description>"S"</Description><VariableType>Auto Assembler Script</VariableType>'
      + `<AssemblerScript>[ENABLE]\n{$lua}\n${body}\n{$asm}\n[DISABLE]\n</AssemblerScript></CheatEntry>`);
    expect(compileTable(aa('createThread(f)')).reasons).toEqual([{ recordId: 3, name: 'S', code: 'lua:unsupported', detail: 'createthread' }]);
    expect(compileTable(aa('local m = createMenuItem(x)\nm.OnClick = function() end')).reasons.map((r) => r.detail)).toEqual(['ui-callback']);
    // luacall lines are Lua too.
    const call = ct('<CheatEntry><ID>4</ID><Description>"C"</Description><VariableType>Auto Assembler Script</VariableType>'
      + '<AssemblerScript>[ENABLE]\nluacall(speedhack_setSpeed(2))\n[DISABLE]\n</AssemblerScript></CheatEntry>');
    expect(compileTable(call).reasons.map((r) => [r.code, r.detail])).toEqual([['lua:unsupported', 'speedhack_setspeed']]);
  });

  it('a per-record Lua script is a lua record, or lua:unsupported', () => {
    const rec = (lua: string) => ct(`<CheatEntry><ID>4</ID><Description>"L"</Description><LuaScript>${lua}</LuaScript></CheatEntry>`);
    expect(compileTable(rec('writeInteger("x",1)')).records[0]).toMatchObject({ kind: 'lua', lua: 'writeInteger("x",1)' });
    expect(compileTable(rec('injectDLL("x")')).records[0]).toMatchObject({ kind: 'unsupported', code: 'lua:unsupported', detail: 'injectdll' });
  });

  it('Lua that only opens links or shows messages is ignored, in the table and in records', () => {
    const nag = `if messageDialog("More cheats here! Open?", mtConfirmation, mbYes, mbNo) == mrYes then
  shellExecute("https://example.com/t/1")
end`;
    const link = '<CheatEntry><ID>2</ID><Description>"Donate"</Description><VariableType>Auto Assembler Script</VariableType>'
      + '<AssemblerScript>{$lua}\nif syntaxcheck then return end\n[ENABLE]\nShellExecute(\'https://example.com\')\n[DISABLE]\n</AssemblerScript></CheatEntry>';
    const value = '<CheatEntry><ID>1</ID><Description>"Gold"</Description><VariableType>4 Bytes</VariableType><Address>target.exe+10</Address></CheatEntry>';
    const t = compileTable(ct(value + link, `<LuaScript>${nag}</LuaScript>`));
    expect(t.reasons).toEqual([]);
    expect(byId(t.records, 2)).toMatchObject({ kind: 'script', script: { cheat: null } });
    // An assignment is real code.
    expect(compileTable(ct(value, '<LuaScript>x = 1\nshowMessage("hi")</LuaScript>')).tableLua).toContain('x = 1');
  });

  it('a supported table script becomes tableLua; an unsupported one is lua:unsupported', () => {
    const t = compileTable(table('table-lua.CT'));
    expect(t.reasons).toEqual([]);
    expect(t.native).toBe(true);
    expect(t.tableLua).toContain('openProcess("target.exe")');
    expect(t.records[0]!.kind).toBe('value');
    const value = '<CheatEntry><ID>1</ID><Description>"Gold"</Description><VariableType>4 Bytes</VariableType><Address>target.exe+10</Address></CheatEntry>';
    expect(compileTable(ct(value, '<LuaScript>createThread(f)</LuaScript>')).reasons)
      .toEqual([{ recordId: null, name: '', code: 'lua:unsupported', detail: 'createthread' }]);
    // native-ok.CT has a comment-only table script.
    expect(compileTable(table('native-ok.CT'))).toMatchObject({ native: true, tableLua: null });
  });

  it('a literal registerSymbol in the table script registers the name for the table', () => {
    const value = '<CheatEntry><ID>1</ID><Description>"HP"</Description><VariableType>4 Bytes</VariableType><Address>[pPlayer]+10</Address></CheatEntry>';
    const t = compileTable(ct(value, '<LuaScript>registerSymbol("pPlayer", getAddress("target.exe+100"))</LuaScript>'));
    expect(t.reasons).toEqual([]);
    expect(t.registeredBy).toEqual({ pplayer: -1 });
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

  it('a value record whose symbol nobody registers is sym:unresolved and the table is not native', () => {
    const v = (id: number, addr: string) =>
      `<CheatEntry><ID>${id}</ID><Description>"V${id}"</Description><VariableType>4 Bytes</VariableType><Address>${addr}</Address></CheatEntry>`;
    const t = compileTable(ct(v(1, '[pFoo]+10') + v(2, 'PFOO+8')));
    expect(t.records[0]).toMatchObject({ kind: 'unsupported', code: 'sym:unresolved', detail: 'pfoo' });
    expect(t.records[1]).toMatchObject({ kind: 'unsupported', code: 'sym:unresolved', detail: 'pfoo' });
    expect(t.native).toBe(false);
    expect(t.reasons.map((r) => [r.recordId, r.code])).toEqual([[1, 'sym:unresolved'], [2, 'sym:unresolved']]);
  });

  it('a value record whose symbol is registered stays native', () => {
    const reg = `<CheatEntry><ID>1</ID><Description>"Reg"</Description><VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]
globalalloc(pFoo,8)
[DISABLE]
</AssemblerScript></CheatEntry>`;
    const v = `<CheatEntry><ID>2</ID><Description>"V"</Description><VariableType>4 Bytes</VariableType><Address>[PFOO]+10</Address></CheatEntry>`;
    const t = compileTable(ct(reg + v));
    expect(t.registeredBy).toEqual({ pfoo: 1 });
    expect(t.records[1]).toMatchObject({ kind: 'value', address: { kind: 'symbol', expr: 'PFOO', offsets: ['0x10'] } });
    expect(t.reasons).toEqual([]);
    expect(t.native).toBe(true);
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

  it('Toggle Activation Allow Increase/Decrease hotkeys compile to toggle (CE: action <= 2)', () => {
    const hk = (action: string, key: number) => `<Hotkey><Action>${action}</Action><Keys><Key>${key}</Key></Keys></Hotkey>`;
    const t = compileTable(ct(
      `<CheatEntry><ID>1</ID><Description>"Gold"</Description><VariableType>4 Bytes</VariableType><Address>target.exe+10</Address>`
      + `<Hotkeys>${hk('Toggle Activation Allow Increase', 112)}${hk('Toggle Activation Allow Decrease', 113)}</Hotkeys></CheatEntry>`,
    ));
    expect(byId(t.records, 1).hotkeys).toEqual([
      { action: 'toggle', accelerator: 'F1' },
      { action: 'toggle', accelerator: 'F2' },
    ]);
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
