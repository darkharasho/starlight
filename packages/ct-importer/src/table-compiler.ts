/**
 * Compiles a whole Cheat Engine table for the native runner: every record
 * (scripts through `compileAaScript`, value records with their addresses,
 * dropdowns and hotkeys), the table-wide symbol registry, and the reason codes
 * for anything that needs Cheat Engine. Table-level rules are plan D13.
 */
import { parseCt, listCtRecords, type CtEntry, type CtHotkey } from './xml-parser.js';
import { compileAaScript } from './aa-compiler.js';
import { isCosmeticLua } from './lua-cosmetic.js';
import { scanLua } from './lua-scan.js';
import { luaBlocks, stripLuaBlocks } from './lua-blocks.js';
import { parseCtAddress } from './ct-address.js';
import { mapCtType } from './type-mapper.js';
import { vkKeysToAccelerator } from './hotkey-parser.js';
import type { ReasonCode } from './reasons.js';
import type { StarlightAddress, StarlightPatchCheat, StarlightValueType } from './starlight-format.js';

export interface CompiledHotkey {
  action: 'toggle' | 'activate' | 'deactivate' | 'set' | 'inc' | 'dec';
  accelerator: string;
  value?: string;
}

export type CompiledScript = {
  /** null = the script compiles to nothing (a no-op toggle), or is deferred. */
  cheat: StarlightPatchCheat | null;
  registers: string[];
  uses: string[];
  /**
   * The full AA source when it has `{$lua}` blocks or `luacall` lines: they run on enable and
   * their returned text is spliced in before compiling (`expandLuaBlocks`). `cheat` is null then.
   */
  deferred?: string;
};

export type CompiledRecord = { id: number; name: string; depth: number; opts?: string; hotkeys: CompiledHotkey[] } & (
  | { kind: 'header'; script: CompiledScript | null }
  | { kind: 'script'; script: CompiledScript }
  | {
      kind: 'value';
      /** `bytes`: Array of byte; `string16`: a UTF-16 (Unicode) string; `binary`: a bit field. */
      valueType: CompiledValueType;
      /** Bytes covered (strings, byte arrays and bit fields). */
      length?: number;
      /** Bit fields: the first bit (0 = lowest bit of the first byte) and how many bits. */
      bitStart?: number;
      bitLength?: number;
      /** CE's built-in "… Big Endian" custom types: the value's bytes are stored most significant first. */
      bigEndian?: boolean;
      address: StarlightAddress;
      showAsHex: boolean;
      showAsSigned: boolean;
      options?: { value: string; label: string }[];
    }
  /** A record whose own LuaScript runs on enable ([ENABLE] part) and disable ([DISABLE] part). */
  | { kind: 'lua'; lua: string }
  | { kind: 'unsupported'; code: ReasonCode; detail: string });

export type CompiledValueType = StarlightValueType | 'bytes' | 'string16' | 'binary';

export interface CompiledTable {
  records: CompiledRecord[];
  /** True when nothing in the table needs Cheat Engine (no reasons). */
  native: boolean;
  reasons: Array<{ recordId: number | null; name: string; code: ReasonCode; detail: string }>;
  /** Lowercased symbol -> id of the first record that registers it (-1: the table script). */
  registeredBy: Record<string, number>;
  /** The table's own Lua script, run once after attaching; null when it has none (or only cosmetic Lua). */
  tableLua: string | null;
}

/** CE's hotkey actions. Its bridge treats `action <= 2` (the first three) as toggles. */
const ACTIONS: Record<string, CompiledHotkey['action']> = {
  'toggle activation': 'toggle',
  'toggle activation allow increase': 'toggle',
  'toggle activation allow decrease': 'toggle',
  'activate': 'activate',
  'deactivate': 'deactivate',
  'set value': 'set',
  'increase value': 'inc',
  'decrease value': 'dec',
};

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Element text, whether or not the element had attributes (`#text`). */
function text(v: unknown): string {
  if (v && typeof v === 'object' && '#text' in v) return text((v as Record<string, unknown>)['#text']);
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

const flag = (v: unknown) => text(v).trim() === '1';

/** True when Lua source does something besides talk to the player (see isCosmeticLua). */
function hasLuaCode(src: string): boolean {
  return !isCosmeticLua(src);
}

function compileHotkeys(e: CtEntry): CompiledHotkey[] {
  const out: CompiledHotkey[] = [];
  for (const hk of asArray(e.Hotkeys?.Hotkey) as CtHotkey[]) {
    const action = ACTIONS[text(hk.Action).trim().toLowerCase()];
    const accelerator = hk.Keys ? vkKeysToAccelerator(asArray(hk.Keys.Key).map(Number)) : undefined;
    if (!action || !accelerator) continue;
    const value = text(hk.Value).trim();
    out.push({ action, accelerator, ...(hk.Value !== undefined && value !== '' ? { value } : {}) });
  }
  return out;
}

/** `value:description` lines of a `<DropDownList>`. */
function parseDropdown(src: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    out.push(i < 0 ? { value: line, label: line } : { value: line.slice(0, i).trim(), label: line.slice(i + 1).trim() });
  }
  return out;
}

type ValueKind =
  | { valueType: CompiledValueType; length?: number; bitStart?: number; bitLength?: number; bigEndian?: boolean }
  | { unsupported: string };

/** CE's built-in custom types (Lua-free); a table's own custom types are code CE runs. */
const BIG_ENDIAN: Record<string, [StarlightValueType, StarlightValueType]> = {
  '2 byte big endian': ['uint16', 'int16'], '4 byte big endian': ['uint32', 'int32'], 'float big endian': ['float', 'float'],
};

/** CE variable type -> value type (R26: 2/4/8-byte types are unsigned unless ShowAsSigned=1). */
function valueKind(e: CtEntry, signed: boolean): ValueKind {
  const vt = text(e.VariableType).trim();
  const lower = vt.toLowerCase();
  const sized: Record<string, [StarlightValueType, StarlightValueType]> = {
    '2 bytes': ['uint16', 'int16'], '4 bytes': ['uint32', 'int32'], '8 bytes': ['uint64', 'int64'],
  };
  const pair = sized[lower];
  if (pair) return { valueType: signed ? pair[1] : pair[0] };
  const len = (v: unknown) => {
    const n = Number(text(v).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  if (lower === 'array of byte') {
    const n = len(e['ByteLength']);
    return n ? { valueType: 'bytes', length: n } : { unsupported: vt };
  }
  if (lower === 'string') {
    const n = len(e['Length']);
    if (!n) return { unsupported: vt };
    // CE's Length counts characters; a Unicode character is two bytes.
    return flag(e['Unicode']) ? { valueType: 'string16', length: n * 2 } : { valueType: 'string', length: n };
  }
  if (lower === 'binary') {
    const start = Number(text(e['BitStart']).trim() || '0');
    const bits = Number(text(e['BitLength']).trim());
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(bits) || bits < 1 || start + bits > 64) return { unsupported: vt };
    return { valueType: 'binary', bitStart: start, bitLength: bits, length: Math.ceil((start + bits) / 8) };
  }
  if (lower === 'custom') {
    const name = text(e['CustomType']).trim();
    const be = BIG_ENDIAN[name.toLowerCase()];
    if (be) return { valueType: signed ? be[1] : be[0], bigEndian: true };
    return { unsupported: name ? `Custom: ${name}` : vt };
  }
  const mapped = mapCtType(vt);
  return mapped ? { valueType: mapped } : { unsupported: vt || '(none)' };
}

export function compileTable(xml: string): CompiledTable {
  const root = parseCt(xml);
  const listed = listCtRecords(xml);
  const records: CompiledRecord[] = [];
  const entries: CtEntry[] = [];
  const dropdownByName = new Map<string, string>();
  /** Literal registerSymbol names in record Lua scripts, by record id. */
  const luaRegisters = new Map<number, string[]>();

  // Pass 1: records in listCtRecords order, addresses folded into ancestors.
  let i = 0;
  const walk = (list: CtEntry[], parent: StarlightAddress | null): void => {
    for (const e of list) {
      const rec = listed[i++]!;
      entries.push(e);
      const base = {
        id: rec.id, name: rec.name, depth: rec.depth,
        ...(rec.opts ? { opts: rec.opts } : {}),
        hotkeys: compileHotkeys(e),
      };
      const unsupported = (code: ReasonCode, detail: string): CompiledRecord => ({ ...base, kind: 'unsupported', code, detail });
      const dropdown = text(e['DropDownList']);
      if (dropdown.trim() && !dropdownByName.has(rec.name)) dropdownByName.set(rec.name, dropdown);

      // Children's +hex/-hex is relative to the nearest ancestor with an address.
      const hasAddress = e.Address !== undefined && text(e.Address).trim() !== '';
      const offsets = asArray<string | number>(e.Offsets?.Offset).map(text);
      const own = hasAddress ? parseCtAddress(text(e.Address), offsets, parent) : null;
      const childParent = hasAddress ? own : parent;

      const lua = text(e.LuaScript);
      const aa = e.AssemblerScript !== undefined ? text(e.AssemblerScript) : null;
      let compiled: CompiledRecord;
      if (hasLuaCode(lua)) {
        const scan = scanLua(lua);
        compiled = scan.unsupported.length ? unsupported('lua:unsupported', scan.unsupported[0]!) : { ...base, kind: 'lua', lua };
        if (scan.registers.length) luaRegisters.set(rec.id, scan.registers);
      } else if (rec.kind === 'header' || rec.kind === 'script') {
        if (aa === null || (rec.kind === 'header' && !aa.trim())) {
          compiled = rec.kind === 'header' ? { ...base, kind: 'header', script: null } : unsupported('aa:no-enable', 'no script');
        } else {
          // {$lua} blocks and luacall lines run on enable: check them, compile the AA around them.
          const blocks = luaBlocks(aa);
          const bad = blocks.flatMap((b) => scanLua(b.code).unsupported)[0];
          // Strip every Lua region (also ones with nothing to run), so the AA compiler never sees {$lua}.
          const r = compileAaScript(stripLuaBlocks(aa), { id: `cheat-${rec.id}`, name: rec.name });
          if (bad !== undefined) {
            compiled = unsupported('lua:unsupported', bad);
          } else if (!r.ok) {
            compiled = unsupported(r.code, r.line !== null ? `line ${r.line}: ${r.detail}` : r.detail);
          } else {
            const luaRegs = blocks.flatMap((b) => scanLua(b.code).registers);
            const script: CompiledScript = blocks.length
              ? { cheat: null, registers: [...new Set([...r.registers, ...luaRegs])], uses: r.uses, deferred: aa }
              : { cheat: r.cheat, registers: r.registers, uses: r.uses };
            compiled = rec.kind === 'header' ? { ...base, kind: 'header', script } : { ...base, kind: 'script', script };
          }
        }
      } else {
        const showAsSigned = flag(e['ShowAsSigned']);
        const showAsHex = flag(e['ShowAsHex']);
        const vk = valueKind(e, showAsSigned);
        if ('unsupported' in vk) compiled = unsupported('value:type', vk.unsupported);
        else if (!own) compiled = unsupported('addr:expression', text(e.Address).trim());
        else {
          compiled = {
            ...base, kind: 'value', valueType: vk.valueType,
            ...(vk.length !== undefined ? { length: vk.length } : {}),
            ...(vk.bitStart !== undefined ? { bitStart: vk.bitStart, bitLength: vk.bitLength! } : {}),
            ...(vk.bigEndian ? { bigEndian: true } : {}),
            address: own, showAsHex, showAsSigned,
          };
        }
      }
      records.push(compiled);
      walk(asArray(e.CheatEntries?.CheatEntry), childParent);
    }
  };
  walk(asArray(root.CheatTable.CheatEntries?.CheatEntry), null);

  // Pass 2: dropdown lists and links.
  records.forEach((r, k) => {
    if (r.kind !== 'value') return;
    const e = entries[k]!;
    const own = text(e['DropDownList']);
    const link = text(e['DropDownListLink']).trim();
    const src = own.trim() ? own : link ? dropdownByName.get(link) ?? '' : '';
    const options = parseDropdown(src);
    if (options.length > 0) r.options = options;
  });

  // The table script: run once after attaching when the runtime supports all of it.
  const tableLuaSrc = text((root.CheatTable as { LuaScript?: unknown }).LuaScript);
  const tableScan = hasLuaCode(tableLuaSrc) ? scanLua(tableLuaSrc) : null;

  // Pass 3: the table-wide symbol registry, then every record's needed names against it (R16: lowercased).
  const registeredBy: Record<string, number> = {};
  for (const name of tableScan?.registers ?? []) registeredBy[name] ??= -1;
  for (const [id, names] of luaRegisters) for (const name of names) registeredBy[name] ??= id;
  for (const r of records) {
    const script = r.kind === 'script' || r.kind === 'header' ? r.script : null;
    for (const name of script?.registers ?? []) {
      const key = name.toLowerCase();
      if (!(key in registeredBy)) registeredBy[key] = r.id;
    }
  }
  // Names a record needs from the registry: a script's uses, or a value address's symbol base
  // (the name before any +/-hex, also inside brackets, which parseCtAddress has already unwrapped).
  const needed = (r: CompiledRecord): string[] => {
    if (r.kind === 'script' || r.kind === 'header') return r.script?.uses ?? [];
    if (r.kind === 'value' && r.address.kind === 'symbol') return [r.address.expr.replace(/\s*[+-].*$/, '')];
    return [];
  };
  records.forEach((r, k) => {
    const missing = needed(r).map((u) => u.toLowerCase()).filter((u) => !(u in registeredBy));
    if (missing.length === 0) return;
    const { id, name, depth, opts, hotkeys } = r;
    records[k] = {
      id, name, depth, ...(opts ? { opts } : {}), hotkeys,
      kind: 'unsupported',
      code: missing.some((u) => u.includes(':')) ? 'sym:mono' : 'sym:unresolved',
      detail: missing.join(', '),
    };
  });

  // Reasons: table rules (D13) first, then records.
  const reasons: CompiledTable['reasons'] = [];
  if (tableScan?.unsupported.length) {
    reasons.push({ recordId: null, name: '', code: 'lua:unsupported', detail: tableScan.unsupported[0]! });
  }
  if (!records.some((r) => !(r.kind === 'header' && r.script === null))) {
    reasons.push({ recordId: null, name: '', code: 'table:empty', detail: 'no records besides headers' });
  }
  for (const r of records) {
    if (r.kind === 'unsupported') reasons.push({ recordId: r.id, name: r.name, code: r.code, detail: r.detail });
  }

  const tableLua = tableScan && tableScan.unsupported.length === 0 ? tableLuaSrc : null;
  return { records, native: reasons.length === 0, reasons, registeredBy, tableLua };
}
