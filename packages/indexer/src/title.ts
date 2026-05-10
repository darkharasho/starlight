const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&apos;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  let out = s;
  for (const [k, v] of Object.entries(NAMED_ENTITIES)) {
    out = out.replaceAll(k, v);
  }
  // Decimal numeric entity (e.g. &#128640;).
  out = out.replace(/&#(\d+);/g, (_, d) => {
    const cp = Number(d);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
  });
  // Hex numeric entity (e.g. &#x1F680;).
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const cp = parseInt(h, 16);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
  });
  return out;
}

const LEADING_BRACKETED = /^\s*(\[[^\]]*\]\s*)+/;

const CUT_AT = new RegExp(
  '\\s*(' +
    '[|—–-]\\s' +                          // " | ", " — ", " – ", " - "
    '|─{2,}' +                              // ── (used by some posters)
    '|\\(Steam\\)' +
    '|\\[Steam\\]' +
    '|\\bv\\d' +                            // " v1.2.3"
    '|\\bV\\d' +                            // " V1.0.10"
    '|\\bUpdated:' +
    '|\\bachievement table\\b' +
    '|\\bcheat table\\b' +
    '|\\btrainer\\b' +
  ')',
  'i',
);

const TRAILING_BRACKETED = /\s*(\[[^\]]*\]\s*)+$/;
const TRAILING_NOISE = /[\s|:─;,—–-]+$/;

/**
 * Strip emoji / symbol code points commonly used as bookend decoration in
 * forum titles (rockets, fire, sparkles, etc.). We don't want them matched
 * against Steam app names, and they look odd in the Library tile.
 */
function stripDecorativeSymbols(s: string): string {
  // Only Extended_Pictographic (emoji + dingbats). Avoid \p{S} because that
  // includes ASCII punctuation like `|` which the cut regex relies on.
  return s.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s{2,}/g, ' ');
}

export function cleanTitle(raw: string): string {
  let s = decodeEntities(raw);
  s = stripDecorativeSymbols(s);
  s = s.replace(LEADING_BRACKETED, '');
  s = s.replace(TRAILING_BRACKETED, '');
  const cut = s.search(CUT_AT);
  if (cut > 0) s = s.slice(0, cut);
  s = s.trim().replace(TRAILING_NOISE, '');
  return s.length > 0 ? s : raw.trim();
}
