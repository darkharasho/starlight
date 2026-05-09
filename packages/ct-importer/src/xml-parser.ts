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
