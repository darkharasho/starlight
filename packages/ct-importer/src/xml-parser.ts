import { XMLParser } from 'fast-xml-parser';

/* Shape of a parsed .CT root. We type only the fields the importer reads;
 * everything else is allowed via index signatures. */
export interface CtRoot {
  CheatTable: {
    CheatEntries: { CheatEntry: CtEntry | CtEntry[] };
    [k: string]: unknown;
  };
}

export interface CtEntry {
  ID?: number;
  Description?: string;
  VariableType?: string;
  Address?: string;
  Offsets?: { Offset: number | number[] };
  Hotkeys?: { Hotkey: CtHotkey | CtHotkey[] };
  GroupHeader?: number;
  CheatEntries?: { CheatEntry: CtEntry | CtEntry[] };
  AssemblerScript?: string;
  LuaScript?: string;
  [k: string]: unknown;
}

export interface CtHotkey {
  Action?: string;
  Keys?: { Key: number | number[] };
  Value?: string | number;
  ID?: number;
}

const ALWAYS_ARRAY = new Set([
  'CheatTable.CheatEntries.CheatEntry',
  'CheatTable.CheatEntries.CheatEntry.CheatEntries.CheatEntry',
  'CheatTable.CheatEntries.CheatEntry.Hotkeys.Hotkey',
  'CheatTable.CheatEntries.CheatEntry.Offsets.Offset',
  'CheatTable.CheatEntries.CheatEntry.Hotkeys.Hotkey.Keys.Key',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
  isArray: (_name, jpath) => ALWAYS_ARRAY.has(jpath) || jpath.endsWith('.CheatEntry'),
});

export function parseCt(xml: string): CtRoot {
  const parsed = parser.parse(xml);
  if (!parsed || typeof parsed !== 'object' || !('CheatTable' in parsed)) {
    throw new Error('parseCt: input does not look like a Cheat Engine table (no <CheatTable> root)');
  }
  return parsed as CtRoot;
}

/** A flattened cheat-table record, mirroring Cheat Engine's own record list. */
export interface CtRecord {
  /** The table's numeric `<ID>` (falls back to flat position, matching CE's `r.ID or idx`). */
  id: number;
  name: string;
  isGroupHeader: boolean;
  /** `script` = Auto Assembler/Lua toggle, `value` = an editable address, `header` = a section. */
  kind: 'script' | 'value' | 'header';
  /** Nesting level (0 = top of the table). */
  depth: number;
  /** The record's CE option flags, e.g. "moHideChildren,moActivateChildrenAsWell". */
  opts?: string;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * Flattens a parsed .CT into the same depth-first (parent-then-children) order
 * Cheat Engine's `getAddressList()` produces, so records can be listed for the
 * UI without launching CE — and the `id`s still line up with CE's `set_active`.
 */
export function listCtRecords(xml: string): CtRecord[] {
  const root = parseCt(xml);
  const out: CtRecord[] = [];
  const walk = (entries: CtEntry[], depth: number): void => {
    for (const e of entries) {
      const isGroupHeader = e.GroupHeader === 1;
      const isScript = e.AssemblerScript !== undefined || /auto assembler/i.test(String(e.VariableType ?? ''));
      const rec: CtRecord = {
        id: e.ID ?? out.length,                                 // CE uses `r.ID or idx`
        name: String(e.Description ?? 'Unnamed').replace(/^"+|"+$/g, ''),
        isGroupHeader,
        kind: isGroupHeader ? 'header' : isScript ? 'script' : 'value',
        depth,
      };
      // <Options moHideChildren="1" …/> — the flags are attribute names.
      const options = e['Options'];
      if (options && typeof options === 'object') {
        const flags = Object.keys(options).filter((k) => k.startsWith('@_mo')).map((k) => k.slice(2));
        if (flags.length > 0) rec.opts = flags.join(',');
      }
      out.push(rec);
      walk(asArray(e.CheatEntries?.CheatEntry), depth + 1);
    }
  };
  walk(asArray(root.CheatTable.CheatEntries?.CheatEntry), 0);
  return out;
}
