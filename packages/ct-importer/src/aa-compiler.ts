/**
 * Compiles the common Cheat Engine Auto Assembler subset into a v2 `patch` cheat.
 * The mapping (step order, origins, names, reason codes) is the M4 "AA → v2 patch" reference.
 * All name lookups are case-insensitive (lowercased), as in CE.
 */
import type { StarlightPatchCheat, StarlightPatchStep } from './starlight-format.js';
import type { ReasonCode } from './reasons.js';

export type AaResult =
  | { ok: true; cheat: StarlightPatchCheat | null; registers: string[]; uses: string[] }
  | { ok: false; code: ReasonCode; detail: string; line: number | null };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ALLOC = 0x10000;
const MAX_SOURCE = 16384;

class AaError extends Error {
  constructor(readonly code: ReasonCode, readonly detail: string, readonly line: number | null) {
    super(detail);
  }
}

// ---------------------------------------------------------------------------
// Comments

interface Cleaned { lines: string[]; unterminatedAt: number | null }

/**
 * Removes `//…` and `{ … }` comments, keeping text in quotes and `{$…}` directives.
 * Line count is preserved so line numbers stay those of the original script.
 */
function stripComments(script: string): Cleaned {
  const src = script.replace(/\r\n?/g, '\n');
  let out = '';
  let line = 1;
  let unterminatedAt: number | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') { out += c; line++; i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j++;
      const end = j < src.length && src[j] === c ? j + 1 : j;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '{') {
      const close = src.indexOf('}', i);
      if (src[i + 1] === '$') {
        if (close < 0 || src.slice(i, close).includes('\n')) {
          unterminatedAt ??= line;
          out += src.slice(i, close < 0 ? src.length : i + 1);
          i = close < 0 ? src.length : i + 1;
          continue;
        }
        out += src.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      if (close < 0) {
        unterminatedAt ??= line;
        // keep the newlines so later line numbers stay right
        out += src.slice(i).replace(/[^\n]/g, '');
        break;
      }
      const body = src.slice(i, close + 1);
      const nl = body.replace(/[^\n]/g, '');
      out += nl;
      line += nl.length;
      i = close + 1;
      continue;
    }
    out += c;
    i++;
  }
  return { lines: out.split('\n'), unterminatedAt };
}

// ---------------------------------------------------------------------------
// Small parsers

/** Splits on commas outside quotes, parentheses and brackets. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const c of s) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

/** `$hex`, `0xhex`, `#dec` or bare hex. */
function parseSize(s: string): number | null {
  const t = s.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^#(\d+)$/))) return Number(m[1]);
  if ((m = t.match(/^(?:\$|0x)?([0-9a-f]+)$/i))) return parseInt(m[1]!, 16);
  return null;
}

/** Space-separated byte tokens; `?`/`*` become `??`; an unspaced pattern is split into pairs. */
function normalizePattern(p: string): string | null {
  let t = p.trim();
  if (t === '') return null;
  if (!/\s/.test(t) && t.length > 2 && t.length % 2 === 0) t = t.match(/../g)!.join(' ');
  const toks = t.split(/\s+/).map((x) => (x === '?' || x === '*' ? '??' : x));
  if (!toks.every((x) => /^[0-9a-f?*]{1,2}$/i.test(x))) return null;
  return toks.join(' ');
}

const MODULE_NAME = /^[^\s"+\-[\]]+\.(?:exe|dll|so(?:\.[0-9.]+)?)$/i;
const isModuleName = (s: string) => MODULE_NAME.test(s);

const REGISTER = new RegExp(
  '^(?:' + [
    'r[a-d]x', 'e[a-d]x', '[a-d][xlh]', 'r(?:si|di|bp|sp)', 'e(?:si|di|bp|sp)', '(?:si|di|bp|sp)l?',
    'r(?:[89]|1[0-5])[dwbl]?', '[c-gs]s', '[re]?ip', '[xyz]mm(?:[0-9]|[12][0-9]|3[01])', 'mm[0-7]',
    'st(?:[0-7])?', 'cr[0-8]', 'dr[0-7]', 'k[0-7]',
  ].join('|') + ')$', 'i',
);
const KEYWORDS = new Set([
  'byte', 'word', 'dword', 'qword', 'tbyte', 'tword', 'oword', 'xmmword', 'ymmword', 'zmmword', 'ptr',
  'short', 'near', 'far', 'float', 'double', 'int',
]);
const PREFIXES = new Set(['lock', 'rep', 'repe', 'repz', 'repne', 'repnz', 'xacquire', 'xrelease', 'bnd', 'notrack']);

/** Symbol-like tokens in an operand string (quoted text, numbers, `$…`/`#…`/`@…` skipped). */
function symbolTokens(s: string): string[] {
  const noStrings = s.replace(/"[^"]*"|'[^']*'/g, ' ');
  const re = /(?<![\w.$#@])([A-Za-z_]\w*(?:\.\w+)*(?::[A-Za-z_]\w*(?:\.\w+)*)?)/g;
  return [...noStrings.matchAll(re)].map((m) => m[1]!);
}

/** Operands of one source line: leading labels and the mnemonic (with prefixes) are removed. */
function operandsOf(line: string, labels: Set<string>): string {
  let t = line;
  for (;;) {
    const m = t.match(/^([A-Za-z_]\w*):\s*/);
    if (!m || !labels.has(m[1]!.toLowerCase())) break;
    t = t.slice(m[0].length);
  }
  for (;;) {
    const m = t.match(/^([A-Za-z_][\w.]*)\s*/);
    if (!m) return t;
    t = t.slice(m[0].length);
    if (!PREFIXES.has(m[1]!.toLowerCase())) return t;
  }
}

// ---------------------------------------------------------------------------
// Origins

type OriginKind = 'name' | 'module' | 'absolute';
interface Origin { at: string; base: string | null; kind: OriginKind }

const OFFSETS = String.raw`(?:\s*[+-]\s*(?:0x)?[0-9a-f]+)*`;
const ORIGIN_QUOTED = new RegExp(String.raw`^"([^"]+)"${OFFSETS}$`, 'i');
const ORIGIN_NAME = new RegExp(String.raw`^([A-Za-z_][\w.]*(?::[A-Za-z_][\w.]*)?)${OFFSETS}$`, 'i');
const ORIGIN_HEX = /^(?:0x)?[0-9a-f]+$/i;

function parseOrigin(body: string, line: number, statement: string): Origin {
  const at = body.trim();
  if (at.startsWith('[')) throw new AaError('aa:pointer-origin', statement, line);
  let m: RegExpMatchArray | null;
  if ((m = at.match(ORIGIN_QUOTED))) return { at, base: m[1]!, kind: 'module' };
  // A leading letter is a name (CE looks symbols up first); a leading digit is an address.
  if (/^[0-9]/.test(at) && ORIGIN_HEX.test(at)) return { at, base: null, kind: 'absolute' };
  if ((m = at.match(ORIGIN_NAME))) {
    const base = m[1]!;
    return { at, base, kind: isModuleName(base) ? 'module' : 'name' };
  }
  throw new AaError('aa:parse', statement, line);
}

// ---------------------------------------------------------------------------
// Commands

const UNSUPPORTED: Record<string, ReasonCode> = {
  createthread: 'aa:createthread',
  createthreadandwait: 'aa:createthread',
  loadlibrary: 'aa:loadlibrary',
  readmem: 'aa:readmem',
  struct: 'aa:struct',
  endstruct: 'aa:struct',
  aobscanregion: 'aa:aobscanregion',
  assert: 'aa:assert',
  fullaccess: 'aa:fullaccess',
  include: 'aa:include',
  luacall: 'aa:luacall',
  reassemble: 'aa:reassemble',
  loadbinary: 'aa:loadbinary',
};

function directiveCode(word: string): ReasonCode | null {
  const w = word.toLowerCase();
  if (w === 'asm' || w === 'strict') return null;
  if (w === 'lua' || w === 'luacode') return 'lua:block';
  if (w === 'try' || w === 'except') return 'aa:try';
  if (w === 'c' || w === 'ccode') return 'aa:c-code';
  return 'aa:directive';
}

// ---------------------------------------------------------------------------
// Compiler

type Section = 'pre' | 'enable' | 'disable';
interface Segment { origin: Origin; line: number; text: string; lines: string[]; lineNos: number[] }
interface Alloc { name: string; size: number; near: string | null; line: number }
interface Aob { name: string; module?: string; pattern: string }

function substitute(text: string, defines: Map<string, string>): string {
  if (defines.size === 0) return text;
  return text.replace(/[A-Za-z_]\w*/g, (w, offset: number, whole: string) => {
    const prev = offset > 0 ? whole[offset - 1] : '';
    if (prev && /[\w.$#@]/.test(prev)) return w;
    const v = defines.get(w.toLowerCase());
    return v ?? w;
  });
}

function compile(script: string, o: { id: string; name: string }): AaResult {
  const { lines, unterminatedAt } = stripComments(script);

  if (!lines.some((l) => /^\s*\[enable\]\s*$/i.test(l))) {
    throw new AaError('aa:no-enable', 'no [ENABLE] section', null);
  }

  let section: Section = 'pre';
  let sawEnable = false;
  let sawDisable = false;
  const defines = new Map<string, string>();
  const labels = new Set<string>();
  const allocs: Alloc[] = [];
  const aobs: Aob[] = [];
  const registered: Array<{ name: string }> = [];
  const unregistered: string[] = [];
  const nearTokens: string[] = [];
  const enableSegs: Segment[] = [];
  const disableSegs: Segment[] = [];
  let current: Segment | null = null;

  const needIdent = (name: string, line: number, statement: string) => {
    if (!IDENT.test(name)) throw new AaError('aa:name', statement, line);
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = idx + 1;
    if (unterminatedAt !== null && line >= unterminatedAt) {
      throw new AaError('aa:parse', 'unterminated { comment', unterminatedAt);
    }
    let text = lines[idx]!.trim();
    if (text === '') continue;

    // {$…} directives
    if (text.includes('{$')) {
      for (const m of text.matchAll(/\{\$\s*([A-Za-z_]\w*)?[^}]*\}/g)) {
        const code = directiveCode(m[1] ?? '');
        if (code) throw new AaError(code, m[0], line);
      }
      text = text.replace(/\{\$[^}]*\}/g, '').trim();
      if (text === '') continue;
    }

    // [ENABLE] / [DISABLE]
    const sec = text.match(/^\[(enable|disable)\]$/i);
    if (sec) {
      const which = sec[1]!.toLowerCase();
      if (which === 'enable') {
        if (sawEnable || sawDisable) throw new AaError('aa:parse', text, line);
        sawEnable = true;
        section = 'enable';
      } else {
        if (sawDisable || !sawEnable) throw new AaError('aa:parse', text, line);
        sawDisable = true;
        section = 'disable';
      }
      current = null;
      continue;
    }

    // define(name, text): substitution applies to later lines only
    const def = text.match(/^define\s*\((.*)\)$/i);
    if (def) {
      const comma = def[1]!.indexOf(',');
      if (comma < 0) throw new AaError('aa:parse', text, line);
      const name = def[1]!.slice(0, comma).trim();
      needIdent(name, line, text);
      defines.set(name.toLowerCase(), substitute(def[1]!.slice(comma + 1).trim(), defines));
      continue;
    }
    text = substitute(text, defines);

    if (/^(?:struct\s+\S|endstruct\b)/i.test(text)) throw new AaError('aa:struct', text, line);

    // word(…) statements
    const st = text.match(/^([A-Za-z_]\w*)\s*\((.*)\)$/);
    if (st) {
      const cmd = st[1]!.toLowerCase();
      const args = splitArgs(st[2]!);
      const statement = text;
      const unsupported = UNSUPPORTED[cmd];
      if (unsupported) throw new AaError(unsupported, statement, line);
      const enableOnly = () => { if (section === 'disable') throw new AaError('aa:parse', statement, line); };
      switch (cmd) {
        case 'aobscanmodule': {
          enableOnly();
          if (args.length !== 3) throw new AaError('aa:parse', statement, line);
          needIdent(args[0]!, line, statement);
          const pattern = normalizePattern(args[2]!);
          const module = unquote(args[1]!).trim();
          if (!pattern || !module) throw new AaError('aa:parse', statement, line);
          aobs.push({ name: args[0]!, module, pattern });
          break;
        }
        case 'aobscan': {
          enableOnly();
          if (args.length !== 2) throw new AaError('aa:parse', statement, line);
          needIdent(args[0]!, line, statement);
          const pattern = normalizePattern(args[1]!);
          if (!pattern) throw new AaError('aa:parse', statement, line);
          aobs.push({ name: args[0]!, pattern });
          break;
        }
        case 'alloc':
        case 'globalalloc': {
          enableOnly();
          if (args.length < 2 || args.length > 3) throw new AaError('aa:parse', statement, line);
          needIdent(args[0]!, line, statement);
          const size = parseSize(args[1]!);
          if (size === null || size < 1 || size > MAX_ALLOC) throw new AaError('aa:alloc-size', statement, line);
          const near = args[2] ? args[2] : null;
          if (near) nearTokens.push(...symbolTokens(near));
          allocs.push({ name: args[0]!, size, near, line });
          if (cmd === 'globalalloc') registered.push({ name: args[0]! });
          break;
        }
        case 'label':
          for (const a of args) { needIdent(a, line, statement); labels.add(a.toLowerCase()); }
          break;
        case 'registersymbol':
          enableOnly();
          for (const a of args) { needIdent(a, line, statement); registered.push({ name: a }); }
          break;
        case 'unregistersymbol':
          if (section === 'disable') {
            for (const a of args) { needIdent(a, line, statement); unregistered.push(a); }
          }
          break;
        case 'dealloc':
          break;
        default:
          throw new AaError('aa:unknown-command', statement, line);
      }
      continue;
    }

    // origin:  (a declared label stays in the source)
    if (text.endsWith(':')) {
      const body = text.slice(0, -1).trim();
      if (!labels.has(body.toLowerCase())) {
        const origin = parseOrigin(body, line, text);
        if (section === 'pre') throw new AaError('aa:parse', text, line);
        current = { origin, line, text, lines: [], lineNos: [] };
        (section === 'enable' ? enableSegs : disableSegs).push(current);
        continue;
      }
    } else {
      // `origin: code` on one line isn't supported
      const inline = text.match(/^([A-Za-z_][\w.]*(?:[+-][0-9a-f]+)?|"[^"]+"[+-][0-9a-f]+):\s*\S/i);
      if (inline && !labels.has(inline[1]!.toLowerCase())) throw new AaError('aa:parse', text, line);
    }

    // instruction / data line
    if (!current) throw new AaError('aa:parse', text, line);
    current.lines.push(text);
    current.lineNos.push(line);
  }

  // ---- assemble the cheat ----
  const lc = (s: string) => s.toLowerCase();
  const allocNames = new Set(allocs.map((a) => lc(a.name)));
  const norm = (at: string) => lc(at).replace(/\s+/g, '');
  const enableOrigins = new Set(enableSegs.map((s) => norm(s.origin.at)));

  const firstAob = aobs[0]?.name;
  const firstModuleOrigin = enableSegs.find((s) => s.origin.kind === 'module')?.origin.at;
  const defaultNear = firstAob ?? firstModuleOrigin;

  const enable: StarlightPatchStep[] = [];
  for (const a of aobs) {
    enable.push(a.module !== undefined
      ? { op: 'aobScan', name: a.name, module: a.module, pattern: a.pattern }
      : { op: 'aobScan', name: a.name, pattern: a.pattern });
  }
  for (const a of allocs) {
    const near = a.near ?? defaultNear;
    enable.push(near !== undefined
      ? { op: 'alloc', name: a.name, size: a.size, near }
      : { op: 'alloc', name: a.name, size: a.size });
  }
  const segSource = (s: Segment) => {
    const source = s.lines.join('\n');
    if (source.length > MAX_SOURCE) throw new AaError('aa:parse', s.text, s.line);
    return source;
  };
  const isAllocSeg = (s: Segment) => s.origin.kind === 'name' && s.origin.base !== null && allocNames.has(lc(s.origin.base));
  for (const s of enableSegs.filter((x) => x.lines.length && isAllocSeg(x))) {
    enable.push({ op: 'assemble', at: s.origin.at, source: segSource(s) });
  }
  for (const s of enableSegs.filter((x) => x.lines.length && !isAllocSeg(x))) {
    enable.push({ op: 'assemble', at: s.origin.at, source: segSource(s) });
  }
  const seenReg = new Set<string>();
  const registers: string[] = [];
  for (const r of registered) {
    if (seenReg.has(lc(r.name))) continue;
    seenReg.add(lc(r.name));
    registers.push(lc(r.name));
    enable.push({ op: 'registerSymbol', name: r.name, at: r.name });
  }

  const disable: StarlightPatchStep[] = [];
  for (const s of disableSegs) {
    if (!s.lines.length) continue;
    if (!enableOrigins.has(norm(s.origin.at))) throw new AaError('aa:disable-write', s.text, s.line);
    const bytes = dbBytes(s);
    disable.push(bytes !== null
      ? { op: 'writeBytes', at: s.origin.at, bytes }
      : { op: 'assemble', at: s.origin.at, source: segSource(s) });
  }
  const seenUnreg = new Set<string>();
  for (const n of unregistered) {
    if (seenUnreg.has(lc(n))) continue;
    seenUnreg.add(lc(n));
    disable.push({ op: 'unregisterSymbol', name: n });
  }

  // ---- uses ----
  const defined = new Set<string>([...allocNames, ...labels, ...aobs.map((a) => lc(a.name)), ...defines.keys()]);
  const uses: string[] = [];
  const use = (tok: string) => {
    const t = lc(tok);
    if (defined.has(t) || KEYWORDS.has(t) || REGISTER.test(t) || isModuleName(t) || /^[0-9a-f]+$/.test(t)) return;
    if (!uses.includes(t)) uses.push(t);
  };
  const allSegs = [...enableSegs, ...disableSegs].sort((a, b) => a.line - b.line);
  for (const s of allSegs) {
    if (s.origin.kind === 'name' && s.origin.base) use(s.origin.base);
    for (const l of s.lines) for (const t of symbolTokens(operandsOf(l, labels))) use(t);
  }
  for (const t of nearTokens) use(t);
  for (const r of registered) use(r.name);

  if (enable.length === 0) return { ok: true, cheat: null, registers, uses };

  const site = aobs.find((a) => a.module !== undefined);
  const cheat: StarlightPatchCheat = {
    id: o.id,
    name: o.name,
    type: 'patch',
    ...(site ? { site: { kind: 'aob' as const, module: site.module!, pattern: site.pattern } } : {}),
    enable,
    ...(disable.length ? { disable } : {}),
  };
  return { ok: true, cheat, registers, uses };
}

/** Hex bytes when every line of the segment is a plain `db` of bytes; null when it must be assembled. */
function dbBytes(s: Segment): string | null {
  let out = '';
  for (const [k, l] of s.lines.entries()) {
    const m = l.match(/^db\s+(.*)$/i);
    if (!m) return null;
    const toks = m[1]!.trim().split(/[\s,]+/).filter(Boolean);
    if (toks.some((t) => /^[?*]+$|\?/.test(t))) throw new AaError('aa:parse', l, s.lineNos[k]!);
    if (!toks.every((t) => /^[0-9a-f]{1,2}$/i.test(t))) return null;
    out += toks.map((t) => t.padStart(2, '0').toLowerCase()).join('');
  }
  return out || null;
}

export function compileAaScript(script: string, o: { id: string; name: string }): AaResult {
  try {
    return compile(script, o);
  } catch (e) {
    if (e instanceof AaError) return { ok: false, code: e.code, detail: e.detail, line: e.line };
    throw e;
  }
}
