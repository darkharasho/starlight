// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listUserCheatGames, loadUserTrainer, saveUserCheat, removeUserCheat, userCheatsDir } from '../../src/main/user-cheats.js';

const game = { name: '9 Kings', exeName: '9Kings.exe', proton: true, steamAppId: 2162800 };
const gold = {
  name: 'Infinite gold', type: 'freeze' as const, valueType: 'int32' as const, value: 999,
  address: { kind: 'absolute' as const, address: '0x1000' },
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'uc-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('user cheats', () => {
  it('userCheatsDir is under userData', () => {
    expect(userCheatsDir('/u')).toBe('/u/user-cheats');
  });

  it('save creates a v2 trainer for the game with the cheat in "My cheats"', async () => {
    const { id } = await saveUserCheat(dir, '9kings', game, gold);
    expect(id).toBe('infinite-gold');
    const t = JSON.parse(await readFile(join(dir, '9kings.json'), 'utf8'));
    expect(t.schemaVersion).toBe(2);
    expect(t.id).toBe('user-9kings');
    expect(t.metadata.source.convertedFrom).toBe('starlight');
    expect(t.game.platform).toEqual(['linux-proton']);
    expect(t.categories[0].name).toBe('My cheats');
    expect(t.categories[0].cheats[0].id).toBe('infinite-gold');
    expect((await loadUserTrainer(dir, '9kings'))?.game.steamAppId).toBe(2162800);
  });

  it('ids are slugs, unique per game', async () => {
    await saveUserCheat(dir, '9kings', game, gold);
    expect((await saveUserCheat(dir, '9kings', game, gold)).id).toBe('infinite-gold-2');
    expect((await saveUserCheat(dir, '9kings', game, { ...gold, id: 'ignored' })).id).toBe('infinite-gold-3');
  });

  it('replaces keeps the id and position', async () => {
    await saveUserCheat(dir, '9kings', game, gold);
    await saveUserCheat(dir, '9kings', game, { ...gold, name: 'Other' });
    const r = await saveUserCheat(dir, '9kings', game, { ...gold, name: 'Renamed', value: 5 }, { replaces: 'infinite-gold' });
    expect(r.id).toBe('infinite-gold');
    const cheats = (await loadUserTrainer(dir, '9kings'))!.categories[0]!.cheats;
    expect(cheats.map((c) => c.id)).toEqual(['infinite-gold', 'other']);
    expect(cheats[0]!.name).toBe('Renamed');
  });

  it('unknown replaces is an error', async () => {
    await expect(saveUserCheat(dir, '9kings', game, gold, { replaces: 'nope' }))
      .rejects.toThrow('no cheat "nope" in your library for this game');
  });

  it('load returns null for a game with no file', async () => {
    expect(await loadUserTrainer(dir, 'missing')).toBeNull();
  });

  it('rejects keys that are not plain slugs', async () => {
    await expect(saveUserCheat(dir, '../x', game, gold)).rejects.toThrow('bad game key');
    await expect(loadUserTrainer(dir, '../x')).rejects.toThrow('bad game key');
    await expect(removeUserCheat(dir, 'A b', 'x')).rejects.toThrow('bad game key');
  });

  it('remove drops the cheat', async () => {
    await saveUserCheat(dir, '9kings', game, gold);
    expect(await removeUserCheat(dir, '9kings', 'infinite-gold')).toBe(true);
    expect(await removeUserCheat(dir, '9kings', 'infinite-gold')).toBe(false);
    expect((await loadUserTrainer(dir, '9kings'))!.categories[0]!.cheats).toEqual([]);
  });

  it('concurrent saves keep every cheat', async () => {
    await Promise.all([1, 2, 3, 4].map((i) => saveUserCheat(dir, '9kings', game, { ...gold, name: `c${i}` })));
    expect((await loadUserTrainer(dir, '9kings'))!.categories[0]!.cheats).toHaveLength(4);
  });

  it('a corrupt library file is never overwritten by a save or remove', async () => {
    await writeFile(join(dir, '9kings.json'), '{ not json', 'utf8');
    await expect(saveUserCheat(dir, '9kings', game, gold)).rejects.toThrow(/can't be read/);
    await expect(removeUserCheat(dir, '9kings', 'x')).rejects.toThrow(/can't be read/);
    expect(await readFile(join(dir, '9kings.json'), 'utf8')).toBe('{ not json');
    await writeFile(join(dir, '9kings.json'), '{"schemaVersion":2}', 'utf8');
    await expect(saveUserCheat(dir, '9kings', game, gold)).rejects.toThrow(/can't be read/);
    expect(await readFile(join(dir, '9kings.json'), 'utf8')).toBe('{"schemaVersion":2}');
  });

  it('an invalid cheat is not written', async () => {
    const bad = { ...gold, valueType: 'bogus' } as never;
    await expect(saveUserCheat(dir, '9kings', game, bad)).rejects.toThrow(/isn't valid/);
    expect(await loadUserTrainer(dir, '9kings')).toBeNull();
  });

  it('listUserCheatGames lists games with cheats, skipping empty and unreadable files', async () => {
    expect(await listUserCheatGames(join(dir, 'missing'))).toEqual([]);
    await saveUserCheat(dir, '9kings', game, gold);
    await saveUserCheat(dir, '9kings', game, { ...gold, name: 'Other' });
    const { id } = await saveUserCheat(dir, 'emptied', { ...game, name: 'Emptied' }, gold);
    await removeUserCheat(dir, 'emptied', id);
    await saveUserCheat(dir, 'native', { name: 'Native', exeName: 'native', proton: false, steamAppId: null }, gold);
    await writeFile(join(dir, 'broken.json'), '{', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'x', 'utf8');
    expect(await listUserCheatGames(dir)).toEqual([
      { key: '9kings', name: '9 Kings', steamAppId: 2162800, processName: ['9Kings.exe'], proton: true, cheats: 2 },
      { key: 'native', name: 'Native', steamAppId: null, processName: ['native'], proton: false, cheats: 1 },
    ]);
  });
});
