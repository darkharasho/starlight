/**
 * Cheat Engine table address strings -> v2 addresses (plan D11).
 *
 *   "m"+hex, m.exe+hex      -> module ($process+hex: the main module)
 *   hex                      -> absolute
 *   name[±hex]               -> symbol { expr }
 *   [expr]±hex (nested)      -> symbol { expr, offsets } (outer brackets last);
 *                               a literal (module/absolute) base inside brackets
 *                               is the existing `pointer` form
 *   +hex / -hex              -> relative to the nearest ancestor with an address,
 *                               folded into that address here
 *
 * CT `<Offsets>` come after the bracket offsets, in the order of
 * `ctOffsetsInApplyOrder`. Every number in a CT address is hex (R5); wherever
 * a ±hex goes, constant arithmetic (`+4*2-9C`, `0x144 * 0 + 0x11c`) is folded.
 */
import type { StarlightAddress } from './starlight-format.js';
import { parseAddress } from './address-parser.js';

const FACTOR = /^(?:0x)?([0-9a-f]+)$/i;
/** The base of an address: a quoted module, `name.exe`/`name.dll`, `$process`, a name or hex digits; the rest is `tail`. */
const HEAD = /^("[^"]+"|[A-Za-z_][\w.]*\.(?:exe|dll)\b|\$process\b|[A-Za-z_]\w*|(?:0x)?[0-9a-f]+)(.*)$/i;

/**
 * Constant hex arithmetic, as CE evaluates it in addresses and offsets: terms joined by `+`/`-`
 * (optionally signed first), each a product (`*`) of hex numbers. Null when it isn't that.
 */
export function constHex(v: string | number): bigint | null {
  const t = String(v).replace(/\s+/g, '');
  if (t === '') return null;
  const re = /([+-]?)([^+-]+)/y;
  let total = 0n;
  for (let pos = 0; pos < t.length;) {
    re.lastIndex = pos;
    const m = re.exec(t);
    if (!m) return null;
    pos = re.lastIndex;
    let product = 1n;
    for (const f of m[2]!.split('*')) {
      const x = FACTOR.exec(f);
      if (!x) return null;
      product *= BigInt('0x' + x[1]!);
    }
    total += m[1] === '-' ? -product : product;
  }
  return total;
}

/** A `±…` constant tail (`+10`, `-9C+4*2`); null when `s` isn't one. */
function signedTail(s: string): bigint | null {
  return /^\s*[+-]/.test(s) ? constHex(s) : null;
}

/** Signed hex literal: `0x10`, `-0x10`. */
function fmt(n: bigint): string {
  return n < 0n ? '-0x' + (-n).toString(16) : '0x' + n.toString(16);
}

/** Parses a literal from `fmt` (or a plain `0x…`). */
function lit(s: string): bigint {
  return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
}

/**
 * The one place that knows CE's `<Offsets>` order (R27): CE stores the
 * last-applied offset first, so the list is reversed to base-first
 * (application) order. Values are hex text. Null when one isn't hex.
 */
export function ctOffsetsInApplyOrder(xmlOffsets: ReadonlyArray<string | number>): string[] | null {
  const out: string[] = [];
  for (const o of xmlOffsets) {
    const n = constHex(o);
    if (n === null) return null;
    out.push(fmt(n));
  }
  return out.reverse();
}

type Base =
  | { kind: 'absolute'; address: bigint }
  | { kind: 'module'; module: string; offset: bigint }
  | { kind: 'symbol'; expr: string };

function parseBase(s: string): Base | null {
  const m = HEAD.exec(s.trim());
  if (!m) return null;
  const head = m[1]!;
  const tail = m[2]!.trim();
  const delta = tail === '' ? 0n : signedTail(tail);
  if (delta === null) return null;
  const quoted = head.startsWith('"');
  if (quoted || /\.(?:exe|dll)$/i.test(head)) {
    const module = quoted ? head.slice(1, -1) : head;
    // CE's THREADSTACKn is a thread's stack, found at run time; not a module.
    if (/^threadstack\d+$/i.test(module) || delta < 0n) return null;
    return { kind: 'module', module, offset: delta };
  }
  if (head.toLowerCase() === '$process') return delta < 0n ? null : { kind: 'module', module: '$process', offset: delta };
  const hex = FACTOR.exec(head);
  if (hex) {
    const address = BigInt('0x' + hex[1]!) + delta;
    return address < 0n ? null : { kind: 'absolute', address };
  }
  if (tail === '' || delta === 0n) return { kind: 'symbol', expr: head };
  return { kind: 'symbol', expr: `${head}${delta < 0n ? '-' : '+'}${(delta < 0n ? -delta : delta).toString(16)}` };
}

/** `[inner]±hex` nesting -> innermost base plus offsets, innermost first. */
function parseNested(s: string): { base: Base; offsets: bigint[] } | null {
  const t = s.trim();
  if (!t.startsWith('[')) {
    const base = parseBase(t);
    return base ? { base, offsets: [] } : null;
  }
  let depth = 0;
  let close = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '[') depth++;
    else if (t[i] === ']' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return null;
  const inner = parseNested(t.slice(1, close));
  if (!inner) return null;
  const rest = t.slice(close + 1).trim();
  let off = 0n;
  if (rest !== '') {
    const d = signedTail(rest);
    if (d === null) return null;
    off = d;
  }
  return { base: inner.base, offsets: [...inner.offsets, off] };
}

/** Adds `delta` to where `parent` points (its last offset when it has any). */
function fold(parent: StarlightAddress, delta: bigint): StarlightAddress | null {
  const bump = (offsets: string[]) => [...offsets.slice(0, -1), fmt(lit(offsets[offsets.length - 1]!) + delta)];
  switch (parent.kind) {
    case 'absolute': {
      const a = lit(parent.address) + delta;
      return a < 0n ? null : { kind: 'absolute', address: fmt(a) };
    }
    case 'module': {
      const o = lit(parent.offset) + delta;
      return o < 0n ? null : { ...parent, offset: fmt(o) };
    }
    case 'pointer':
      return parent.offsets.length > 0
        ? { ...parent, offsets: bump(parent.offsets) }
        : { ...parent, baseOffset: fmt(lit(parent.baseOffset) + delta) };
    case 'symbol':
      if (parent.offsets && parent.offsets.length > 0) return { ...parent, offsets: bump(parent.offsets) };
      return { kind: 'symbol', expr: `${parent.expr}${delta < 0n ? '-' : '+'}${(delta < 0n ? -delta : delta).toString(16)}` };
    case 'aob': {
      const o = (parent.offset ? lit(parent.offset) : 0n) + delta;
      return { ...parent, offset: fmt(o) };
    }
  }
}

/** Appends offsets (application order) to an address; null when the kind can't carry them. */
function withOffsets(a: StarlightAddress, offsets: string[]): StarlightAddress | null {
  if (offsets.length === 0) return a;
  switch (a.kind) {
    case 'absolute': return { kind: 'pointer', baseOffset: a.address, offsets };
    case 'module': return { kind: 'pointer', module: a.module, baseOffset: a.offset, offsets };
    case 'pointer': return { ...a, offsets: [...a.offsets, ...offsets] };
    case 'symbol': return { ...a, offsets: [...(a.offsets ?? []), ...offsets] };
    case 'aob': return null;
  }
}

/**
 * Compiles one CT address (D11). `xmlOffsets` are the record's `<Offsets>` as
 * written in the XML; `parent` is the nearest ancestor's compiled address (for
 * `+hex`/`-hex` children). Null when the address can't be compiled.
 */
export function parseCtAddress(
  addr: string | number,
  xmlOffsets: ReadonlyArray<string | number> | undefined,
  parent: StarlightAddress | null,
): StarlightAddress | null {
  const s = String(addr).trim();
  if (s === '') return null;
  const ctOffsets = ctOffsetsInApplyOrder(xmlOffsets ?? []);
  if (!ctOffsets) return null;

  const rel = signedTail(s);
  if (rel !== null) {
    if (!parent) return null;
    const folded = fold(parent, rel);
    return folded && withOffsets(folded, ctOffsets);
  }

  const nested = parseNested(s);
  if (!nested) {
    // aobscanmodule(...) addresses keep the importer's existing `aob` form.
    if (/^aobscanmodule\s*\(/i.test(s) && ctOffsets.length === 0) return parseAddress(s);
    return null;
  }
  const { base } = nested;
  const offsets = [...nested.offsets.map(fmt), ...ctOffsets];
  if (base.kind === 'symbol') return offsets.length ? { kind: 'symbol', expr: base.expr, offsets } : { kind: 'symbol', expr: base.expr };
  const literal: StarlightAddress = base.kind === 'module'
    ? { kind: 'module', module: base.module, offset: fmt(base.offset) }
    : { kind: 'absolute', address: fmt(base.address) };
  return withOffsets(literal, offsets);
}
