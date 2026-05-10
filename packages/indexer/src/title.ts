const ENTITIES: Array<[RegExp, string]> = [
  [/&amp;/g, '&'],
  [/&#039;/g, "'"],
  [/&apos;/g, "'"],
  [/&quot;/g, '"'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
];

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

export function cleanTitle(raw: string): string {
  let s = raw;
  for (const [re, sub] of ENTITIES) s = s.replace(re, sub);
  s = s.replace(LEADING_BRACKETED, '');
  s = s.replace(TRAILING_BRACKETED, '');
  const cut = s.search(CUT_AT);
  if (cut > 0) s = s.slice(0, cut);
  s = s.trim().replace(TRAILING_NOISE, '');
  return s.length > 0 ? s : raw.trim();
}
