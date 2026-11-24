/**
 * The game a forum thread title names, with the poster's labels taken off:
 * store and release tags ("(Steam)", "GOG", "Gamepass", "RELOADED"),
 * version / build / date notes ("(2016-05-29)", "[21.2] (b16)", "Update 3"),
 * option counts ("+24 options"), and table words ("Cheat Table for …").
 *
 * Applied after `cleanTitle`. This is what's searched for on Steam, and the
 * name shown for a thread Steam has no match for.
 */

/** Labels a poster appends after the game's name, removed from the end one at a time. */
const TRAILING_LABEL = new RegExp(
  '[\\s,;:/&-]*\\b(?:' + [
    'steam(?: (?:release|version|edition))?(?: version)?\\+?',
    'gog(?: release| version)?', 'epic(?: games)?(?: store)?', 'egs', 'game ?pass', 'gamepass', 'uplay', 'ubisoft connect',
    'ms ?store', 'microsoft store', 'windows store', 'xbox(?: app)?', 'ea app', 'retail', 'itch(?:\\.io)?',
    'reloaded', 'rld', 'tenoke', 'codex', 'skidrow', 'plaza', 'cpy', 'empress', 'fitgirl', 'repack', 'cracked?',
    'x64(?: ?-?bits?)?', 'x86', '64 ?-?bits?', '32 ?-?bits?', 'dx ?\\d{1,2}', 'vulkan',
    'demo', 'playtest', 'early access', 'full release', 'full game', '(?:steam |gog )?release version',
    'latest(?: steam)?(?: update| version| patch)?', 'updated?', 'patch(?:ed)?', 'hotfix',
    'alpha', 'beta', 'build', 'table', 'tables', 'cheats?', 'mega ?-?cheat ?table', 'options?',
    'free game', 'unofficial patch', 'and', '(?:achievement |gear |dlc |item )?unlocker', 'cheat ?engine', 'aio', 'ct', 'ce', 'ce ?tables?', 'pc', 'table v[.:]?',
  ].join('|') + ')\\.?\\s*$',
  'i',
);

const DATE = /\b(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})\b/g;
const MONTH_DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}\b/gi;

export function searchTitle(name: string): string {
  let s = name.replace(/[™®©]/g, '').normalize('NFKC');
  s = s.replace(/^\s*(?:cheat ?table|ct|table|trainer)s?\s+(?:for|of)\s+/i, '');
  // Some posters sort a thread down the list with a leading "z ".
  s = s.replace(/^z\s+(?=\S)/, '');
  s = s.replace(DATE, ' ').replace(MONTH_DATE, ' ');
  // Stray quotes, and "Batman : Arkham" spacing the store search doesn't like.
  s = s.replace(/["“”]/g, '').replace(/\s+:/g, ':');
  // Everything from the first bracket, option count or "@" on is a label.
  const cut = s.search(/\s*(?:[([{~]|\+\s*[\d?]|\s\+\s|@|\*\*)/);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/\s{2,}/g, ' ').trim();
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(TRAILING_LABEL, '').replace(/\b(?:v|ver|version|b|build|update|patch)\s*[.:]?\s*\d[\w.]*\s*$/i, '').replace(/\s\d+(?:\.\d+){1,3}(?:[a-z]|-\S*)?\s*$/i, '').trim();
    s = s.replace(/[\s,;:/&|-]+$/, '');
  }
  return s.length > 0 ? s : name.trim();
}

const ROMAN: Record<string, string> = {
  ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10',
  xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15', xvi: '16',
};

/** Edition labels that don't make a different game. "Remastered" / "Remake" are kept: those are. */
const EDITION = new RegExp(
  '\\b(?:(?:' + [
    'game of the year', 'goty', 'definitive', 'enhanced', 'ultimate', 'complete', 'deluxe', 'special',
    'gold', 'anniversary', 'legendary', 'premium', 'standard', 'digital deluxe', 'collector\'?s',
  ].join('|') + ') edition|game of the year|goty|director\'?s cut)\\b',
  'gi',
);

/** Comparison form: case, accents, punctuation, "&"/"and" and roman numerals don't matter. */
export function normTitle(s: string, dropEdition = false): string {
  let t = s.replace(/[™®©]/g, '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ');
  if (dropEdition) t = t.replace(EDITION, ' ');
  return t
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => ROMAN[w] ?? w)
    .join('');
}

/** True when a Steam app name is the game a cleaned thread title names. */
export function sameGame(title: string, steamName: string): boolean {
  const a = normTitle(title), b = normTitle(steamName);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const ae = normTitle(title, true), be = normTitle(steamName, true);
  return ae !== '' && ae === be;
}
