import { describe, it, expect } from 'vitest';
import { accentVar, contrast, pickAccent } from '../../src/renderer/lib/accent.js';

function image(pixels: Array<[number, number, number]>): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => out.set([r, g, b, 255], i * 4));
  return out;
}
const hexRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const BG: [number, number, number] = [0x1b, 0x1e, 0x2a];

describe('pickAccent', () => {
  it('takes the dominant vivid colour and keeps it readable on the background', () => {
    // Mostly dark red art with a little blue and lots of grey.
    const px: Array<[number, number, number]> = [
      ...Array(300).fill([120, 10, 10]), ...Array(40).fill([20, 40, 200]), ...Array(500).fill([60, 60, 60]),
    ];
    const hex = pickAccent(image(px))!;
    const [r, g, b] = hexRgb(hex);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(contrast([r, g, b], BG)).toBeGreaterThanOrEqual(5);
  });

  it('gives up on grey art', () => {
    expect(pickAccent(image(Array(1000).fill([128, 128, 130])))).toBeNull();
    expect(pickAccent(new Uint8Array())).toBeNull();
  });
});

it('accentVar turns hex into the space-separated CSS value', () => {
  expect(accentVar('#3ee0c0')).toBe('62 224 192');
});
