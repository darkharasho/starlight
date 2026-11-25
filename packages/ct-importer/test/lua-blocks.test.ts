import { describe, it, expect } from 'vitest';
import { luaBlocks, stripLuaBlocks, expandLuaBlocks, type LuaBlock } from '../src/lua-blocks.js';

const SCRIPT = [
  '[ENABLE]',            // 1
  '{$lua}',              // 2
  'return "nop"',        // 3
  '{$asm}',              // 4
  '[DISABLE]',           // 5
  '{$lua}',              // 6
  'writeInteger("a",0)', // 7
  '{$asm}',              // 8
].join('\n');

describe('luaBlocks', () => {
  it('finds blocks with the section they sit in and the line of {$lua}', () => {
    const b = luaBlocks(SCRIPT);
    expect(b.map((x) => [x.section, x.line])).toEqual([['enable', 2], ['disable', 6]]);
    // Chunk line 1 is the {$lua} line, so an error on chunk line N is script line `line + N - 1`.
    expect(b[0]!.code.split('\n')[1]).toBe('return "nop"');
  });

  it('luacall(x) is a block on its own line', () => {
    const b = luaBlocks('[ENABLE]\nalloc(m,$10)\nluacall(writeInteger("a",1))\n');
    expect(b).toEqual([{ code: 'writeInteger("a",1)', section: 'enable', line: 3 }]);
  });

  it('cosmetic blocks are not returned', () => {
    expect(luaBlocks('[ENABLE]\n{$lua}\nshowMessage("hi")\n{$asm}\n')).toEqual([]);
  });

  it('[ENABLE]/[DISABLE] inside a block split it; the lines before them belong to both', () => {
    const s = '{$lua}\nif syntaxcheck then return end\n[ENABLE]\nwriteInteger("a",1)\n[DISABLE]\nwriteInteger("a",0)\n';
    const b = luaBlocks(s);
    expect(b.map((x) => x.section)).toEqual(['enable', 'disable']);
    expect(b[0]!.code).toBe('\nif syntaxcheck then return end\n\nwriteInteger("a",1)\n\n\n');
    expect(b[1]!.code).toBe('\nif syntaxcheck then return end\n\n\n\nwriteInteger("a",0)\n');
    expect(b.every((x) => x.line === 1)).toBe(true);
  });
});

describe('stripLuaBlocks', () => {
  it('blanks blocks and luacall lines, keeping section markers and the line count', () => {
    const out = stripLuaBlocks(SCRIPT + '\nluacall(foo())');
    expect(out.split('\n')).toEqual(['[ENABLE]', '', '', '', '[DISABLE]', '', '', '', '']);
    expect(stripLuaBlocks('{$lua}\n[ENABLE]\nx()\n[DISABLE]\ny()\n{$asm}').split('\n')).toEqual(['', '[ENABLE]', '', '[DISABLE]', '', '']);
  });
});

describe('expandLuaBlocks', () => {
  it('splices what the blocks of the asked sections return and blanks the rest', async () => {
    const ran: LuaBlock[] = [];
    const out = await expandLuaBlocks(SCRIPT, ['pre', 'enable'], async (b) => { ran.push(b); return 'mov eax,1\nnop'; });
    expect(ran.map((b) => b.line)).toEqual([2]);
    expect(out.split('\n')).toEqual(['[ENABLE]', 'mov eax,1', 'nop', '', '', '[DISABLE]', '', '', '']);
  });

  it('expandLuaBlocks_return_types: null inserts nothing', async () => {
    const out = await expandLuaBlocks(SCRIPT, ['enable'], async () => null);
    expect(out).toBe(stripLuaBlocks(SCRIPT));
  });

  it('a split block puts the return inside its own section', async () => {
    const s = '{$lua}\n[ENABLE]\nreturn "nop"\n[DISABLE]\nreturn "ret"\n{$asm}';
    expect((await expandLuaBlocks(s, ['enable'], async (b) => (b.section === 'enable' ? 'nop' : 'ret'))).split('\n'))
      .toEqual(['', '[ENABLE]', 'nop', '[DISABLE]', '', '']);
  });
});

describe('a block that runs into the next section marker', () => {
  it('its lines before the marker belong to the section the block sits in', () => {
    const s = '[ENABLE]\n{$lua}\nOpenProcess("Game.exe")\n[DISABLE]\n';
    expect(luaBlocks(s)).toEqual([{ code: '\nOpenProcess("Game.exe")\n\n', section: 'enable', line: 2 }]);
    expect(stripLuaBlocks(s).split('\n')).toEqual(['[ENABLE]', '', '', '[DISABLE]', '']);
  });
});
