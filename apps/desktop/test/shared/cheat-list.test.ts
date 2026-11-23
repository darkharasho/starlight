import { describe, it, expect } from 'vitest';
import { buildCheatList, findPrerequisites, tidyName, isSeparator, isJunk, type ListRecord } from '../../src/shared/cheat-list.js';

let nextId = 1;
type Spec = [depth: number, kind: 'S' | 'V' | 'H', name: string, opts?: string];
/** Compact table builder: [depth, Script|Value|Header, name, options]. Ids count from 1. */
function table(...rows: Spec[]): ListRecord[] {
  nextId = 1;
  return rows.map(([depth, k, name, opts]) => ({
    id: nextId++, name, depth, isActive: false, isGroupHeader: k === 'H',
    kind: k === 'H' ? 'header' as const : k === 'S' ? 'script' as const : 'value' as const,
    ...(opts ? { opts } : {}),
  }));
}
const names = (recs: ListRecord[], ids: number[]): string[] => ids.map((id) => recs.find((r) => r.id === id)!.name);
const prereqNames = (recs: ListRecord[]): string[] => names(recs, findPrerequisites(recs).map((p) => p.id));

describe('tidyName', () => {
  it('strips the decoration authors wrap names in', () => {
    expect(tidyName('→ Enable (Auto-Attach Game Process)')).toBe('Enable (Auto-Attach Game Process)');
    expect(tidyName('Invulnerable ()->')).toBe('Invulnerable');
    expect(tidyName('[— Scripts : Character —] ()->')).toBe('Scripts : Character');
    expect(tidyName('== 9 Kings v0.9.1: Minimum Money 999 ==')).toBe('9 Kings v0.9.1: Minimum Money 999');
    expect(tidyName('* Press [ESC] to populate values. *')).toBe('Press [ESC] to populate values.');
    expect(tidyName('💥 Author:  Send')).toBe('Author: Send');
    expect(tidyName('[F1] teleport to marker')).toBe('Teleport to marker');
  });
  it('turns programmer identifiers into words', () => {
    expect(tidyName('<MerchantRerollTimes>k__BackingField')).toBe('Merchant Reroll Times');
    expect(tidyName('FREE_PERSISTENT_REROLLS')).toBe('Free Persistent Rerolls');
    expect(tidyName('currHP')).toBe('Curr HP');
  });
  it('leaves ordinary names alone and never returns nothing', () => {
    expect(tidyName('Infinite Health')).toBe('Infinite Health');
    expect(tidyName('God Mode (no damage)')).toBe('God Mode (no damage)');
    expect(tidyName('-----')).toBe('-----');
  });
  it('recognises separators and adverts', () => {
    expect(isSeparator('--------------------------------')).toBe(true);
    expect(isSeparator('Player')).toBe(false);
    expect(isJunk('⚡ Discord')).toBe(true);
    expect(isJunk('Handler : Support Me On Patreon ()->')).toBe(true);
    expect(isJunk('[ F2]  CompactMode  /  Full view mode')).toBe(true);
    expect(isJunk('Infinite Stamina')).toBe(false);
  });
});

describe('findPrerequisites', () => {
  it('finds a chain of activation scripts and nothing under them', () => {
    const t = table(
      [0, 'S', '→ Enable (Auto-Attach Game Process)', '[moHideChildren]'],
      [1, 'S', '→ Initialize Mono', '[moHideChildren]'],
      [2, 'S', 'Disable Player Damage'],
      [2, 'S', 'Grab Player Data', '[moHideChildren]'],
      [3, 'V', 'Set Gold'],
      [3, 'V', 'Set Wood'],
      [0, 'H', '--------------------------------'],
      [0, 'S', '⚡ Discord'],
    );
    expect(prereqNames(t)).toEqual(['→ Enable (Auto-Attach Game Process)', '→ Initialize Mono']);
    expect(findPrerequisites(t)[1]).toEqual({ id: 2, parentId: 1 });
  });

  it('treats a hidden-children script holding most of the table as the gate', () => {
    const t = table(
      [0, 'V', 'Money1'],
      [0, 'S', 'AOB_scan', '[moHideChildren]'],
      [1, 'V', 'Money'], [1, 'V', 'Battery'], [1, 'V', 'Health'],
    );
    expect(prereqNames(t)).toEqual(['AOB_scan']);
  });

  it('picks up a flat table\'s activation script by its name', () => {
    const t = table(
      [0, 'S', 'GAME (Wait up to 30s)'],
      [0, 'S', 'God Mode'],
      [0, 'S', 'Infinite Ammo'],
    );
    expect(prereqNames(t)).toEqual(['GAME (Wait up to 30s)']);
  });

  it('looks through section headers to a container of cheats', () => {
    const t = table(
      [0, 'S', 'Table Activation ()->', '[moHideChildren,moDeactivateChildrenAsWell]'],
      [1, 'H', '[— Scripts : Character —] ()->', '[moHideChildren]'],
      [2, 'S', 'Invisible ()->'],
      [2, 'S', 'Invulnerable ()->'],
    );
    expect(prereqNames(t)).toEqual(['Table Activation ()->']);
  });

  it('never switches on something that is a cheat in its own right', () => {
    // A cheat with options, a cheat with a sub-cheat, and plainly named cheats.
    expect(prereqNames(table([0, 'S', '[F1] teleport to marker'], [1, 'V', '[jump]'], [0, 'S', 'immortal player']))).toEqual([]);
    expect(prereqNames(table(
      [0, 'S', 'Enable'], [1, 'S', 'Free Building'],
      [1, 'S', 'Last Dragged Item Modifier', '[moHideChildren]'], [2, 'S', 'Fill Item Stack'], [2, 'V', 'Weight'], [2, 'V', 'Quantity'],
    ))).toEqual(['Enable']);
    expect(prereqNames(table([0, 'S', 'Enable God Mode'], [0, 'S', 'Activate Min Money 999'], [0, 'S', 'One Hit Kill']))).toEqual([]);
    expect(prereqNames(table([0, 'S', 'Experience Multiplier', '[moHideChildren]'], [1, 'V', 'Multiplier'], [0, 'S', 'A'], [0, 'S', 'B'], [0, 'S', 'C']))).toEqual([]);
  });

  it('leaves alone a script that would switch all its children on with it', () => {
    const t = table([0, 'S', 'Enable', '[moHideChildren,moActivateChildrenAsWell]'], [1, 'S', 'God Mode'], [1, 'S', 'One Hit Kill']);
    expect(prereqNames(t)).toEqual([]);
  });
});

describe('buildCheatList', () => {
  const t = table(
    [0, 'S', '→ Enable', '[moHideChildren]'],                       // 1
    [1, 'H', '[— Scripts : Character —] ()->'],                    // 2
    [2, 'S', 'Invulnerable ()->'],                                 // 3
    [2, 'S', 'Experience Multiplier ()->', '[moHideChildren]'],    // 4
    [3, 'V', '[#] Multiplier'],                                    // 5
    [3, 'H', '* Press [ESC] to populate values. *'],               // 6
    [1, 'H', '[— Scripts : Miscellaneous —] ()->'],                // 7 (empty)
    [0, 'H', '--------------------------------'],                  // 8
    [0, 'H', '💥 Author:  Send'],                                  // 9
    [0, 'S', '⚡ Discord'],                                         // 10
    [0, 'S', '[ F2]  CompactMode  /  Full view mode', '[moAlwaysHideChildren]'],   // 11
    [1, 'S', 'Something internal'],                                // 12
  );

  it('hides the prerequisite, promotes what was under it and drops the noise', () => {
    const list = buildCheatList(t, { transparentIds: new Set([1]) });
    expect(list.sections.map((s) => s.title)).toEqual(['Character']);
    expect(list.sections[0]!.items.map((i) => [i.label, i.indent, i.hiddenChildren])).toEqual([
      ['Invulnerable', 0, 0],
      ['Experience Multiplier', 0, 1],
    ]);
    expect(list.total).toBe(2);
    expect(list.notes).toEqual(['Author: Send']);
  });

  it('shows a cheat\'s options once it is on, with the author\'s guidance', () => {
    const on = t.map((r) => (r.id === 4 ? { ...r, isActive: true } : r));
    const items = buildCheatList(on, { transparentIds: new Set([1]) }).sections[0]!.items;
    expect(items.map((i) => [i.label, i.indent, i.note])).toEqual([
      ['Invulnerable', 0, false],
      ['Experience Multiplier', 0, false],
      ['Multiplier', 1, false],
      ['Press [ESC] to populate values.', 1, true],
    ]);
  });

  it('shows everything in a preview, where nothing can be switched on', () => {
    const list = buildCheatList(t, { transparentIds: new Set([1]), revealAll: true });
    expect(list.sections[0]!.items.map((i) => i.label)).toContain('Multiplier');
  });

  it('keeps a prerequisite that failed visible, with what it gates counted', () => {
    const list = buildCheatList(t);     // nothing transparent: Enable never came on
    expect(list.sections[0]!.title).toBeNull();
    expect(list.sections[0]!.items.map((i) => [i.label, i.hiddenChildren])).toEqual([['Enable', 3]]);
  });

  it('nests section titles two deep and skips empty or generic headings', () => {
    const nested = table(
      [0, 'H', 'Player'], [1, 'H', 'Stats'], [2, 'H', 'Primary'], [3, 'V', 'Strength'],
      [0, 'H', 'Cheats'], [1, 'S', 'God Mode'],
      [0, 'S', 'Loose Cheat'],
    );
    const list = buildCheatList(nested);
    expect(list.sections.map((s) => [s.title, s.items.map((i) => i.label)])).toEqual([
      ['Stats › Primary', ['Strength']],
      [null, ['God Mode', 'Loose Cheat']],
    ]);
  });
});
