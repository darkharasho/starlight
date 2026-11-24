import { describe, it, expect } from 'vitest';
import { dedupeGames, nameScore } from '../../src/renderer/lib/dedupe-games.js';

const g = (name: string, extra: Partial<{ trainerUpdatedAt: string; trainerPath: string }> = {}) =>
  ({ name, ...extra });

describe('nameScore', () => {
  it('penalizes raw table/version titles', () => {
    expect(nameScore('10,000,000 table v: 1.0 CT')).toBeLessThan(nameScore('10,000,000'));
  });
  it('rewards proper punctuation over stripped titles', () => {
    expect(nameScore('A Plague Tale: Innocence')).toBeGreaterThan(nameScore('A Plague Tale Innocence'));
  });
  it('prefers mixed case over ALL CAPS', () => {
    expect(nameScore('7th Domain: Tree of Chaos')).toBeGreaterThan(nameScore('7TH DOMAIN TREE OF CHAOS'));
  });
});

describe('dedupeGames', () => {
  it('collapses title-variant duplicates to one entry', () => {
    const out = dedupeGames([g('7 Days To Die'), g('7 Days to Die'), g('7 Days to Die')]);
    expect(out).toHaveLength(1);
  });

  it('keeps the best-titled variant', () => {
    const out = dedupeGames([g('A Plague Tale Innocence'), g('A Plague Tale: Innocence')]);
    expect(out[0]!.name).toBe('A Plague Tale: Innocence');
  });

  it('drops the raw-table variant in favor of the clean name', () => {
    const out = dedupeGames([g('10,000,000 table v: 1.0 CT'), g('10,000,000')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('10,000,000');
  });

  it('keeps distinct games and preserves first-appearance order', () => {
    const out = dedupeGames([g('Alpha'), g('Beta'), g('alpha'), g('Gamma')]);
    expect(out.map((x) => x.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('breaks ties by the more recent trainer', () => {
    const out = dedupeGames([
      g('Same Game', { trainerUpdatedAt: '2026-01-01' }),
      g('Same Game', { trainerUpdatedAt: '2026-05-01' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.trainerUpdatedAt).toBe('2026-05-01');
  });
});

describe('Steam ids', () => {
  const t = (name: string, steamAppId: number | null, topic: number) =>
    ({ name, steamAppId, trainerSource: `https://fearlessrevolution.com/viewtopic.php?f=4&t=${topic}` });

  it('groups by Steam app id even when the names differ', async () => {
    const { dedupeGamesWithSources } = await import('../../src/renderer/lib/dedupe-games.js');
    const r = dedupeGamesWithSources([t('Dragon Age Inquisition', 1222690, 1), t('Dragon Age™ Inquisition', 1222690, 5)]);
    expect(r.games).toHaveLength(1);
    expect(r.games[0]!.trainerSource).toContain('t=5'); // the newer thread
    expect(r.sources.get('steam:1222690')).toEqual([
      'https://fearlessrevolution.com/viewtopic.php?f=4&t=5',
      'https://fearlessrevolution.com/viewtopic.php?f=4&t=1',
    ]);
  });

  it('folds an unmatched variant into the matched game of the same name', async () => {
    const { dedupeGamesWithSources } = await import('../../src/renderer/lib/dedupe-games.js');
    const r = dedupeGamesWithSources([t('Cyberpunk 2077', null, 9), t('Cyberpunk 2077', 1091500, 2)]);
    expect(r.games).toHaveLength(1);
    expect(r.games[0]!.steamAppId).toBe(1091500);
    expect(r.sources.get('steam:1091500')).toHaveLength(2);
  });

  it('steamMatchedOnly hides unmatched entries, but not from a catalog with no ids', async () => {
    const { steamMatchedOnly } = await import('../../src/renderer/lib/dedupe-games.js');
    expect(steamMatchedOnly([t('A', 1, 1), t('B', null, 2)])).toEqual({ games: [t('A', 1, 1)], hidden: 1 });
    const none = [t('A', null, 1), t('B', null, 2)];
    expect(steamMatchedOnly(none)).toEqual({ games: none, hidden: 0 });
  });
});
