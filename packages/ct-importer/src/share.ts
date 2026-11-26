// Shared cheats: the file a player submits, the rules every copy of it must
// pass (in the app, the relay and CI), its content hash, the flags a reviewer
// should look at, and the summary that becomes the pull request's description.
import { z } from 'zod';
import { AgentCheatDraftSchema, validateAgentCheat, type AgentCheatDraft } from './agent-cheat.js';

export type SharePlatform = 'linux' | 'windows';

/** A user trainer's platform (`linux` / `linux-proton`) as a shared cheat's platform. */
export function sharePlatformOf(p: string): SharePlatform {
  return p === 'linux-proton' ? 'windows' : 'linux';
}

export const MAX_SHARE_BYTES = 65536;

/** Line breaks, control characters and text-direction overrides: never allowed in a name shown to the reviewer. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const safeText = (s: string) => !UNSAFE_TEXT.test(s);
const NO_BREAKS = 'no line breaks or control characters';
const Credit = z.string().min(1).max(40).refine((s) => s === s.trim(), 'no spaces at the ends').refine(safeText, NO_BREAKS);

export const CommunityCheatFileSchema = z.object({
  schemaVersion: z.literal(1),
  cheat: AgentCheatDraftSchema,
  game: z.object({
    steamAppId: z.number().int().positive(),
    name: z.string().min(1).max(120).refine(safeText, NO_BREAKS),
    platform: z.enum(['linux', 'windows']),
    bits: z.union([z.literal(32), z.literal(64)]),
    buildId: z.string().max(40).optional(),
    exeHash: z.string().max(128).optional(),
  }).strict(),
  agent: z.string().max(80).refine(safeText, NO_BREAKS).optional(),
  credit: Credit.optional(),
  derivedFrom: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  /** The credit of the community cheat this one repairs. */
  derivedCredit: Credit.optional(),
  submittedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict().superRefine((f, ctx) => {
  if (!safeText(f.cheat.name)) ctx.addIssue({ code: 'custom', path: ['cheat', 'name'], message: NO_BREAKS });
  if (f.derivedCredit !== undefined && f.derivedFrom === undefined) {
    ctx.addIssue({ code: 'custom', path: ['derivedCredit'], message: 'only with derivedFrom' });
  }
});

export type CommunityCheatFile = Omit<z.infer<typeof CommunityCheatFileSchema>, 'cheat'> & { cheat: AgentCheatDraft };

const PATH_RE = /[A-Za-z]:\\|\\\\[^\\]|(^|[\s"'(=])\/(home|var|usr|tmp|mnt|run|media|opt|root|Users)\//;

function strings(v: unknown, at: string, out: Array<[string, string]>): void {
  if (typeof v === 'string') out.push([at, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, at ? `${at}.${k}` : k, out);
}

function modules(cheat: AgentCheatDraft): string[] {
  const out: string[] = [];
  if (cheat.type === 'patch') {
    if (cheat.site) out.push(cheat.site.module);
  } else if ('module' in cheat.address && cheat.address.module) {
    out.push(cheat.address.module);
  }
  return out;
}

export function checkShareRules(file: unknown): { ok: true; file: CommunityCheatFile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(file)).length; } catch { errors.push('file: not JSON'); }
  if (size > MAX_SHARE_BYTES) errors.push('file: a shared cheat must be at most 64 KB');

  const parsed = CommunityCheatFileSchema.safeParse(file);
  if (!parsed.success) {
    return { ok: false, errors: [...errors, ...parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`)] };
  }
  const f = parsed.data as CommunityCheatFile;
  const checked = validateAgentCheat(f.cheat);
  if (!checked.ok) errors.push(...checked.errors.map((e) => `cheat.${e}`));

  for (const m of modules(f.cheat)) {
    if (!/^[^/\\]+$/.test(m)) errors.push(`module "${m}": use the module's file name, not a path`);
  }
  const all: Array<[string, string]> = [];
  strings(f, '', all);
  for (const [at, s] of all) {
    if (PATH_RE.test(s)) errors.push(`${at}: looks like a file path on your computer; remove it before sharing`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, file: f };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 (hex) of what the cheat does and where it runs: the cheat, platform and bits. */
export async function shareHash(file: CommunityCheatFile): Promise<string> {
  const text = canonical({ cheat: file.cheat, platform: file.game.platform, bits: file.game.bits });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const JUMP_RE = /^\s*(call|jmp|j[a-z]{1,4})\s+(.+)$/i;
const SYSCALL_RE = /^\s*(syscall|sysenter|int\s+(0x)?[0-9a-f]+h?)\b/i;

export function shareFlags(file: CommunityCheatFile): string[] {
  const cheat = file.cheat;
  if (cheat.type !== 'patch') return [];
  const flags: string[] = [];
  const own = new Set<string>(['site']);
  for (const s of cheat.enable) {
    if (s.op === 'alloc' || s.op === 'registerSymbol') own.add(s.name.toLowerCase());
  }
  for (const [i, s] of cheat.enable.entries()) {
    const step = `step ${i + 1}`;
    if (s.op === 'alloc' && s.near === undefined) {
      flags.push(`${step}: allocates "${s.name}" without near, so it can land anywhere in memory`);
    }
    if (s.op === 'writeBytes' && s.bytes.length / 2 > 64) {
      flags.push(`${step}: writes ${s.bytes.length / 2} bytes`);
    }
    if (s.op !== 'assemble') continue;
    const lines = s.source.split('\n').filter((l) => l.trim() !== '');
    if (lines.length > 50) flags.push(`${step}: assembles ${lines.length} lines`);
    const labels = new Set(s.source.split('\n').map((l) => /^\s*([A-Za-z_@][\w@.]*):/.exec(l)?.[1]?.toLowerCase()).filter(Boolean));
    for (const raw of s.source.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '');
      if (SYSCALL_RE.test(line)) flags.push(`${step}: makes a system call (${line.trim()})`);
      const m = JUMP_RE.exec(line);
      if (!m) continue;
      const target = m[2]!.trim();
      const base = (/^([A-Za-z_@][\w@.]*?)(\s*[+-].*)?$/.exec(target)?.[1] ?? '').toLowerCase();
      const outside = /^(0x[0-9a-f]+|[0-9a-f]+h?)$/i.test(target) || /\.(exe|dll|so)\b/i.test(target)
        || (base !== '' && !own.has(base) && !labels.has(base) && /\+/.test(target));
      if (outside) flags.push(`${step}: jumps or calls outside the cheat (${line.trim()})`);
    }
  }
  return flags;
}

/** Free text as an inline code span: GitHub renders no HTML, links or @mentions inside one. */
function code(text: unknown): string {
  const t = String(text).replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const tick = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') || /^ .* $/.test(t) ? ' ' : '';
  return `${tick}${pad}${t}${pad}${tick}`;
}

/** A fence longer than any backtick run in the source, so the source can't close it. */
function fenceFor(source: string): string {
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const REPO_FILES = 'https://github.com/darkharasho/starlight/blob/main/packages/catalog/community';

const platformName = (p: SharePlatform) => (p === 'windows' ? 'Windows (Proton)' : 'Linux (native)');

function addressText(cheat: Exclude<AgentCheatDraft, { type: 'patch' }>): string {
  const a = cheat.address;
  switch (a.kind) {
    case 'pointer': return code([`${a.module ?? '?'}+${a.baseOffset}`, ...a.offsets].join(' → '));
    case 'module': return code(`${a.module}+${a.offset}`);
    case 'aob': return `AOB ${code(a.pattern)} in ${code(a.module)}${a.offset ? ` + ${code(a.offset)}` : ''}`;
    default: return code(JSON.stringify(a));
  }
}

export function shareSummary(file: CommunityCheatFile, flags: string[]): string {
  const g = file.game;
  const c = file.cheat;
  const out: string[] = [];
  out.push(`## ${code(c.name)}`, '');
  out.push(`- **Game:** ${code(g.name)} (Steam app ${g.steamAppId}), ${platformName(g.platform)}, ${g.bits}-bit, ${g.buildId ? `build ${code(g.buildId)}` : 'unknown build'}${g.exeHash ? `, exe ${code(g.exeHash)}` : ''}`);
  out.push(`- **Type:** ${c.type}`);
  out.push(`- **Made by:** ${file.agent ? code(file.agent) : 'unknown agent'}; credit: ${file.credit ? code(file.credit) : 'Anonymous'}`);
  if (file.derivedFrom) {
    out.push(`- **Based on:** [community cheat ${file.derivedFrom}](${REPO_FILES}/${g.steamAppId}/${file.derivedFrom}.json), credit: ${file.derivedCredit ? code(file.derivedCredit) : 'Anonymous'}`);
  }
  out.push('');
  if (c.type === 'patch') {
    if (c.site) out.push(`**Site:** AOB ${code(c.site.pattern)} in ${code(c.site.module)}${c.site.offset ? ` + ${code(c.site.offset)}` : ''}`, '');
    out.push('**Steps:**', '');
    c.enable.forEach((s, i) => {
      const n = `${i + 1}.`;
      switch (s.op) {
        case 'alloc': out.push(`${n} alloc ${code(s.name)}, ${s.size} bytes${s.near ? `, near ${code(s.near)}` : ''}`); break;
        case 'writeBytes': out.push(`${n} writeBytes at ${code(s.at)}: ${s.original ? code(s.original) : '(original unknown)'} → ${code(s.bytes)}`); break;
        case 'registerSymbol': out.push(`${n} registerSymbol ${code(s.name)} = ${code(s.at)}`); break;
        case 'assemble': {
          const fence = fenceFor(s.source);
          out.push(`${n} assemble at ${code(s.at)}:`, '', `${fence}asm`, ...s.source.split('\n').map((l) => l.trimEnd()), fence, '');
          break;
        }
        default: out.push(`${n} ${s.op} ${code(JSON.stringify(s))}`);
      }
    });
  } else {
    out.push(`**Address:** ${addressText(c)}`);
    out.push(`**Value:** ${c.valueType}${c.value !== undefined ? ` = ${code(c.value)}` : ''}`);
    const r = c.verify?.range;
    if (r) out.push(`**Check:** range ${r.min}–${r.max}`);
  }
  if (flags.length) {
    out.push('', '### Look closely', '', ...flags.map((f) => `- ${f}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
