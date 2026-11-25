/** Why a table (or part of one) needs Cheat Engine instead of the native runner. */
export const REASON_CODES = [
  'lua:table-script', 'lua:script', 'lua:block', 'lua:unsupported', 'lua:runtime',
  'aa:no-enable', 'aa:createthread', 'aa:loadlibrary', 'aa:readmem', 'aa:struct', 'aa:aobscanregion',
  'aa:assert', 'aa:fullaccess', 'aa:include', 'aa:luacall', 'aa:reassemble', 'aa:loadbinary', 'aa:try',
  'aa:c-code', 'aa:directive', 'aa:unknown-command', 'aa:alloc-size', 'aa:name', 'aa:disable-write',
  'aa:pointer-origin', 'aa:parse',
  'sym:unresolved', 'sym:mono', 'asm:error', 'value:type', 'addr:expression', 'table:empty',
] as const;

/** `aa:script` is only used by the baseline. */
export type ReasonCode = typeof REASON_CODES[number] | 'aa:script';

const FALLBACK = 'This table needs Cheat Engine.';

const COPY: Record<string, string> = {
  'lua:table-script': 'This table runs Lua code when it loads.',
  'lua:script': 'A cheat in this table is a Lua script.',
  'lua:block': 'A script in this table runs Lua code.',
  'lua:unsupported': "A Lua script in this table uses something Starlight can't run yet.",
  'lua:runtime': "This table's Lua failed on Starlight's engine, so it runs in Cheat Engine.",
  'aa:no-enable': 'A script has no enable section to run.',
  'aa:createthread': 'A script starts its own thread in the game.',
  'aa:loadlibrary': 'A script loads an extra library into the game.',
  'aa:readmem': 'A script copies raw memory from the game.',
  'aa:struct': 'A script uses structure definitions Starlight does not support.',
  'aa:aobscanregion': 'A script scans a custom memory range for a pattern.',
  'aa:assert': 'A script checks the game code before it changes anything, which Starlight cannot do yet.',
  'aa:fullaccess': 'A script changes the protection of game memory.',
  'aa:include': 'A script includes another script.',
  'aa:luacall': 'A script calls Lua code.',
  'aa:reassemble': 'A script asks to re-assemble game code.',
  'aa:loadbinary': 'A script loads a binary file into the game.',
  'aa:try': 'A script uses try and except blocks.',
  'aa:c-code': 'A script contains C code.',
  'aa:directive': 'A script uses a Cheat Engine directive Starlight does not know.',
  'aa:unknown-command': 'A script uses a command Starlight does not know.',
  'aa:alloc-size': 'A script reserves memory in a way Starlight cannot work out.',
  'aa:name': 'A script uses a name Starlight cannot work with.',
  'aa:disable-write': 'A script changes memory when it turns off, which Starlight cannot undo cleanly.',
  'aa:pointer-origin': 'A script reads a pointer from a place Starlight cannot find.',
  'aa:parse': 'A script is written in a way Starlight cannot read.',
  'sym:unresolved': 'A script uses a name Starlight cannot find in the game.',
  'sym:mono': "A script uses Mono/IL2CPP names (needs Cheat Engine's Mono features).",
  'asm:error': "A script uses an instruction Starlight can't assemble yet.",
  'value:type': 'A cheat uses a value type Starlight cannot handle.',
  'addr:expression': 'A cheat uses an address formula Starlight cannot work out.',
  'table:empty': 'This table has no cheats to run.',
  'aa:script': 'A script in this table needs Cheat Engine to run.',
};

export function reasonCopy(code: string): string {
  return Object.prototype.hasOwnProperty.call(COPY, code) ? (COPY[code] ?? FALLBACK) : FALLBACK;
}
