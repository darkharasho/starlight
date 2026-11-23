import { describe, it, expect } from 'vitest';
import { effectiveHotkeys, hotkeyPayload } from '../../src/renderer/lib/hotkeys.js';
import { buildCheatList } from '../../src/shared/cheat-list.js';
import type { CeSessionRecord } from '../../src/shared/ipc.js';

const rec = (id: number, name: string, extra: Partial<CeSessionRecord> = {}): CeSessionRecord =>
  ({ id, name, isActive: false, isGroupHeader: false, kind: 'script', depth: 0, ...extra });
const RECS = [
  rec(1, 'God Mode'),
  rec(2, 'Infinite Ammo', { hotkey: 'F2' }),
  rec(3, 'Damage Multiplier'),
  rec(4, 'Multiplier', { kind: 'value', depth: 1 }),
  rec(5, 'Sub Option', { depth: 1 }),
  rec(6, 'Speed'),
];
const items = buildCheatList(RECS, { revealAll: true }).sections.flatMap((s) => s.items);
const keys = (o: Record<string, string | null>): Record<number, string> =>
  Object.fromEntries([...effectiveHotkeys(items, o)].map(([id, h]) => [id, `${h.source}:${h.accelerator}`]));

describe('effectiveHotkeys', () => {
  it('gives the first cheats numpad keys and keeps the table author\'s own', () => {
    expect(keys({})).toEqual({ 1: 'auto:num1', 2: 'table:F2', 3: 'auto:num2', 6: 'auto:num3' });
  });
  it('lets the user\'s choice win, without handing that key out twice', () => {
    expect(keys({ 'God Mode': 'num2', 'Sub Option': 'Ctrl+F5' })).toEqual({
      1: 'user:num2', 2: 'table:F2', 3: 'auto:num1', 5: 'user:Ctrl+F5', 6: 'auto:num3',
    });
  });
  it('a removed hotkey stays removed; an empty string goes back to the default', () => {
    expect(keys({ 'God Mode': null, 'Infinite Ammo': null })).toEqual({ 3: 'auto:num1', 6: 'auto:num2' });
    expect(keys({ 'God Mode': '' })).toEqual(keys({}));
  });
});

describe('hotkeyPayload', () => {
  it('sends Cheat Engine only the keys it does not already handle', () => {
    expect(hotkeyPayload(items, {})).toEqual({
      bindings: [{ id: 1, keys: [0x61] }, { id: 3, keys: [0x62] }, { id: 6, keys: [0x63] }],
      replace: [],
    });
  });
  it('takes the table\'s hotkey off a record the user rebound or cleared', () => {
    const p = hotkeyPayload(items, { 'Infinite Ammo': 'Ctrl+F9' });
    expect(p.replace).toEqual([2]);
    expect(p.bindings).toContainEqual({ id: 2, keys: [0x11, 0x78] });
    expect(hotkeyPayload(items, { 'Infinite Ammo': null }).replace).toEqual([2]);
  });
});
