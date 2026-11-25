/**
 * `{$lua}` blocks and `luacall(…)` lines inside an Auto Assembler script. CE runs them while it
 * processes the script; a block's returned string replaces it in the AA source. `[ENABLE]` and
 * `[DISABLE]` inside a block split it, as in CE (it splits a script into its sections before running
 * the Lua): the block's lines before its first marker belong to the section the block sits in, or to
 * both for a block before any section.
 *
 * A block's `code` keeps its line positions: chunk line 1 is the `{$lua}` line, so an error on
 * chunk line N is script line `line + N - 1`.
 */
import { isCosmeticLuaBlock } from './lua-cosmetic.js';

export type LuaSection = 'pre' | 'enable' | 'disable';
export interface LuaBlock { code: string; section: LuaSection; line: number }

const MARKER = /^\s*\[(enable|disable)\]\s*$/i;
const LUACALL = /^[ \t]*luacall\s*\((.*)\)[ \t]*$/i;

interface Region {
  start: number;
  end: number;
  /** Text inside the region (between `{$lua}` and `{$asm}`, or luacall's argument). */
  body: string;
  line: number;
  outer: LuaSection;
  luacall: boolean;
}

const lineAt = (s: string, i: number) => s.slice(0, i).split('\n').length;

function regions(script: string): Region[] {
  const out: Array<Omit<Region, 'outer'>> = [];
  const open = /\{\$lua\}/gi;
  for (let m = open.exec(script); m; m = open.exec(script)) {
    const bodyStart = m.index + m[0].length;
    const close = /\{\$asm\}/i.exec(script.slice(bodyStart));
    const bodyEnd = close ? bodyStart + close.index : script.length;
    out.push({ start: m.index, end: close ? bodyEnd + close[0].length : script.length, body: script.slice(bodyStart, bodyEnd), line: lineAt(script, m.index), luacall: false });
    open.lastIndex = close ? bodyEnd + close[0].length : script.length;
  }
  // luacall lines outside blocks
  let at = 0;
  for (const [i, l] of script.split('\n').entries()) {
    const m = LUACALL.exec(l);
    if (m && !out.some((r) => at >= r.start && at < r.end)) {
      out.push({ start: at, end: at + l.length, body: m[1]!, line: i + 1, luacall: true });
    }
    at += l.length + 1;
  }
  out.sort((a, b) => a.start - b.start);
  // The section each region sits in: the last marker outside regions before it.
  let section: LuaSection = 'pre';
  let pos = 0;
  const withOuter: Region[] = [];
  const markersBetween = (from: number, to: number) => {
    for (const l of script.slice(from, to).split('\n')) {
      const mm = MARKER.exec(l);
      if (mm) section = mm[1]!.toLowerCase() as LuaSection;
    }
  };
  for (const r of out) {
    markersBetween(pos, r.start);
    withOuter.push({ ...r, outer: section });
    // markers inside a block move the section for what follows it
    markersBetween(r.start, r.end);
    pos = r.end;
  }
  return withOuter;
}

/** The region's lines split by section: `null` for marker lines. */
function sectionsOf(body: string): Array<{ text: string; section: LuaSection | null }> {
  let section: LuaSection = 'pre';
  return body.split('\n').map((text) => {
    const m = MARKER.exec(text);
    if (m) { section = m[1]!.toLowerCase() as LuaSection; return { text, section: null }; }
    return { text, section };
  });
}

/** One entry per section a region runs in. */
function blocksOf(r: Region): LuaBlock[] {
  if (r.luacall) return [{ code: r.body, section: r.outer, line: r.line }];
  const lines = sectionsOf(r.body);
  const split = lines.some((l) => l.section === null);
  if (!split) return [{ code: r.body, section: r.outer, line: r.line }];
  // Lines before the block's first marker are in the section the block sits in; for a block
  // before any section, in both.
  const inSection = (l: { section: LuaSection | null }, s: LuaSection) =>
    l.section === s || (l.section === 'pre' && (r.outer === 'pre' || r.outer === s));
  const out: LuaBlock[] = [];
  for (const s of ['enable', 'disable'] as const) {
    if (!lines.some((l) => inSection(l, s) && l.text.trim() !== '')) continue;
    const code = lines.map((l) => (inSection(l, s) ? l.text : '')).join('\n');
    out.push({ code, section: s, line: r.line });
  }
  return out;
}

const cosmetic = (r: Region) => isCosmeticLuaBlock(r.body);

export function luaBlocks(script: string): LuaBlock[] {
  return regions(script).filter((r) => !cosmetic(r)).flatMap(blocksOf);
}

/** The region's text with only its marker lines kept (same line count). */
function blanked(script: string, r: Region): string[] {
  return script.slice(r.start, r.end).split('\n').map((l) => (MARKER.test(l) ? l.trim() : ''));
}

async function rewrite(
  script: string,
  replace: (r: Region, lines: string[]) => Promise<void>,
): Promise<string> {
  let out = '';
  let pos = 0;
  for (const r of regions(script)) {
    const lines = blanked(script, r);
    await replace(r, lines);
    out += script.slice(pos, r.start) + lines.join('\n');
    pos = r.end;
  }
  return out + script.slice(pos);
}

/** The script with every Lua block (and luacall line) blanked; section markers and line count stay. */
export function stripLuaBlocks(script: string): string {
  let out = '';
  let pos = 0;
  for (const r of regions(script)) {
    out += script.slice(pos, r.start) + blanked(script, r).join('\n');
    pos = r.end;
  }
  return out + script.slice(pos);
}

/**
 * Runs the blocks of `sections` in source order and splices each one's returned text where it
 * was (into its own section for a split block); every other block is blanked.
 */
export async function expandLuaBlocks(
  script: string,
  sections: LuaSection[],
  run: (b: LuaBlock) => Promise<string | null>,
): Promise<string> {
  return rewrite(script, async (r, lines) => {
    if (cosmetic(r)) return;
    for (const b of blocksOf(r)) {
      if (!sections.includes(b.section)) continue;
      const text = await run(b);
      if (text === null || text === '') continue;
      // Into the block's first line, or the line after its section's marker.
      let at = 0;
      if (!r.luacall && lines.some((l) => MARKER.test(l))) {
        const marker = lines.findIndex((l) => MARKER.exec(l)?.[1]?.toLowerCase() === b.section);
        at = marker + 1;
        if (at >= lines.length || MARKER.test(lines[at]!)) { lines.splice(at, 0, text); continue; }
      }
      lines[at] = lines[at] ? `${lines[at]}\n${text}` : text;
    }
  });
}
