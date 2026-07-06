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
