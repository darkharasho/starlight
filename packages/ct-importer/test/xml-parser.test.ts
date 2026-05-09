import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCt, type CtRoot } from '../src/xml-parser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(HERE, 'fixtures/synthetic', name), 'utf8');

describe('parseCt', () => {
  it('parses basic-static.ct into nested entries', () => {
    const root: CtRoot = parseCt(fixture('basic-static.ct'));
    expect(root.CheatTable).toBeDefined();
    const entries = root.CheatTable.CheatEntries.CheatEntry;
    const list = Array.isArray(entries) ? entries : [entries];
    expect(list).toHaveLength(2);
    expect(list[0]!.Description).toBe('"Health"');
    expect(list[0]!.VariableType).toBe('4 Bytes');
    expect(list[0]!.Address).toBe('"target"+0040303C');
  });

  it('parses grouped.ct preserving nested CheatEntries', () => {
    const root = parseCt(fixture('grouped.ct'));
    const entries = root.CheatTable.CheatEntries.CheatEntry;
    const list = Array.isArray(entries) ? entries : [entries];
    expect(list).toHaveLength(2);
    expect(list[0]!.GroupHeader).toBe(1);
    expect(list[0]!.CheatEntries).toBeDefined();
  });

  it('parses hotkeys.ct preserving array semantics for multiple hotkeys', () => {
    const root = parseCt(fixture('hotkeys.ct'));
    const entries = root.CheatTable.CheatEntries.CheatEntry as any[];
    const speed = entries[1];
    const hks = speed.Hotkeys.Hotkey;
    expect(Array.isArray(hks)).toBe(true);
    expect(hks).toHaveLength(3);
  });

  it('returns a single Hotkey as an array (forced)', () => {
    const root = parseCt(fixture('hotkeys.ct'));
    const entries = root.CheatTable.CheatEntries.CheatEntry as any[];
    const hp = entries[0];
    const hks = hp.Hotkeys.Hotkey;
    expect(Array.isArray(hks)).toBe(true);
    expect(hks).toHaveLength(1);
  });

  it('throws on malformed XML', () => {
    expect(() => parseCt('<not really xml')).toThrow();
  });
});
