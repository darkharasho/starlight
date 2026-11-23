/**
 * Turns a cheat table's raw record tree into something a person can use.
 *
 * Community tables are written for Cheat Engine's own window: a "master" script
 * you must switch on before anything else works, cheats nested under it, value
 * rows that only make sense once their parent is on, and rows of decoration
 * (separators, author credits, Discord links). This module works out which
 * scripts are those prerequisites (so they can be switched on automatically)
 * and flattens the rest into titled sections of cheats.
 */

export interface ListRecord {
  id: number;
  name: string;
  isActive: boolean;
  isGroupHeader: boolean;
  kind?: 'script' | 'value' | 'header' | undefined;
  depth?: number | undefined;
  /** CE option flags, e.g. "[moHideChildren,moActivateChildrenAsWell]". */
  opts?: string | undefined;
}

interface Node<R extends ListRecord> {
  rec: R;
  parent: Node<R> | null;
  children: Node<R>[];
}

function kindOf(r: ListRecord): 'script' | 'value' | 'header' {
  return r.isGroupHeader ? 'header' : r.kind ?? 'script';
}

function hasOpt(r: ListRecord, flag: string): boolean {
  return (r.opts ?? '').includes(flag);
}

/** Rebuilds the tree from the depth-first record list. */
function toTree<R extends ListRecord>(records: R[]): Node<R>[] {
  const roots: Node<R>[] = [];
  const stack: Node<R>[] = [];
  for (const rec of records) {
    const depth = Math.max(0, rec.depth ?? 0);
    while (stack.length > depth) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const node: Node<R> = { rec, parent, children: [] };
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

// ── names ────────────────────────────────────────────────────────────────────

// Runs of rule characters, bullets and arrows, emoji, and checkbox-style markers like "[#]" / "[ ]".
const LEAD_DECOR = /^(?:[=\-~*#_]{2,}|[→►▶»•●◆■□▸🞂>*|]+|\p{Extended_Pictographic}\uFE0F?|\[\s*[#*xX]?\s*\])\s*/u;
const TRAIL_DECOR = /\s*(?:[=\-~*#_]{2,}|[←◄◀«*|]+)$/u;
const KEY_HINT = /^\[\s*(?:F\d{1,2}|Num(?:pad)?\s?\d|(?:Ctrl|Alt|Shift)\s*\+[^\]]+)\s*\]\s*/i;

/** Splits a single identifier-like token ("currHP", "FREE_REROLLS") into words. */
function splitIdentifier(s: string): string {
  if (/\s/.test(s) || !/^[A-Za-z0-9_]+$/.test(s)) return s;
  if (s.includes('_')) {
    return s.split('_').filter(Boolean)
      .map((w) => (w === w.toUpperCase() && w.length > 3 ? w[0] + w.slice(1).toLowerCase() : w))
      .join(' ');
  }
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/** Strips the decoration table authors wrap names in. Never returns an empty string for a real name. */
export function tidyName(raw: string): string {
  let s = raw.trim().replace(/^"+|"+$/g, '');
  s = s.replace(/\s*\(\s*\)\s*-?>\s*$/, '');                    // trailing " ()->"
  s = s.replace(/^\[\s*[—–-]+\s*(.*?)\s*[—–-]+\s*\]$/, '$1');   // "[— Name —]"
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEAD_DECOR, '').replace(TRAIL_DECOR, '').replace(KEY_HINT, '').trim();
    if (next === s) break;
    s = next;
  }
  s = s.replace(/^<(.+)>k__BackingField$/, '$1');               // C# auto-property fields
  s = splitIdentifier(s).replace(/\s+/g, ' ').trim();
  if (s === '') return raw.trim();
  return s[0]!.toUpperCase() + s.slice(1);
}

/** True for rows that are only decoration: "--------", "====", "". */
export function isSeparator(name: string): boolean {
  return name.replace(/[^\p{L}\p{N}]/gu, '') === '';
}

const JUNK = new RegExp([
  // advertising and links
  String.raw`\b(?:discord|patreon|donat(?:e|ion)s?|paypal|ko-?fi|buy me a|support me|website|table requirements|read ?me|changelog|credits)\b`,
  // controls for Cheat Engine's own window and for table frameworks, meaningless here
  String.raw`\bcompact ?mode\b|\bfull view\b|\bthemes?\b|\btable state\b|\bdata directory\b|\bquick links\b|\bdebug data\b`,
  String.raw`\b(?:close|start|attach to) process\b|\bCET\s*:\s*(?:config|helper|debug|states|themes)\b`,
].join('|'), 'i');

/** True for rows that aren't cheats: adverts, links, and controls for Cheat Engine's own window. */
export function isJunk(name: string): boolean {
  return JUNK.test(name);
}

// ── prerequisites ────────────────────────────────────────────────────────────

/** Names that unmistakably mean "switch this on before anything else". */
const ACTIVATION = new RegExp([
  String.raw`^\W*(?:enable|activate|attach|initiali[sz]e|init)\W*(?:table|scripts?|me|first|mono|il2cpp|game|\(|$)`,
  String.raw`wait up to`,
  String.raw`must be (?:enabled|activated|on)`,
  String.raw`(?:enable|activate) (?:this |me )?first`,
  String.raw`auto-?attach`,
  String.raw`table activation`,
  String.raw`main script`,
].join('|'), 'i');

function visibleChildren<R extends ListRecord>(n: Node<R>): Node<R>[] {
  // moAlwaysHideChildren: the author never shows these, even in Cheat Engine.
  return hasOpt(n.rec, 'moAlwaysHideChildren') ? [] : n.children;
}

function countDescendants<R extends ListRecord>(n: Node<R>, pred: (r: R) => boolean): number {
  let c = 0;
  for (const ch of visibleChildren(n)) {
    if (isJunk(ch.rec.name)) continue;      // and everything under it
    if (pred(ch.rec)) c++;
    c += countDescendants(ch, pred);
  }
  return c;
}

/** Scripts directly inside a node, looking through section headers. */
function directScriptChildren<R extends ListRecord>(n: Node<R>): number {
  let c = 0;
  for (const ch of visibleChildren(n)) {
    if (isJunk(ch.rec.name)) continue;
    if (kindOf(ch.rec) === 'header') c += directScriptChildren(ch);
    else if (kindOf(ch.rec) === 'script') c++;
  }
  return c;
}

export interface Prerequisite {
  id: number;
  /** The prerequisite this one sits under, if any — only worth trying once that one is on. */
  parentId: number | null;
}

/**
 * Finds the scripts that exist only to unlock the rest of the table, in the
 * order they must be switched on. Deliberately conservative: a script that
 * might be a cheat in its own right is left for the user.
 */
export function findPrerequisites<R extends ListRecord>(records: R[]): Prerequisite[] {
  const roots = toTree(records);
  const nonHeader = (r: R): boolean => kindOf(r) !== 'header' && !isJunk(r.name);
  const total = roots.reduce((acc, n) => acc + (isJunk(n.rec.name) ? 0 : (nonHeader(n.rec) ? 1 : 0) + countDescendants(n, nonHeader)), 0);

  const out: Prerequisite[] = [];
  let rootScriptsSeen = 0;

  const walk = (nodes: Node<R>[], parentPrereq: number | null, underScript: boolean): void => {
    for (const n of nodes) {
      const kind = kindOf(n.rec);
      if (isJunk(n.rec.name)) continue;
      if (kind === 'header') { walk(visibleChildren(n), parentPrereq, underScript); continue; }
      if (kind !== 'script') continue;

      const atRoot = !underScript;
      const rootOrdinal = atRoot ? ++rootScriptsSeen : 0;
      const descendants = countDescendants(n, nonHeader);
      const directScripts = directScriptChildren(n);
      const hides = hasOpt(n.rec, 'moHideChildren');

      const qualifies =
        !hasOpt(n.rec, 'moActivateChildrenAsWell') && (
          // says so itself: "Enable", "Initialize Mono", "Table Activation"
          (ACTIVATION.test(n.rec.name) && (descendants >= 1 || (atRoot && rootOrdinal <= 2))) ||
          // a container holding several cheats is a gate, not a cheat with an option
          (hides && directScripts >= 2) ||
          // most of the table sits behind it
          (atRoot && hides && descendants >= 2 && descendants * 2 >= total - 1)
        );

      if (qualifies) {
        out.push({ id: n.rec.id, parentId: parentPrereq });
        walk(visibleChildren(n), n.rec.id, true);
      }
      // Anything under a script that isn't a prerequisite is that cheat's own
      // sub-option; leave it alone.
    }
  };
  walk(roots, null, false);
  return out;
}

// ── display list ─────────────────────────────────────────────────────────────

export interface CheatItem<R extends ListRecord> {
  rec: R;
  label: string;
  /** 0 = a cheat, 1 = an option belonging to the cheat above it. */
  indent: 0 | 1;
  /** A line of guidance from the table author rather than something to toggle. */
  note: boolean;
  /** Options that appear once this cheat is switched on. */
  hiddenChildren: number;
}

export interface CheatSection<R extends ListRecord> {
  title: string | null;
  items: CheatItem<R>[];
}

export interface CheatList<R extends ListRecord> {
  sections: CheatSection<R>[];
  /** Table-level remarks (author, version, …). */
  notes: string[];
  /** Number of toggleable/editable entries shown. */
  total: number;
}

export interface BuildOpts {
  /** Prerequisites that are on (or assumed on, in a preview): hidden, their children promoted. */
  transparentIds?: ReadonlySet<number>;
  /** Show options even when their cheat is off (previews, where nothing can be switched on). */
  revealAll?: boolean;
}

/** Headings that say nothing ("Scripts", "Cheats") don't earn a level of their own. */
const GENERIC_HEADING = /^(?:scripts?|cheats?|table|options?|main)$/i;

function sectionPath(path: string[], label: string): string[] {
  // Framework tables prefix every heading ("CET : Scripts", "Scripts : Character").
  const short = label.includes(' : ') ? label.slice(label.lastIndexOf(' : ') + 3).trim() : label;
  if (short === '' || isSeparator(short) || GENERIC_HEADING.test(short)) return path;
  return [...path, short];
}

export function buildCheatList<R extends ListRecord>(records: R[], opts: BuildOpts = {}): CheatList<R> {
  const transparent = opts.transparentIds ?? new Set<number>();
  const sections: CheatSection<R>[] = [];
  const byKey = new Map<string, CheatSection<R>>();
  const notes: string[] = [];
  let total = 0;

  const sectionFor = (path: string[]): CheatSection<R> => {
    const key = path.join('\u0000');
    let s = byKey.get(key);
    if (!s) {
      s = { title: path.length === 0 ? null : path.slice(-2).join(' › '), items: [] };
      byKey.set(key, s);
      sections.push(s);
    }
    return s;
  };

  const walk = (nodes: Node<R>[], path: string[], inItem: boolean): void => {
    for (const n of nodes) {
      const kind = kindOf(n.rec);
      const kids = visibleChildren(n);
      if (isJunk(n.rec.name)) continue;

      if (kind === 'header') {
        const label = tidyName(n.rec.name);
        if (kids.length === 0) {
          if (isSeparator(n.rec.name)) continue;
          // An empty heading is a remark: guidance when it sits among a
          // cheat's options, table info (author, version) at the very top.
          if (inItem) sectionFor(path).items.push({ rec: n.rec, label, indent: 1, note: true, hiddenChildren: 0 });
          else if (n.parent === null) notes.push(label);
          continue;
        }
        if (inItem) walk(kids, path, true);            // a sub-heading inside a cheat's options: just flatten
        else walk(kids, sectionPath(path, label), false);
        continue;
      }

      if (transparent.has(n.rec.id)) { walk(kids, path, inItem); continue; }
      if (isSeparator(n.rec.name) && kids.length === 0) continue;

      const reveal = opts.revealAll === true || n.rec.isActive || kind === 'value';
      const hidden = kids.length > 0 && !reveal ? countDescendants(n, (r) => kindOf(r) !== 'header' && !isJunk(r.name)) : 0;
      sectionFor(path).items.push({ rec: n.rec, label: tidyName(n.rec.name), indent: inItem ? 1 : 0, note: false, hiddenChildren: hidden });
      total++;
      if (kids.length > 0 && reveal) walk(kids, path, true);
    }
  };
  walk(toTree(records), [], false);

  return { sections: sections.filter((s) => s.items.length > 0), notes, total };
}
