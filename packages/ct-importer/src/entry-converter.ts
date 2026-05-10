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
  const children = asArray(entry.CheatEntries?.CheatEntry);

  if (entry.GroupHeader === 1) {
    return { kind: 'category', name: entryName(entry), children };
  }

  const script = classifyScript({
    ...(entry.LuaScript !== undefined ? { luaScript: entry.LuaScript } : {}),
    ...(entry.AssemblerScript !== undefined ? { assemblerScript: entry.AssemblerScript } : {}),
  });
  // A script-bearing parent with nested children is acting as a section header
  // (Cheat Engine's pattern: the script registers symbols / patches code, the
  // children expose the resulting addresses). The script body itself is CE
  // machinery and not directly playable; we drop it but recurse into the kids
  // so leaf entries with literal addresses remain reachable.
  if (!script.supported && children.length > 0) {
    return { kind: 'category', name: entryName(entry), children };
  }
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
    // Pointer-base entries often look like this: an address (e.g. `pSelectedCharacter`)
    // but no VariableType because they're meant to be the parent of nested
    // offset-relative children. Surface as a section so children remain reachable.
    if (children.length > 0) {
      return { kind: 'category', name: entryName(entry), children };
    }
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
    if (children.length > 0) {
      return { kind: 'category', name: entryName(entry), children };
    }
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
