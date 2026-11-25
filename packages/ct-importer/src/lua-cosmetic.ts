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

/**
 * The widely shared "Compact View Mode" snippet: it adds a menu item to Cheat
 * Engine's main window and hides some of its panels. Every name it uses, split
 * on dots. Lua built only from these (assignments included) touches nothing but
 * CE's own window.
 */
const CE_WINDOW = new Set([
  'function', 'local', 'if', 'then', 'else', 'end', 'not', 'and', 'or', 'return', 'nil', 'true', 'false',
  'syntaxcheck', 'cyclefullcompact', 'addcompactmenu', 'sender', 'force', 'state', 'parent',
  'compactmenuitem', 'compactmenualreadyexists', 'caption', 'visible', 'onclick',
  'getmainform', 'splitter1', 'panel4', 'panel5', 'menu', 'items', 'createmenuitem', 'add',
]);

function stripLua(src: string): string {
  return src
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\[(=*)\[[\s\S]*?\]\1\]/g, ' "" ')
    .replace(/\[(?:enable|disable)\]/gi, ' ');
}

/** True when `src` is cosmetic Lua (see above); empty or comment-only Lua counts too. */
export function isCosmeticLua(src: string): boolean {
  const code = stripLua(src);
  const words = code.match(/[A-Za-z_][\w.:]*/g) ?? [];
  if (words.every((w) => w.split(/[.:]/).every((p) => CE_WINDOW.has(p.toLowerCase())))) return true;
  // Comparisons are fine (`messageDialog(…) == mrYes`); assignments aren't.
  if (/=/.test(code.replace(/[=~<>]=/g, ' '))) return false;
  return words.every((w) => ALLOWED.has(w.toLowerCase()));
}
