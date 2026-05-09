import { describe, it, expect } from 'vitest';
import { mapCtType } from '../src/type-mapper.js';

describe('mapCtType', () => {
  it.each([
    ['Byte', 'uint8'],
    ['2 Bytes', 'int16'],
    ['4 Bytes', 'int32'],
    ['8 Bytes', 'int64'],
    ['Float', 'float'],
    ['Double', 'double'],
    ['String', 'string'],
  ])('maps %s to %s', (ctType, expected) => {
    expect(mapCtType(ctType)).toBe(expected);
  });

  it('returns undefined for unknown types', () => {
    expect(mapCtType('Array of byte')).toBeUndefined();
    expect(mapCtType('Binary')).toBeUndefined();
    expect(mapCtType('')).toBeUndefined();
  });

  it('is case-insensitive on the leading word', () => {
    expect(mapCtType('float')).toBe('float');
    expect(mapCtType('FLOAT')).toBe('float');
  });
});
