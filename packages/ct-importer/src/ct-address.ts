/**
 * Cheat Engine table address strings -> v2 addresses (plan D11).
 *
 *   "m"+hex, m.exe+hex      -> module
 *   hex                      -> absolute
 *   name[±hex]               -> symbol { expr }
 *   [expr]±hex (nested)      -> symbol { expr, offsets } (outer brackets last);
 *                               a literal (module/absolute) base inside brackets
 *                               is the existing `pointer` form
 *   +hex / -hex              -> relative to the nearest ancestor with an address,
 *                               folded into that address here
 *
 * CT `<Offsets>` come after the bracket offsets, in the order of
 * `ctOffsetsInApplyOrder`. Every number in a CT address is hex (R5).
 */
import type { StarlightAddress } from './starlight-format.js';
import { parseAddress } from './address-parser.js';

const HEX = /^(?:0x)?([0-9a-f]+)$/i;
const QUOTED_MODULE = /^"([^"]+)"(?:\s*\+\s*(?:0x)?([0-9a-f]+))?$/i;
const MODULE = /^([A-Za-z_][\w.]*\.(?:exe|dll))(?:\s*\+\s*(?:0x)?([0-9a-f]+))?$/i;
const SYMBOL = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*([+-])\s*(?:0x)?([0-9a-f]+))?$/i;
const RELATIVE = /^([+-])\s*(?:0x)?([0-9a-f]+)$/i;

/** A CT number (hex digits, possibly coerced to a JS number by the XML parser) as a BigInt. */
function hexValue(v: string | number): bigint | null {
  const m = HEX.exec(String(v).trim());
  return m ? BigInt('0x' + m[1]!) : null;
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
    const n = hexValue(o);
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
  let m: RegExpExecArray | null;
  if ((m = QUOTED_MODULE.exec(s))) return { kind: 'module', module: m[1]!, offset: m[2] ? BigInt('0x' + m[2]) : 0n };
  if ((m = MODULE.exec(s))) return { kind: 'module', module: m[1]!, offset: m[2] ? BigInt('0x' + m[2]) : 0n };
  const hex = hexValue(s);
  if (hex !== null) return { kind: 'absolute', address: hex };
  if ((m = SYMBOL.exec(s))) {
    return { kind: 'symbol', expr: m[2] ? `${m[1]}${m[2]}${m[3]!.toLowerCase().replace(/^0+(?=.)/, '')}` : m[1]! };
  }
  return null;
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
    const m = RELATIVE.exec(rest);
    if (!m) return null;
    off = BigInt('0x' + m[2]!) * (m[1] === '-' ? -1n : 1n);
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

  const rel = RELATIVE.exec(s);
  if (rel) {
    if (!parent) return null;
    const folded = fold(parent, BigInt('0x' + rel[2]!) * (rel[1] === '-' ? -1n : 1n));
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
