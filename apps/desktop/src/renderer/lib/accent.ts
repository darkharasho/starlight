import { useLayoutEffect } from 'react';
import { steamCoverUrl } from '../types/catalog-game.js';

/**
 * The open game's colour as the app's accent (Tailwind's `neon-cyan`, the
 * `--accent` CSS variable): the cover's dominant vivid colour, made light
 * enough to read on the dark background. The same idea as HML's game colours.
 */

type Rgb = [number, number, number];

/** The app's background; an accent must read on it, and dark button text must read on the accent. */
const BG: Rgb = [0x1b, 0x1e, 0x2a];
const MIN_CONTRAST = 5;
/** Pixels greyer or darker than this don't vote: backgrounds, shadows, text. */
const MIN_SATURATION = 0.35;
const MIN_VALUE = 0.25;
/** Below this share of colourful pixels the art is too grey to take a colour from. */
const MIN_COLOURFUL_SHARE = 0.04;
const BUCKETS = 36;
const MAX_SAMPLES = 20_000;

export const DEFAULT_ACCENT = '62 224 192';
const HEX = /^#[0-9a-f]{6}$/i;

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = (rgb: Rgb): string => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * The art's dominant vivid colour as `#rrggbb`, bright and saturated enough
 * to be the accent on the dark background. Null when the art is mostly grey,
 * black or white. `rgba` is 4 bytes per pixel, as from a canvas.
 */
export function pickAccent(rgba: Uint8Array | Uint8ClampedArray): string | null {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return null;
  const step = Math.max(1, Math.floor(pixels / MAX_SAMPLES));
  const weight = new Float64Array(BUCKETS);
  const sums = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
  let sampled = 0, colourful = 0;
  for (let p = 0; p < pixels; p += step) {
    const i = p * 4;
    if (rgba[i + 3]! < 128) continue;
    sampled++;
    const rgb: Rgb = [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
    const max = Math.max(...rgb) / 255;
    const sat = max === 0 ? 0 : (max - Math.min(...rgb) / 255) / max;
    if (sat < MIN_SATURATION || max < MIN_VALUE) continue;
    colourful++;
    const b = Math.floor(rgbToHsl(rgb)[0] / (360 / BUCKETS)) % BUCKETS;
    const w = sat * max;
    weight[b]! += w;
    for (let k = 0; k < 3; k++) sums[b]![k]! += rgb[k]! * w;
  }
  if (sampled === 0 || colourful / sampled < MIN_COLOURFUL_SHARE) return null;

  // The hue band (a bucket and its neighbours) holding the most colour wins.
  const band = (b: number): number[] => [(b + BUCKETS - 1) % BUCKETS, b, (b + 1) % BUCKETS];
  let best = 0, bestWeight = -1;
  for (let b = 0; b < BUCKETS; b++) {
    const w = band(b).reduce((t, k) => t + weight[k]!, 0);
    if (w > bestWeight) [best, bestWeight] = [b, w];
  }
  const avg = [0, 0, 0];
  for (const k of band(best)) for (let c = 0; c < 3; c++) avg[c]! += sums[k]![c]!;
  const [h, s0] = rgbToHsl(avg.map((v) => Math.round(v / bestWeight)) as Rgb);

  // Vivid, and light enough to stand out on the background as a fill and as text.
  const s = Math.min(1, Math.max(0.65, s0));
  let l = 0.5;
  while (contrast(hslToRgb(h, s, l), BG) < MIN_CONTRAST && l < 0.85) l += 0.01;
  return toHex(hslToRgb(h, s, l));
}

/** `#rrggbb` → the `--accent` value ("r g b"). */
export function accentVar(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

const storageKey = (appId: number): string => `starlight.accent.${appId}`;

function remembered(appId: number): string | null {
  try {
    const v = localStorage.getItem(storageKey(appId));
    return v && HEX.test(v) ? v : null;
  } catch { return null; }
}

function remember(appId: number, hex: string | null): void {
  try {
    if (hex) localStorage.setItem(storageKey(appId), hex);
    else localStorage.removeItem(storageKey(appId));
  } catch { /* the colour just isn't remembered */ }
}

function apply(hex: string | null): void {
  const root = document.documentElement;
  if (hex) root.style.setProperty('--accent', accentVar(hex));
  else root.style.removeProperty('--accent');
}

/** The cover's pixels, scaled down — the colour vote doesn't need more. */
async function coverAccent(appId: number): Promise<string | null> {
  const url = steamCoverUrl(appId);
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob(), { resizeWidth: 96, resizeQuality: 'low' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return pickAccent(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

/**
 * Recolours the accent to the game's while mounted. The remembered colour
 * shows at once; a fresh one replaces it once the cover is read. With no
 * Steam id, or art too grey to take a colour from, the stock accent stays.
 */
export function useGameAccent(steamAppId: number | null | undefined): void {
  useLayoutEffect(() => {
    if (steamAppId == null) { apply(null); return; }
    let live = true;
    apply(remembered(steamAppId));
    coverAccent(steamAppId).then(
      (hex) => {
        if (!live) return;
        remember(steamAppId, hex);
        apply(hex);
      },
      () => undefined,
    );
    return () => { live = false; apply(null); };
  }, [steamAppId]);
}
