import type { CtEntry, CtHotkey } from './xml-parser.js';
import { mapCtType } from './type-mapper.js';
import { parseAddress } from './address-parser.js';
import { parseHotkeys } from './hotkey-parser.js';
import { classifyScript } from './script-classifier.js';
import type { StarlightSupportedCheat, StarlightUnsupportedCheat } from './starlight-format.js';

export type ConvertedEntry =
  | { kind: 'cheat'; cheat: StarlightSupportedCheat | StarlightUnsupportedCheat }
  | { kind: 'category'; name: string; children: CtEntry[] };

function stripQuotes(s: string): string {
  return s.replace(/^"+|"+$/g, '');
}

function entryId(entry: CtEntry): string {
  return `cheat-${entry.ID ?? 'anon'}`;
}

function entryName(entry: CtEntry): string {
  return stripQuotes(entry.Description ?? 'Unnamed');
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function convertEntry(entry: CtEntry): ConvertedEntry {
  if (entry.GroupHeader === 1) {
    const children = asArray(entry.CheatEntries?.CheatEntry);
    return { kind: 'category', name: entryName(entry), children };
  }

  const script = classifyScript({
    ...(entry.LuaScript !== undefined ? { luaScript: entry.LuaScript } : {}),
    ...(entry.AssemblerScript !== undefined ? { assemblerScript: entry.AssemblerScript } : {}),
  });
  if (!script.supported) {
    return {
      kind: 'cheat',
      cheat: {
        id: entryId(entry),
        name: entryName(entry),
        unsupported: true,
        unsupportedReason: script.reason,
        ...(entry.LuaScript || entry.AssemblerScript
          ? { originalSource: (entry.LuaScript ?? entry.AssemblerScript)! }
          : {}),
      },
    };
  }

  const valueType = entry.VariableType ? mapCtType(entry.VariableType) : undefined;
  if (!valueType || !entry.Address) {
    return {
      kind: 'cheat',
      cheat: {
        id: entryId(entry),
        name: entryName(entry),
        unsupported: true,
        unsupportedReason: 'Entry is missing a usable VariableType or Address.',
      },
    };
  }

  const offsets = asArray(entry.Offsets?.Offset).map((n) =>
    typeof n === 'number' ? n : parseInt(String(n), 16),
  );
  const address = parseAddress(entry.Address, offsets.length > 0 ? offsets : undefined);

  if (!address) {
    return {
      kind: 'cheat',
      cheat: {
        id: entryId(entry),
        name: entryName(entry),
        unsupported: true,
        unsupportedReason: 'Address expression is not a literal Cheat Engine produces (possibly Lua-evaluated).',
        originalSource: entry.Address,
      },
    };
  }

  const hotkeyArr = asArray(entry.Hotkeys?.Hotkey) as CtHotkey[];
  const hotkeys = parseHotkeys(hotkeyArr);

  const cheat: StarlightSupportedCheat = {
    id: entryId(entry),
    name: entryName(entry),
    type: 'freeze',
    valueType,
    address,
    ...(hotkeys ? { hotkeys } : {}),
  };
  return { kind: 'cheat', cheat };
}
