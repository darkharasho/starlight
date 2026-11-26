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

export const CommunityCheatFileSchema = z.object({
  schemaVersion: z.literal(1),
  cheat: AgentCheatDraftSchema,
  game: z.object({
    steamAppId: z.number().int().positive(),
    name: z.string().min(1).max(120),
    platform: z.enum(['linux', 'windows']),
    bits: z.union([z.literal(32), z.literal(64)]),
    buildId: z.string().max(40).optional(),
    exeHash: z.string().max(128).optional(),
  }).strict(),
  agent: z.string().max(80).optional(),
  credit: z.string().min(1).max(40).refine((s) => s === s.trim(), 'credit: no spaces at the ends').optional(),
  derivedFrom: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  submittedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

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

const platformName = (p: SharePlatform) => (p === 'windows' ? 'Windows (Proton)' : 'Linux (native)');

function addressText(cheat: Exclude<AgentCheatDraft, { type: 'patch' }>): string {
  const a = cheat.address;
  switch (a.kind) {
    case 'pointer': return [`${a.module ?? '?'}+${a.baseOffset}`, ...a.offsets].join(' → ');
    case 'module': return `${a.module}+${a.offset}`;
    case 'aob': return `AOB ${a.pattern} in ${a.module}${a.offset ? ` + ${a.offset}` : ''}`;
    default: return JSON.stringify(a);
  }
}

export function shareSummary(file: CommunityCheatFile, flags: string[]): string {
  const g = file.game;
  const c = file.cheat;
  const out: string[] = [];
  out.push(`## ${c.name}`, '');
  out.push(`- **Game:** ${g.name} (Steam app ${g.steamAppId}), ${platformName(g.platform)}, ${g.bits}-bit, ${g.buildId ? `build ${g.buildId}` : 'unknown build'}${g.exeHash ? `, exe ${g.exeHash}` : ''}`);
  out.push(`- **Type:** ${c.type}`);
  out.push(`- **Made by:** ${file.agent ?? 'unknown agent'}; credit: ${file.credit ?? 'Anonymous'}`);
  if (file.derivedFrom) out.push(`- **Based on:** community cheat ${file.derivedFrom}`);
  out.push('');
  if (c.type === 'patch') {
    if (c.site) out.push(`**Site:** AOB \`${c.site.pattern}\` in ${c.site.module}${c.site.offset ? ` + ${c.site.offset}` : ''}`, '');
    out.push('**Steps:**', '');
    c.enable.forEach((s, i) => {
      const n = `${i + 1}.`;
      switch (s.op) {
        case 'alloc': out.push(`${n} alloc \`${s.name}\`, ${s.size} bytes${s.near ? `, near ${s.near}` : ''}`); break;
        case 'writeBytes': out.push(`${n} writeBytes at \`${s.at}\`: ${s.original ?? '(original unknown)'} → ${s.bytes}`); break;
        case 'registerSymbol': out.push(`${n} registerSymbol \`${s.name}\` = \`${s.at}\``); break;
        case 'assemble': out.push(`${n} assemble at \`${s.at}\`:`, '', '```asm', ...s.source.split('\n').map((l) => l.trimEnd()), '```', ''); break;
        default: out.push(`${n} ${s.op} ${JSON.stringify(s)}`);
      }
    });
  } else {
    out.push(`**Address:** ${addressText(c)}`);
    out.push(`**Value:** ${c.valueType}${c.value !== undefined ? ` = ${c.value}` : ''}`);
    const r = c.verify?.range;
    if (r) out.push(`**Check:** range ${r.min}–${r.max}`);
  }
  if (flags.length) {
    out.push('', '### Look closely', '', ...flags.map((f) => `- ${f}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
