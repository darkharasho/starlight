import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAaScript, type AaResult } from '../src/aa-compiler.js';
import { StarlightPatchCheatSchema } from '../src/starlight-format.js';
import { REASON_CODES } from '../src/reasons.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(HERE, 'fixtures/aa', name), 'utf8');
const O = { id: '7', name: 'Test cheat' };

function ok(r: AaResult) {
  if (!r.ok) throw new Error(`expected ok, got ${r.code} (${r.detail}) at line ${r.line}`);
  if (r.cheat) StarlightPatchCheatSchema.parse(r.cheat);
  return r;
}
function fail(r: AaResult) {
  if (r.ok) throw new Error('expected a failure');
  expect(REASON_CODES).toContain(r.code);
  return r;
}
/** 1-based line of the first line containing `needle`. */
const lineOf = (script: string, needle: string) => script.split('\n').findIndex((l) => l.includes(needle)) + 1;

const PATTERN = '8B 05 ?? ?? ?? ?? 83 C0 01';

describe('compileAaScript', () => {
  it('compiles the CE AOB-injection template', () => {
    const r = ok(compileAaScript(fixture('template-injection.cea'), O));
    expect(r.cheat).toEqual({
      id: '7',
      name: 'Test cheat',
      type: 'patch',
      site: { kind: 'aob', module: 'target', pattern: PATTERN },
      enable: [
        { op: 'aobScan', name: 'INJECT', module: 'target', pattern: PATTERN },
        { op: 'alloc', name: 'newmem', size: 4096, near: 'INJECT' },
        { op: 'assemble', at: 'newmem', source: 'code:\nmov eax,["target"+4030A019]\nadd eax,64\njmp return' },
        { op: 'assemble', at: 'INJECT', source: 'jmp newmem\nnop 4\nreturn:' },
        { op: 'registerSymbol', name: 'INJECT', at: 'INJECT' },
      ],
      disable: [
        { op: 'writeBytes', at: 'INJECT', bytes: '8b051020304083c001' },
        { op: 'unregisterSymbol', name: 'INJECT' },
      ],
    });
    expect(r.registers).toEqual(['inject']);
    expect(r.uses).toEqual([]);
  });

  it('orders alloc segments before site segments even when the site comes first in the source', () => {
    const script = [
      '[ENABLE]',
      'aobscanmodule(INJECT,target,' + PATTERN + ')',
      'alloc(newmem,$1000,INJECT)',
      'label(return)',
      'INJECT:',
      '  jmp newmem',
      '  nop 4',
      'return:',
      'newmem:',
      '  mov eax,#999',
      '  jmp return',
      '[DISABLE]',
      'INJECT:',
      '  db 8B 05 10 20 30 40 83 C0 01',
    ].join('\n');
    const r = ok(compileAaScript(script, O));
    expect(r.cheat!.enable).toEqual([
      { op: 'aobScan', name: 'INJECT', module: 'target', pattern: PATTERN },
      { op: 'alloc', name: 'newmem', size: 4096, near: 'INJECT' },
      { op: 'assemble', at: 'newmem', source: 'mov eax,#999\njmp return' },
      { op: 'assemble', at: 'INJECT', source: 'jmp newmem\nnop 4\nreturn:' },
    ]);
  });

  it('two aobscans: the first is the site, both are aobScan steps', () => {
    const r = ok(compileAaScript(fixture('two-aobs.cea'), O));
    expect(r.cheat).toEqual({
      id: '7',
      name: 'Test cheat',
      type: 'patch',
      site: { kind: 'aob', module: 'target', pattern: '29 47 10 8B 47 10' },
      enable: [
        { op: 'aobScan', name: 'DAMAGE', module: 'target', pattern: '29 47 10 8B 47 10' },
        { op: 'aobScan', name: 'HEAL', pattern: '01 47 10 C3' },
        { op: 'alloc', name: 'newmem', size: 256, near: 'DAMAGE' },
        { op: 'assemble', at: 'newmem', source: 'code:\nmov eax,[rdi+10]\njmp return' },
        { op: 'assemble', at: 'DAMAGE', source: 'jmp newmem\nnop\nreturn:' },
        { op: 'assemble', at: 'HEAL+2', source: 'db 90' },
      ],
      disable: [
        { op: 'writeBytes', at: 'DAMAGE', bytes: '2947108b4710' },
        { op: 'writeBytes', at: 'HEAL+2', bytes: '10' },
      ],
    });
    expect(r.registers).toEqual([]);
    expect(r.uses).toEqual([]);
  });

  it('2-argument alloc is near the first aob, else the first module origin', () => {
    const r = ok(compileAaScript(fixture('module-offset.cea'), O));
    expect(r.cheat).toEqual({
      id: '7',
      name: 'Test cheat',
      type: 'patch',
      enable: [
        { op: 'alloc', name: 'newmem', size: 0x2048, near: '"target"+1234' },
        {
          op: 'assemble', at: 'newmem',
          source: 'mov dword ptr [rbx+20],#999\noriginalcode:\nmov eax,[rbx+20]\nexit:\njmp returnhere',
        },
        { op: 'assemble', at: '"target"+1234', source: 'jmp newmem\nreturnhere:' },
      ],
      disable: [{ op: 'writeBytes', at: '"target"+1234', bytes: '8b432089c1' }],
    });
    expect(r.uses).toEqual([]);

    // The first aob wins even when it comes after the alloc; no aob and no module origin → no near.
    const later = ok(compileAaScript('[ENABLE]\nalloc(mem,#64)\naobscan(A,90 90)\nmem:\nret\n', O));
    expect(later.cheat!.enable[1]).toEqual({ op: 'alloc', name: 'mem', size: 64, near: 'A' });
    const none = ok(compileAaScript('[ENABLE]\nalloc(mem,40)\nmem:\nret\n', O));
    expect(none.cheat!.enable[0]).toEqual({ op: 'alloc', name: 'mem', size: 0x40 });
  });

  it('globalalloc allocates and registers', () => {
    const r = ok(compileAaScript(fixture('globalalloc-symbol.cea'), O));
    expect(r.cheat!.enable).toEqual([
      { op: 'aobScan', name: 'PLAYER_AOB', module: 'target', pattern: '48 8B 43 18 8B 40 10' },
      { op: 'alloc', name: 'pPlayer', size: 8, near: 'PLAYER_AOB' },
      { op: 'alloc', name: 'newmem', size: 4096, near: 'PLAYER_AOB' },
      { op: 'assemble', at: 'newmem', source: 'mov [pPlayer],rbx\ncode:\nmov rax,[rbx+18]\nmov eax,[rax+10]\njmp return' },
      { op: 'assemble', at: 'PLAYER_AOB', source: 'jmp newmem\nnop 2\nreturn:' },
      { op: 'registerSymbol', name: 'pPlayer', at: 'pPlayer' },
      { op: 'registerSymbol', name: 'PLAYER_AOB', at: 'PLAYER_AOB' },
    ]);
    expect(r.cheat!.disable).toEqual([
      { op: 'writeBytes', at: 'PLAYER_AOB', bytes: '488b43188b4010' },
      { op: 'unregisterSymbol', name: 'PLAYER_AOB' },
    ]);
    expect(r.registers).toEqual(['pplayer', 'player_aob']);
    expect(r.uses).toEqual([]);
  });

  it('define substitutes whole words, case-insensitively, including in db', () => {
    const r = ok(compileAaScript(fixture('define-bytes.cea'), O));
    expect(r.cheat).toEqual({
      id: '7',
      name: 'Test cheat',
      type: 'patch',
      enable: [
        { op: 'alloc', name: 'newmem', size: 4096, near: '"target"+1234' },
        { op: 'assemble', at: 'newmem', source: 'code:\nmov eax,#100\njmp return\nbytes2:\ndd 0' },
        { op: 'assemble', at: '"target"+1234', source: 'jmp newmem\nnop\nreturn:' },
      ],
      disable: [{ op: 'writeBytes', at: '"target"+1234', bytes: '8b0510203040' }],
    });
    expect(r.uses).toEqual([]);
  });

  it('symbol+offset and module+offset origins become step addresses', () => {
    const script = [
      '[ENABLE]',
      'aobscanmodule(INJECT,target,' + PATTERN + ')',
      'INJECT+2:',
      '  db 90 90',
      'target.exe+1A0:',
      '  db 90',
      '"target"+1B0:',
      '  db 90',
      '0x7ff612340000:',
      '  db 90',
      '[DISABLE]',
      'inject+2:',
      '  db 10 20',
    ].join('\n');
    const r = ok(compileAaScript(script, O));
    expect(r.cheat!.enable.slice(1)).toEqual([
      { op: 'assemble', at: 'INJECT+2', source: 'db 90 90' },
      { op: 'assemble', at: 'target.exe+1A0', source: 'db 90' },
      { op: 'assemble', at: '"target"+1B0', source: 'db 90' },
      { op: 'assemble', at: '0x7ff612340000', source: 'db 90' },
    ]);
    // R16: the disable origin matches the enable origin case-insensitively.
    expect(r.cheat!.disable).toEqual([{ op: 'writeBytes', at: 'inject+2', bytes: '1020' }]);
    expect(r.uses).toEqual([]);
  });

  it('uses lists names defined elsewhere', () => {
    const script = [
      '[ENABLE]',
      'aobscanmodule(INJECT,target,' + PATTERN + ')',
      'alloc(newmem,$1000,INJECT)',
      'label(return)',
      'newmem:',
      '  mov rax,[pPlayer]',
      '  mov rcx,[PPLAYER+8]',
      '  mov dword ptr [rax+10],(float)100',
      '  cmp qword ptr [pInventory],0',
      '  jmp return',
      'INJECT:',
      '  jmp newmem',
      '  nop 4',
      'return:',
      '[DISABLE]',
      'INJECT:',
      '  db 8B 05 10 20 30 40 83 C0 01',
    ].join('\n');
    const r = ok(compileAaScript(script, O));
    expect(r.uses).toEqual(['pplayer', 'pinventory']);
    expect(r.registers).toEqual([]);
  });

  it('{$lua} blocks are lua:block with the line', () => {
    const script = fixture('lua-block.cea');
    const r = fail(compileAaScript(script, O));
    expect(r).toEqual({ ok: false, code: 'lua:block', detail: '{$lua}', line: lineOf(script, '{$lua}') });
  });

  it('createthread is aa:createthread', () => {
    const ct = fixture('createthread.cea');
    expect(fail(compileAaScript(ct, O))).toEqual({
      ok: false, code: 'aa:createthread', detail: 'createthread(newmem)', line: lineOf(ct, 'createthread('),
    });
    expect(fail(compileAaScript('[ENABLE]\ncreatethreadandwait(x)\n', O)).code).toBe('aa:createthread');
    expect(fail(compileAaScript('[ENABLE]\nstruct Player\nhp: dd ?\nendstruct\n', O)).code).toBe('aa:struct');
    expect(fail(compileAaScript('[ENABLE]\n{$try}\n', O)).code).toBe('aa:try');
    expect(fail(compileAaScript('[ENABLE]\n{$ccode x=eax}\n', O)).code).toBe('aa:c-code');
    expect(fail(compileAaScript('[ENABLE]\n{$foo}\n', O)).code).toBe('aa:directive');
  });

  it('a Class:Method name is in uses with its colon', () => {
    const r = ok(compileAaScript(fixture('mono-symbol.cea'), O));
    expect(r.uses).toEqual(['playercontroller:update']);
    expect(r.cheat!.enable).toEqual([
      { op: 'alloc', name: 'newmem', size: 4096, near: 'PlayerController:Update+1A' },
      { op: 'assemble', at: 'newmem', source: 'mov [rbx+3C],(float)100\ncode:\nmovss xmm0,[rbx+3C]\njmp return' },
      { op: 'assemble', at: 'PlayerController:Update+1A', source: 'jmp newmem\nreturn:' },
    ]);
    expect(r.cheat!.disable).toEqual([{ op: 'writeBytes', at: 'PlayerController:Update+1A', bytes: 'f30f10433c' }]);
  });

  it('a script without [ENABLE] is aa:no-enable', () => {
    expect(fail(compileAaScript(fixture('no-sections.cea'), O))).toMatchObject({ code: 'aa:no-enable', line: null });
    // [ENABLE] inside a comment doesn't count
    expect(fail(compileAaScript('{ [ENABLE] }\n// [ENABLE]\n"target"+10:\ndb 90\n', O)).code).toBe('aa:no-enable');
  });

  it('a label declared after its use compiles like the in-order script', () => {
    const inOrder = fixture('template-injection.cea');
    // move label(return) below the `jmp return` and `return:` lines that use it
    const late = inOrder.replace('label(return)\n', '').replace('registersymbol(INJECT)\n', 'registersymbol(INJECT)\nlabel(return)\n');
    expect(late).not.toBe(inOrder);
    expect(late.indexOf('label(return)')).toBeGreaterThan(late.indexOf('return:'));
    expect(late.indexOf('label(return)')).toBeGreaterThan(late.indexOf('jmp return'));
    const r = ok(compileAaScript(late, O));
    expect(r).toEqual(ok(compileAaScript(inOrder, O)));
    expect(r.cheat!.enable[3]).toEqual({ op: 'assemble', at: 'INJECT', source: 'jmp newmem\nnop 4\nreturn:' });
  });

  it('an [ENABLE] with no statements is a no-op script', () => {
    expect(compileAaScript('[ENABLE]\n// nothing\n[DISABLE]\n', O)).toEqual({ ok: true, cheat: null, registers: [], uses: [] });
  });

  it('a disable write to an address enable never wrote is aa:disable-write', () => {
    const script = fixture('disable-elsewhere.cea');
    expect(fail(compileAaScript(script, O))).toEqual({
      ok: false, code: 'aa:disable-write', detail: 'INJECT+20:', line: lineOf(script, 'INJECT+20:'),
    });
  });

  it('labels belong to their section: [DISABLE] writes back through a label enable placed and registered', () => {
    const script = [
      '[ENABLE]',
      'aobscanmodule(hook_AOB,game.exe,8B 44 24 04 8B 48 10 0F B6 11)',
      'alloc(newmem,$100,game.exe)',
      'label(hook)',
      'label(back)',
      'registersymbol(hook)',
      'newmem:',
      '  jmp back',
      'hook_AOB+7:',
      'hook:',
      '  jmp newmem',
      'back:',
      '[DISABLE]',
      'hook:',
      '  db 0F B6 11',
      'unregistersymbol(hook)',
      'dealloc(newmem)',
    ].join('\n');
    const r = compileAaScript(script, O);
    if (!r.ok) throw new Error(`${r.code} ${r.line}: ${r.detail}`);
    expect(r.cheat!.disable).toEqual([
      { op: 'writeBytes', at: 'hook', bytes: '0fb611' },
      { op: 'unregisterSymbol', name: 'hook' },
    ]);
    expect(r.registers).toEqual(['hook']);
    expect(r.uses).toEqual([]);
    // A label enable declared but never registered isn't known when disabling.
    const unregistered = script.replace('registersymbol(hook)', '').replace('unregistersymbol(hook)', '');
    expect(fail(compileAaScript(unregistered, O))).toMatchObject({ ok: false, code: 'aa:disable-write', detail: 'hook:' });
    // Nor is one placed in the alloc'd cave: enable never patched game code there.
    const inCave = script.replace('newmem:\n  jmp back', 'newmem:\nhook:\n  jmp back').replace('hook_AOB+7:\nhook:\n', 'hook_AOB+7:\n');
    expect(fail(compileAaScript(inCave, O))).toMatchObject({ ok: false, code: 'aa:disable-write', detail: 'hook:' });
  });

  it('a pointer origin is aa:pointer-origin', () => {
    const r = fail(compileAaScript('[ENABLE]\n[pBase+10]:\n  db 90\n', O));
    expect(r).toEqual({ ok: false, code: 'aa:pointer-origin', detail: '[pBase+10]:', line: 2 });
  });

  it('unknown commands are aa:unknown-command with the name', () => {
    const r = fail(compileAaScript('[ENABLE]\nalloc(newmem,$100)\nfoo(1)\n', O));
    expect(r).toEqual({ ok: false, code: 'aa:unknown-command', detail: 'foo(1)', line: 3 });
  });

  it('alloc over 0x10000 is aa:alloc-size', () => {
    expect(fail(compileAaScript('[ENABLE]\nalloc(newmem,$10001)\n', O))).toEqual({
      ok: false, code: 'aa:alloc-size', detail: 'alloc(newmem,$10001)', line: 2,
    });
    expect(ok(compileAaScript('[ENABLE]\nalloc(newmem,$10000)\nnewmem:\nret\n', O)).cheat!.enable[0])
      .toEqual({ op: 'alloc', name: 'newmem', size: 0x10000 });
    expect(fail(compileAaScript('[ENABLE]\nglobalalloc(big,#70000)\n', O)).code).toBe('aa:alloc-size');
  });

  it('names that are not identifiers are aa:name', () => {
    const r = fail(compileAaScript('[ENABLE]\nalloc(newmem,$100)\nlabel(my-label)\n', O));
    expect(r).toEqual({ ok: false, code: 'aa:name', detail: 'label(my-label)', line: 3 });
    expect(fail(compileAaScript('[ENABLE]\nregistersymbol(9lives)\n', O)).code).toBe('aa:name');
  });

  it('name lists may be separated by spaces as well as commas', () => {
    const r = ok(compileAaScript('[ENABLE]\nalloc(newmem,$100)\nlabel(code return)\nregistersymbol(a b,c)\nnewmem:\ncode:\njmp return\nreturn:\na:\nb:\nc:\n', O));
    expect(r.registers).toEqual(['a', 'b', 'c']);
    expect(r.uses).toEqual([]);
  });

  it('unregistersymbol(*) unregisters everything the script registered', () => {
    const r = ok(compileAaScript('[ENABLE]\nglobalalloc(pBase,8)\nalloc(m,$10)\nlabel(x)\nregistersymbol(x)\nm:\nx:\ndq 0\n[DISABLE]\nunregistersymbol(*)\ndealloc(m)\n', O));
    expect(r.cheat!.disable).toEqual([
      { op: 'unregisterSymbol', name: 'pBase' },
      { op: 'unregisterSymbol', name: 'x' },
    ]);
  });

  it('@@: stays in the code as an anonymous label', () => {
    const r = ok(compileAaScript('[ENABLE]\nalloc(newmem,$100)\nnewmem:\ncmp eax,1\njne @f\nmov eax,2\n@@:\nret\n', O));
    expect(r.cheat!.enable[1]).toEqual({ op: 'assemble', at: 'newmem', source: 'cmp eax,1\njne @f\nmov eax,2\n@@:\nret' });
    expect(r.uses).toEqual([]);
  });

  it('cosmetic {$lua} blocks are skipped; their [ENABLE]/[DISABLE] still count', () => {
    const script = '{$lua}\nif syntaxcheck then return end\n[ENABLE]\nshellExecute("https://x.y")\n[DISABLE]\n{$asm}\n';
    expect(ok(compileAaScript(script, O)).cheat).toBeNull();
    const mixed = '[ENABLE]\nalloc(m,$10)\n{$lua}\nshowMessage("on")\n{$asm}\nm:\nret\n';
    expect(ok(compileAaScript(mixed, O)).cheat!.enable).toEqual([
      { op: 'alloc', name: 'm', size: 16 },
      { op: 'assemble', at: 'm', source: 'ret' },
    ]);
    expect(fail(compileAaScript('[ENABLE]\n{$lua}\nwriteInteger("x",1)\n{$asm}\n', O))).toMatchObject({ code: 'lua:block', line: 2 });
  });

  it('readmem stays in the segment for the engine to fill in', () => {
    const r = ok(compileAaScript(fixture('readmem.cea'), O));
    expect(r.cheat!.enable).toEqual([
      { op: 'aobScan', name: 'INJECT', module: 'target', pattern: PATTERN },
      { op: 'alloc', name: 'newmem', size: 4096, near: 'INJECT' },
      { op: 'assemble', at: 'newmem', source: 'readmem(INJECT,9)\njmp return' },
      { op: 'assemble', at: 'INJECT', source: 'jmp newmem\nnop 4\nreturn:' },
    ]);
    expect(r.cheat!.disable).toEqual([{ op: 'assemble', at: 'INJECT', source: 'readmem(newmem,9)' }]);
    expect(fail(compileAaScript('[ENABLE]\nalloc(m,$10)\nm:\nreadmem(m,%d)\n', O)).code).toBe('aa:readmem');
  });

  it('a nop with no origin is ignored (link-only records)', () => {
    const script = "{$lua}\nif syntaxcheck then return end\n[ENABLE]\nShellExecute('https://x.y')\n{$asm}\nnop\n[DISABLE]\n";
    expect(ok(compileAaScript(script, O)).cheat).toBeNull();
    expect(fail(compileAaScript('[ENABLE]\nnop 2\n', O)).code).toBe('aa:parse');
  });

  it('luacall of cosmetic Lua is skipped; other luacall is aa:luacall', () => {
    expect(ok(compileAaScript("[ENABLE]\nluacall(showMessage('hi'))\n[DISABLE]\n", O)).cheat).toBeNull();
    expect(fail(compileAaScript('[ENABLE]\nluacall(speedhack_setSpeed(2))\n', O)).code).toBe('aa:luacall');
  });

  it('assert becomes an assert step before the allocs; a [DISABLE] assert is dropped', () => {
    const r = ok(compileAaScript('[ENABLE]\nalloc(m,$10)\nassert("target.exe"+10,8B 05 ??)\nm:\nret\n[DISABLE]\nassert("target.exe"+10,8B)\n', O));
    expect(r.cheat!.enable.slice(0, 2)).toEqual([
      { op: 'assert', at: '"target.exe"+10', pattern: '8B 05 ??' },
      { op: 'alloc', name: 'm', size: 16 },
    ]);
    expect(r.cheat!.disable).toBeUndefined();
    expect(ok(compileAaScript('[ENABLE]\nassert(pPlayer+4,90)\n', O)).uses).toEqual(['pplayer']);
    expect(fail(compileAaScript('[ENABLE]\nassert(x)\n', O)).code).toBe('aa:assert');
  });

  it('x is a wildcard in AOB patterns', () => {
    const r = ok(compileAaScript('[ENABLE]\naobscanmodule(a,game.exe,74xxe8xxxxxxxx48)\na:\nnop\n', O));
    expect(r.cheat!.enable[0]).toEqual({ op: 'aobScan', name: 'a', module: 'game.exe', pattern: '74 ?? e8 ?? ?? ?? ?? 48' });
  });

  it('code before any origin is aa:parse', () => {
    const r = fail(compileAaScript('[ENABLE]\nalloc(newmem,$100)\n  mov eax,1\nnewmem:\n', O));
    expect(r).toEqual({ ok: false, code: 'aa:parse', detail: 'mov eax,1', line: 3 });
    // db with wildcards in [DISABLE] can't be written back
    expect(fail(compileAaScript(`[ENABLE]\naobscanmodule(INJECT,target,${PATTERN})\nINJECT:\nnop\n[DISABLE]\nINJECT:\ndb 8B ??\n`, O)))
      .toMatchObject({ code: 'aa:parse', line: 7 });
  });

  it('comments, including multi-line braces, are removed but {$…} directives are seen', () => {
    const script = [
      '{$strict}',                                  // 1: ignored
      '[ENABLE] // turn on',                        // 2
      '{ a comment that',                           // 3
      '  spans lines with foo(1) and [pBase]:',     // 4
      '}',                                          // 5
      'alloc(newmem,$100) { trailing }',            // 6
      'newmem: // the cave',                        // 7
      "  db 'a//b{c}' // text in quotes is kept",   // 8
      '  ret',                                      // 9
      '{$asm}',                                     // 10: ignored
      '{ unterminated? no: } {$lua} openProcess(1)', // 11: the directive after a comment is seen
    ].join('\n');
    const r = fail(compileAaScript(script, O));
    expect(r).toEqual({ ok: false, code: 'lua:block', detail: '{$lua}', line: 11 });

    const clean = ok(compileAaScript(script.split('\n').slice(0, 10).join('\n'), O));
    expect(clean.cheat!.enable).toEqual([
      { op: 'alloc', name: 'newmem', size: 256 },
      { op: 'assemble', at: 'newmem', source: "db 'a//b{c}'\nret" },
    ]);
  });
});
