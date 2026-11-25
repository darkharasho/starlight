/**
 * Lua that only talks to the player — opens a link, shows a message, asks a
 * yes/no question before opening a link — and never touches the game or the
 * table. Tables carry a lot of it ("Donate", "More cheats here", "Join the
 * Discord"); without Cheat Engine there is nothing to show it in, so it can be
 * skipped instead of keeping the whole table off the native engine.
 */

/** Functions, constants and keywords such Lua may use. Anything else (or any assignment) is real code. */
const ALLOWED = new Set([
  'shellexecute', 'messagedialog', 'showmessage', 'print',
  'getmainform', 'commentbutton.doclick',
  'mtconfirmation', 'mtinformation', 'mtwarning', 'mterror', 'mtcustom',
  'mbyes', 'mbno', 'mbok', 'mbcancel', 'mryes', 'mrno', 'mrok', 'mrcancel',
  'if', 'then', 'else', 'elseif', 'end', 'not', 'and', 'or', 'return', 'nil', 'true', 'false',
  'syntaxcheck',
]);

/** True when `src` is cosmetic Lua (see above); empty or comment-only Lua counts too. */
export function isCosmeticLua(src: string): boolean {
  const code = src
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\[(=*)\[[\s\S]*?\]\1\]/g, ' "" ')
    .replace(/\[(?:enable|disable)\]/gi, ' ');
  // Comparisons are fine (`messageDialog(…) == mrYes`); assignments aren't.
  if (/=/.test(code.replace(/[=~<>]=/g, ' '))) return false;
  for (const w of code.match(/[A-Za-z_][\w.:]*/g) ?? []) {
    if (!ALLOWED.has(w.toLowerCase())) return false;
  }
  return true;
}
