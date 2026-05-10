import { describe, it, expect } from 'vitest';
import { slugify, allocateId } from '../src/slug.js';

describe('slugify', () => {
  it('lowercases and kebab-cases', () => {
    expect(slugify('Elden Ring')).toBe('elden-ring');
    expect(slugify('Cyberpunk 2077')).toBe('cyberpunk-2077');
    expect(slugify('Need for Speed: Heat')).toBe('need-for-speed-heat');
  });

  it('strips diacritics and punctuation', () => {
    expect(slugify('Pokémon™')).toBe('pokemon');
    expect(slugify("Baldur's Gate 3")).toBe('baldurs-gate-3');
  });

  it('collapses repeated separators', () => {
    expect(slugify('A   B  C')).toBe('a-b-c');
    expect(slugify('A--B__C')).toBe('a-b-c');
  });

  it('returns "untitled" for empty input', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
  });
});

describe('allocateId', () => {
  it('returns the basic slug when no collision', () => {
    expect(allocateId('Elden Ring', new Set())).toBe('elden-ring');
  });

  it('uses year-suffix from name when colliding', () => {
    expect(allocateId('Need for Speed (2015)', new Set(['need-for-speed']))).toBe('need-for-speed-2015');
  });

  it('falls back to numeric suffix when no year available', () => {
    expect(allocateId('Elden Ring', new Set(['elden-ring']))).toBe('elden-ring-2');
    expect(allocateId('Elden Ring', new Set(['elden-ring', 'elden-ring-2']))).toBe('elden-ring-3');
  });

  it('prefers year over numeric when both available', () => {
    expect(allocateId('Tomb Raider 2013', new Set(['tomb-raider']))).toBe('tomb-raider-2013');
  });
});
