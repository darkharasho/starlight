/**
 * Static check of a table's Lua against what Starlight's Lua runtime (starlightd)
 * provides. Routing uses it: a table only runs natively when every function its
 * Lua calls is supported, and when none of its Lua relies on things that would
 * silently do nothing there (UI event handlers, the address list).
 */
import api from './lua-api.json' with { type: 'json' };
import { stripLua } from './lua-cosmetic.js';

const API = new Set([...api.real, ...api.inert]);

/** Lua 5.3 base functions the sandbox keeps. `load`/`loadstring`/`dofile`/`require` are not here. */
const BASE = new Set([
  'assert', 'error', 'ipairs', 'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset',
  'select', 'setmetatable', 'getmetatable', 'tonumber', 'tostring', 'type', 'xpcall', 'unpack', 'collectgarbage',
]);
const LIBS = new Set(['string', 'table', 'math', 'utf8', 'coroutine']);
const OS_OK = new Set(['clock', 'time', 'date']);
/** CE globals that are objects (methods on them are inert or provided). */
const OBJECTS = new Set(['memrec', 'addresslist', 'mainform']);
const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local',
  'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

export interface LuaScan {
  /** Unsupported functions (lowercase) and rule names (`ui-callback`, `addresslist-write`), in source order. */
  unsupported: string[];
  /** Literal names passed to registerSymbol, lowercased. */
  registers: string[];
}

/** Names the code itself defines: functions, locals, parameters and loop variables. */
function definedNames(code: string): Set<string> {
  const out = new Set<string>();
  const add = (list: string) => {
    for (const n of list.split(',')) { const t = n.trim(); if (/^[A-Za-z_]\w*$/.test(t)) out.add(t.toLowerCase()); }
  };
  for (const m of code.matchAll(/\bfunction\s+([\w.:]+)\s*\(([^)]*)\)/g)) {
    out.add(m[1]!.split(/[.:]/).pop()!.toLowerCase());
    add(m[2]!);
  }
  for (const m of code.matchAll(/\bfunction\s*\(([^)]*)\)/g)) add(m[1]!);
  for (const m of code.matchAll(/\blocal\s+(?!function\b)([\w\s,]+?)\s*=/g)) add(m[1]!);
  for (const m of code.matchAll(/(?:^|[;\s])([A-Za-z_]\w*)\s*=\s*function\b/g)) add(m[1]!);
  for (const m of code.matchAll(/\bfor\s+([\w\s,]+?)\s+(?:in|=)/g)) add(m[1]!);
  return out;
}

export function scanLua(src: string): LuaScan {
  const code = stripLua(src);
  const defined = definedNames(code);
  const hits: Array<{ at: number; name: string }> = [];

  for (const m of code.matchAll(/(?<![.:\w)\]])([A-Za-z_]\w*)((?:\s*[.:]\s*[A-Za-z_]\w*)*)\s*\(/g)) {
    const base = m[1]!.toLowerCase();
    const members = m[2]!.split(/[.:]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (KEYWORDS.has(base) || defined.has(base)) continue;
    if (members.length === 0) {
      if (BASE.has(base) || API.has(base)) continue;
      hits.push({ at: m.index!, name: base });
      continue;
    }
    if (LIBS.has(base) || OBJECTS.has(base) || API.has(base)) continue;
    if (base === 'os' && OS_OK.has(members[0]!)) continue;
    hits.push({ at: m.index!, name: ['os', 'io', 'debug', 'package'].includes(base) ? `${base}.${members[0]}` : base });
  }

  const rule = (re: RegExp, name: string) => {
    const m = re.exec(code);
    if (m) hits.push({ at: m.index, name });
  };
  rule(/\.\s*On[A-Z]\w*\s*=(?!=)/, 'ui-callback');
  rule(/getMemoryRecord\w*\s*\(|\bmemrec\s*\.\s*(?:Active|Value)\s*=(?!=)|[.:]\s*(?:setActive|doClick)\s*\(|\bAddressList\s*\[/i, 'addresslist-write');

  const unsupported: string[] = [];
  for (const h of hits.sort((a, b) => a.at - b.at)) if (!unsupported.includes(h.name)) unsupported.push(h.name);

  // Literal names need the strings, so this reads the code with comments removed only.
  const noComments = src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, ' ').replace(/--[^\n]*/g, ' ');
  const registers: string[] = [];
  for (const m of noComments.matchAll(/\bregisterSymbol\s*\(\s*(["'])([A-Za-z_]\w*)\1/gi)) {
    const n = m[2]!.toLowerCase();
    if (!registers.includes(n)) registers.push(n);
  }
  return { unsupported, registers };
}
