import { describe, it, expect } from 'vitest';
import { cleanTitle } from '../src/title.js';

describe('cleanTitle', () => {
  it('strips |-delimited version metadata', () => {
    expect(cleanTitle('Crusader Kings III | Steam v1.18.2 | Updated: 2025-12-12'))
      .toBe('Crusader Kings III');
  });

  it('strips trailing decorations like (Steam) ── Cheat Table', () => {
    expect(cleanTitle('Horny Villa (Steam) ── Cheat Table'))
      .toBe('Horny Villa');
  });

  it('strips leading [Steam] / [REUPLOAD]', () => {
    expect(cleanTitle('[Steam] Escape Dungeon 2')).toBe('Escape Dungeon 2');
    expect(cleanTitle('Dead Rising 3 [REUPLOAD]')).toBe('Dead Rising 3');
  });

  it('strips - table v: notation', () => {
    expect(cleanTitle('R.U.S.E. - table v: 1.0 CT')).toBe('R.U.S.E.');
  });

  it('strips - Achievement Table - V<n>', () => {
    expect(cleanTitle('Europa Universalis 5 - Achievement Table - V1.0.10'))
      .toBe('Europa Universalis 5');
  });

  it('preserves colons inside game names (Need for Speed: Heat)', () => {
    expect(cleanTitle('Need for Speed: Heat')).toBe('Need for Speed: Heat');
  });

  it('decodes HTML entities', () => {
    expect(cleanTitle("Baldur&#039;s Gate 3 - v4.1.0")).toBe("Baldur's Gate 3");
    expect(cleanTitle('Crusader &amp; Knights')).toBe('Crusader & Knights');
  });

  it('returns raw input when result would be empty', () => {
    expect(cleanTitle('  ')).toBe('');
    expect(cleanTitle('|||')).toBe('|||');
  });

  it('strips trailing whitespace and punctuation', () => {
    expect(cleanTitle('Game Name |')).toBe('Game Name');
    expect(cleanTitle('Game Name —')).toBe('Game Name');
  });

  it('handles em-dash and en-dash separators', () => {
    expect(cleanTitle('Some Game — Cheat Table')).toBe('Some Game');
    expect(cleanTitle('Some Game – Cheat Table')).toBe('Some Game');
  });
});
