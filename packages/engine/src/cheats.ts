import type {
  StarlightAddress, StarlightCheat, StarlightPatchCheat, StarlightPatchStep, StarlightValueCheat, StarlightVerify,
} from '@starlight/ct-importer';
import type { EngineClient } from './client.js';
import type { Session } from './session.js';
import type { EnableOptions, SymbolRegistry, ValueType, VerifyResult } from './types.js';
import { aobScan } from './aob-scan.js';
import { resolvePointerChain } from './pointer-chain.js';
import { read, readMany } from './memory.js';
import { freeze, type FreezeHandle } from './freeze.js';
import { assemble, alloc, patch } from './code.js';
import { EngineError, NeedsUpdateError, RpcCode, ScanError } from './errors.js';

/**
 * Parses `0x10`, `module+1A2B`, `module-0x10` and `"My Game.exe"+10`. Hex needs no `0x` after
 * `+`/`-`; a bare number needs it. Returns null for anything else (such as a symbol name).
 */
export function parseAddressExpr(expr: string): { module: string | null; offset: bigint } | null {
  const e = expr.trim();
  let m = /^0x([0-9a-fA-F]+)$/.exec(e);
  if (m) return { module: null, offset: BigInt('0x' + m[1]) };
  m = /^(?:"([^"]+)"|([A-Za-z0-9_.]+))\s*([+-])\s*(?:0x)?([0-9a-fA-F]+)$/.exec(e);
  if (!m) return null;
  const offset = BigInt('0x' + m[4]);
  return { module: (m[1] ?? m[2])!, offset: m[3] === '-' ? -offset : offset };
}

function moduleNotFound(module: string): ScanError {
  const err = new ScanError(`${module} isn't loaded`);
  err.code = RpcCode.ModuleNotFound;
  return err;
}

/** Base address of a loaded module. A module that isn't loaded is a ScanError (ModuleNotFound). */
async function moduleBase(s: Session, module: string): Promise<bigint> {
  try {
    return BigInt(await resolvePointerChain(s, { module, baseAddress: '0x0', offsets: [] }));
  } catch (err) {
    if (err instanceof EngineError && err.code === RpcCode.ModuleNotFound) throw moduleNotFound(module);
    throw err;
  }
}

/** Resolves `0x…` or `module±offset` to an absolute address. A module that isn't loaded is a ScanError (ModuleNotFound). */
export async function resolveAddressExpr(s: Session, expr: string): Promise<string> {
  const p = parseAddressExpr(expr);
  if (!p) throw new EngineError(`can't read the address ${expr}`);
  if (p.module === null) return hex(p.offset);
  return hex((await moduleBase(s, p.module)) + p.offset);
}

const MASK64 = (1n << 64n) - 1n;
const hex = (n: bigint) => '0x' + n.toString(16);
const lower = (name: string) => name.toLowerCase();

/** `0x10` / `-0x10` / `10` as a signed BigInt. */
function signedHex(v: string): bigint {
  const t = v.trim();
  const neg = t.startsWith('-');
  const digits = t.replace(/^[+-]/, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(digits)) throw new EngineError(`can't read the offset ${v}`);
  const n = BigInt('0x' + digits);
  return neg ? -n : n;
}

/** An offset for the daemon's pointer walk, which adds with wrap-around: `-0x10` becomes its 64-bit two's complement. */
const wireOffset = (v: string) => hex(signedHex(v) & MASK64);

function addOffset(address: string, offset: string | undefined): string {
  if (!offset) return address;
  return hex(BigInt(address) + signedHex(offset));
}

/** Unknown name in an address expression. verifyCheat skips steps whose names a running cheat makes. */
class UnregisteredSymbolError extends EngineError {
  constructor(readonly symbol: string) {
    super(`symbol ${symbol} isn't registered`);
  }
}

/** The names an address expression can use: AA-local symbols (labels, allocs, aobs), then the table registry. */
interface Names {
  locals?: ReadonlyMap<string, string>;
  registry?: ReadonlyMap<string, string> | undefined;
  mainModule?: string | undefined;
}

interface Term { neg: boolean; text: string }

/** Splits `name+8-0x10`, `"My Game.exe"+10` or `$process+10` into signed terms (quoted names are one term). */
function exprTerms(expr: string): Term[] | null {
  const out: Term[] = [];
  let rest = expr.trim();
  let neg = false;
  if (!rest) return null;
  for (;;) {
    rest = rest.trimStart();
    let text: string;
    if (rest.startsWith('"')) {
      const close = rest.indexOf('"', 1);
      if (close < 0) return null;
      text = rest.slice(0, close + 1);
    } else {
      const m = /^[^+-]+/.exec(rest);
      if (!m) return null;
      text = m[0].trim();
    }
    if (!text) return null;
    out.push({ neg, text });
    rest = rest.slice(rest.indexOf(text) + text.length).trimStart();
    if (!rest) return out;
    if (rest[0] !== '+' && rest[0] !== '-') return null;
    neg = rest[0] === '-';
    rest = rest.slice(1);
  }
}

const NUMBER = /^(?:0x)?[0-9a-fA-F]+$/;
const NAME = /^(?:"[^"]+"|\$?[A-Za-z_][\w.]*)$/;

/**
 * Evaluates an address expression: one leading name (or number) plus any number of `±hex` terms.
 * `name` resolves to an address through `lookup`; numbers are hex (`0x` optional).
 */
async function evalExpr(expr: string, lookup: (name: string) => Promise<bigint>): Promise<bigint> {
  const terms = exprTerms(expr);
  if (!terms) throw new EngineError(`can't read the address ${expr}`);
  let total = 0n;
  terms.forEach((t, i) => { if (i > 0 && !NUMBER.test(t.text)) throw new EngineError(`can't read the address ${expr}`); });
  for (const [i, t] of terms.entries()) {
    let v: bigint;
    if (i === 0 && !t.neg && NAME.test(t.text) && !(/^0x/i.test(t.text))) v = await lookup(t.text);
    else if (NUMBER.test(t.text)) v = BigInt('0x' + t.text.replace(/^0x/i, ''));
    else throw new EngineError(`can't read the address ${expr}`);
    total += t.neg ? -v : v;
  }
  return total;
}

/**
 * Resolves `name(±hex)*`, `"module"±hex`, `module±hex`, `$process±hex` or `0x…` in a live game:
 * the name goes through the AA locals, then the table registry, then the loaded modules
 * (all case-insensitive, R16). An unknown plain name is `symbol <name> isn't registered`.
 */
async function resolveExpr(s: Session, expr: string, names: Names): Promise<string> {
  const v = await evalExpr(expr, async (raw) => {
    const quoted = raw.startsWith('"');
    const name = quoted ? raw.slice(1, -1) : raw;
    if (!quoted) {
      const k = lower(name);
      const local = names.locals?.get(k) ?? names.registry?.get(k);
      if (local !== undefined) return BigInt(local);
      if (k === '$process') {
        if (!names.mainModule) throw new EngineError("$process needs the game's main module");
        return moduleBase(s, names.mainModule);
      }
    }
    try {
      return await moduleBase(s, name);
    } catch (err) {
      // A plain identifier that is neither a symbol nor a loaded module is a table symbol nobody registered.
      const plain = !quoted && /^[A-Za-z_]\w*$/.test(name);
      if (plain && err instanceof EngineError && err.code === RpcCode.ModuleNotFound) {
        if (NUMBER.test(name)) return BigInt('0x' + name);
        throw new UnregisteredSymbolError(name);
      }
      throw err;
    }
  });
  return hex(v);
}

/** AA's `$process` is the game's main module. */
function mapModule(module: string, mainModule: string | undefined): string {
  if (lower(module) !== '$process') return module;
  if (!mainModule) throw new EngineError("$process needs the game's main module");
  return mainModule;
}

/**
 * Resolves a cheat address. An AOB address uses the first match plus `offset`. A `symbol` address
 * reads its `expr` through the table registry (then the modules), then walks its `offsets` like a
 * pointer chain.
 */
export async function resolveCheatAddress(
  s: Session,
  a: StarlightAddress,
  o: { symbols?: SymbolRegistry; mainModule?: string } = {},
): Promise<string> {
  switch (a.kind) {
    case 'symbol': {
      const base = await resolveExpr(s, a.expr, { registry: o.symbols, mainModule: o.mainModule });
      if (!a.offsets || a.offsets.length === 0) return base;
      return resolvePointerChain(s, { baseAddress: base, offsets: a.offsets.map(wireOffset) });
    }
    case 'absolute':
      return a.address;
    case 'module':
      return hex((await moduleBase(s, mapModule(a.module, o.mainModule))) + signedHex(a.offset));
    case 'pointer': {
      const module = a.module !== undefined ? mapModule(a.module, o.mainModule) : undefined;
      return resolvePointerChain(s, {
        baseAddress: a.baseOffset,
        offsets: a.offsets.map(wireOffset),
        ...(module !== undefined ? { module } : {}),
      }).catch((err) => {
        if (err instanceof EngineError && err.code === RpcCode.ModuleNotFound && module) throw moduleNotFound(module);
        throw err;
      });
    }
    case 'aob': {
      const module = mapModule(a.module, o.mainModule);
      const matches = await aobScan(s, { module, pattern: a.pattern });
      if (matches.length === 0) throw new ScanError(`the AOB pattern isn't in ${module} any more`);
      return addOffset(matches[0]!, a.offset);
    }
  }
}

const spaced = (b: Buffer) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

function matchesPattern(actual: Buffer, pattern: string): boolean {
  const toks = pattern.trim().split(/\s+/);
  if (toks.length !== actual.length) return false;
  return toks.every((t, i) => t === '??' || t === '?' || parseInt(t, 16) === actual[i]);
}

const patternLength = (pattern: string) => pattern.trim().split(/\s+/).length;
const samePattern = (a: string, b: string) => a.trim().split(/\s+/).join(' ').toLowerCase() === b.trim().split(/\s+/).join(' ').toLowerCase();

function isUnsupported(c: StarlightCheat): boolean {
  return 'unsupported' in c && c.unsupported === true;
}

/**
 * Checks a cheat against the live game. A cheat with no `verify` block (or an unsupported one) is
 * `unverified`; with one, the AOB must match exactly once and every check in the block must pass.
 * A patch without a `site` only gets the checks that name their address.
 */
export async function verifyCheat(
  s: Session,
  cheat: StarlightCheat,
  o: { symbols?: SymbolRegistry; mainModule?: string } = {},
): Promise<VerifyResult> {
  if (isUnsupported(cheat)) return { status: 'unverified', reasons: [] };
  const c = cheat as StarlightValueCheat | StarlightPatchCheat;
  const verify: StarlightVerify | undefined = c.verify;
  if (!verify) return { status: 'unverified', reasons: [] };
  const patchCheat = c.type === 'patch';
  const a: StarlightAddress | undefined = patchCheat ? (c as StarlightPatchCheat).site : (c as StarlightValueCheat).address;
  const reasons: string[] = [];

  let address: string | null = null;
  if (a) {
    try {
      if (a.kind === 'aob') {
        const module = mapModule(a.module, o.mainModule);
        const matches = await aobScan(s, { module, pattern: a.pattern });
        if (matches.length === 0) reasons.push(`the AOB pattern isn't in ${module} any more`);
        else if (matches.length > 1) reasons.push(`the AOB pattern matches ${matches.length} places in ${module}; it must match exactly one`);
        else address = addOffset(matches[0]!, a.offset);
      } else {
        address = await resolveCheatAddress(s, a, o);
      }
    } catch (err) {
      if (err instanceof EngineError && err.code === RpcCode.ModuleNotFound) {
        reasons.push(a.kind === 'aob' || a.kind === 'module' || a.kind === 'pointer' ? `${mapModule((a as { module?: string }).module ?? 'the module', o.mainModule)} isn't loaded` : String(err.message));
      } else if (err instanceof EngineError && err.code === RpcCode.ReadFailed) {
        reasons.push(`can't read the value at ${describeAddress(a)}`);
      } else if (err instanceof UnregisteredSymbolError) {
        reasons.push(err.message);
      } else throw err;
    }
  }

  if (address !== null || (patchCheat && !a)) {
    const locals = new Map<string, string>(address !== null ? [['site', address]] : []);
    const names: Names = { locals, registry: o.symbols, mainModule: o.mainModule };
    const unreadable = (at: string) => reasons.push(`can't read the value at ${at}`);

    if (c.type !== 'patch' && address !== null) {
      const v = c as StarlightValueCheat;
      if (v.valueType !== 'string') {
        let value: number | null = null;
        try { value = Number(await read(s, address, v.valueType as Exclude<ValueType, 'string'>)); } catch (err) {
          if (!(err instanceof EngineError)) throw err;
          unreadable(address);
        }
        const r = verify.range;
        if (value !== null && r && (value < r.min || value > r.max)) {
          reasons.push(`the value is ${value}, outside ${r.min}–${r.max}`);
        }
      }
    }

    for (const b of verify.bytes ?? []) {
      const at = b.at ?? 'site';
      let where: string;
      try { where = await resolveExpr(s, at, names); } catch (err) {
        if (err instanceof UnregisteredSymbolError) { reasons.push(`can't check the bytes at ${at}: ${err.message}`); continue; }
        throw err;
      }
      const got = (await readMany(s, [{ address: where, length: patternLength(b.expect) }]))[0];
      if (!got) unreadable(where);
      else if (!matchesPattern(got, b.expect)) reasons.push(`the bytes at ${at} are ${spaced(got)}, expected ${b.expect}`);
    }

    if (patchCheat) {
      for (const step of (c as StarlightPatchCheat).enable) {
        if (step.op !== 'writeBytes' || !step.original) continue;
        let where: string;
        try { where = await resolveExpr(s, step.at, names); } catch (err) {
          if (err instanceof UnregisteredSymbolError) continue; // made by an earlier step
          throw err;
        }
        const original = step.original.toLowerCase();
        const got = (await readMany(s, [{ address: where, length: original.length / 2 }]))[0];
        if (!got) unreadable(where);
        else if (got.toString('hex') !== original) reasons.push(`the code at ${step.at} changed (now ${got.toString('hex')}, expected ${original})`);
      }
    }
  }

  return { status: reasons.length ? 'needs-update' : 'ok', reasons };
}

function describeAddress(a: StarlightAddress): string {
  switch (a.kind) {
    case 'absolute': return a.address;
    case 'module': return `${a.module}+${a.offset}`;
    case 'pointer': return `${a.module ?? ''}+${a.baseOffset}`;
    case 'aob': return `${a.module} AOB`;
    case 'symbol': return a.expr;
  }
}

export interface RunningCheat {
  readonly kind: 'value' | 'patch';
  readonly address: string;
  /** Value cheats: replaces the freeze value. Patch cheats throw. */
  setValue(v: number): Promise<void>;
  /** Idempotent. */
  disable(): Promise<void>;
}

const isInt64 = (t: string) => t === 'int64' || t === 'uint64';

/**
 * Verifies, then turns a value or patch cheat on. Throws NeedsUpdateError when the checks fail.
 * A patch that fails at any point has every earlier patch reverted (newest first), and the
 * registry entries it added removed, before the error is rethrown.
 */
export async function enableCheat(
  s: Session,
  cheat: StarlightValueCheat | StarlightPatchCheat,
  o: EnableOptions = {},
): Promise<RunningCheat> {
  if (cheat.type !== 'patch' && cheat.valueType === 'string') {
    throw new EngineError("string values can't be cheats yet");
  }

  const v = await verifyCheat(s, cheat, o);
  if (v.status === 'needs-update') throw new NeedsUpdateError(v.reasons);

  return cheat.type === 'patch' ? enablePatch(s, cheat, o) : enableValue(s, cheat, o);
}

async function enableValue(s: Session, cheat: StarlightValueCheat, o: EnableOptions): Promise<RunningCheat> {
  const address = await resolveCheatAddress(s, cheat.address, o);
  const type = cheat.valueType as Exclude<ValueType, 'string'>;
  const intervalMs = o.intervalMs ?? 50;
  const coerce = (raw: number | string): number | bigint => {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (Number.isNaN(n)) throw new EngineError("this cheat's value isn't a number");
    return isInt64(type) ? BigInt(Math.trunc(n)) : n;
  };
  const initial = coerce(o.value ?? cheat.value ?? cheat.default ?? 0);

  let handle: FreezeHandle | null = await freeze(s, { address, type, value: initial, intervalMs });
  return {
    kind: 'value',
    address,
    async setValue(value) {
      if (!handle) throw new EngineError('this cheat is off');
      const next = coerce(value);
      await handle.cancel();
      handle = null;
      handle = await freeze(s, { address, type, value: next, intervalMs });
    },
    async disable() {
      const h = handle;
      handle = null;
      await h?.cancel();
    },
  };
}

// ---------------------------------------------------------------------------
// Compiled Auto Assembler (M4 D7/D8)

/** Every label a segment defines (`name:` at the start of a line), lowercased. */
export function definedLabels(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)) {
    const k = lower(m[1]!);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

const MAX_LAYOUT_PASSES = 4;

/** CE's `readmem(address,size)` line: the size is decimal unless written `$hex` or `0xhex`. */
const READMEM = /^[ \t]*readmem[ \t]*\((.+),[ \t]*(\$[0-9a-f]+|0x[0-9a-f]+|\d+)[ \t]*\)[ \t]*$/gim;
const MAX_READMEM = 4096;

/**
 * Replaces every `readmem(address,size)` line with a `db` of the `size` bytes `read` returns —
 * CE copies the game's bytes at assemble time, usually the original code a hook overwrites.
 */
export async function expandReadmem(source: string, read: (expr: string, size: number) => Promise<Buffer>): Promise<string> {
  const found = [...source.matchAll(READMEM)];
  if (found.length === 0) return source;
  let out = '';
  let last = 0;
  for (const m of found) {
    const t = m[2]!;
    const size = t.startsWith('$') ? parseInt(t.slice(1), 16) : t.toLowerCase().startsWith('0x') ? parseInt(t.slice(2), 16) : Number(t);
    if (!(size >= 1 && size <= MAX_READMEM)) throw new EngineError(`readmem size ${t} is out of range`);
    const bytes = await read(m[1]!.trim(), size);
    out += source.slice(last, m.index) + 'db ' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    last = m.index! + m[0].length;
  }
  return out + source.slice(last);
}

/** `steps` with readmem expanded in every assemble step (the same array when there is none). */
async function withReadmem(
  steps: readonly StarlightPatchStep[],
  read: (expr: string, size: number) => Promise<Buffer>,
): Promise<StarlightPatchStep[]> {
  if (!steps.some((st) => st.op === 'assemble' && /readmem/i.test(st.source))) return [...steps];
  return Promise.all(steps.map(async (st) => (st.op === 'assemble' ? { ...st, source: await expandReadmem(st.source, read) } : st)));
}

interface Layout {
  /** Every label at its final address. */
  labels: Map<string, string>;
  /** Assembled bytes and address per `assemble` step index. */
  code: Map<number, { at: string; bytes: Buffer }>;
}

/** Thrown out of `layout` with the index of the step that failed. */
class StepFailure extends Error {
  constructor(readonly step: number, readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}

const merge = (...maps: Array<ReadonlyMap<string, string> | undefined>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of maps) for (const [k, v] of m ?? []) out.set(k, v);
  return out;
};

/**
 * D7: lays out every `assemble` step. Labels any step defines start as placeholders at that
 * step's address, and every step is re-assembled with the current symbols until no label moves
 * (at most 4 passes). `names` are the symbols known before layout (lowercase keys).
 */
async function layout(
  steps: readonly StarlightPatchStep[],
  names: ReadonlyMap<string, string>,
  deps: {
    resolveAt(expr: string, names: ReadonlyMap<string, string>): Promise<string>;
    assemble(at: string, source: string, symbols: Record<string, string>): Promise<{ bytes: Buffer; labels: Record<string, string> }>;
  },
): Promise<Layout> {
  const asm = steps.flatMap((st, i) => (st.op === 'assemble' ? [{ i, st }] : []));
  let labels = new Map<string, string>();
  for (const { i, st } of asm) {
    let at: string;
    try { at = await deps.resolveAt(st.at, merge(names, labels)); } catch (err) { throw new StepFailure(i, err); }
    for (const l of definedLabels(st.source)) if (!labels.has(l)) labels.set(l, at);
  }
  for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass++) {
    const next = new Map(labels);
    const code = new Map<number, { at: string; bytes: Buffer }>();
    const known = merge(names, labels);
    const symbols = Object.fromEntries(known);
    for (const { i, st } of asm) {
      try {
        const at = await deps.resolveAt(st.at, known);
        const r = await deps.assemble(at, st.source, symbols);
        for (const [k, v] of Object.entries(r.labels)) next.set(lower(k), hex(BigInt(v)));
        code.set(i, { at, bytes: r.bytes });
      } catch (err) {
        throw new StepFailure(i, err);
      }
    }
    const settled = next.size === labels.size && [...next].every(([k, v]) => labels.get(k) === v);
    if (settled) return { labels, code };
    labels = next;
  }
  throw new StepFailure(asm[0]?.i ?? 0, new EngineError('labels did not settle'));
}

const unwrap = (err: unknown) => (err instanceof StepFailure ? err.error : err);

/** The first name of an address expression, lowercased (null for a number). */
function baseName(expr: string): string | null {
  const t = exprTerms(expr)?.[0];
  if (!t || (NUMBER.test(t.text) && !/^[A-Za-z_]/.test(t.text))) return null;
  return lower(t.text.replace(/^"|"$/g, ''));
}

async function enablePatch(s: Session, cheat: StarlightPatchCheat, o: EnableOptions): Promise<RunningCheat> {
  const registry = o.symbols;
  const locals = new Map<string, string>();
  const names = (extra?: ReadonlyMap<string, string>): Names => ({ locals: merge(locals, extra), registry, mainModule: o.mainModule });
  const applied: Array<{ revert(force?: boolean): Promise<void> }> = [];
  /** Registry entries this run changed, with what they were before (undefined = absent). */
  const exported: Array<{ key: string; prev: string | undefined }> = [];
  const exportSymbol = (name: string, at: string) => {
    const key = lower(name);
    locals.set(key, at);
    if (!registry) return;
    if (!exported.some((e) => e.key === key)) exported.push({ key, prev: registry.get(key) });
    registry.set(key, at);
  };

  const rollback = async () => {
    for (const p of applied.reverse()) {
      try { await p.revert(); } catch { /* best effort: the original error matters more */ }
    }
    for (const { key, prev } of exported.reverse()) {
      if (prev === undefined) registry!.delete(key); else registry!.set(key, prev);
    }
  };

  const readAt = async (expr: string, size: number, n: Names): Promise<Buffer> => {
    const at = await resolveExpr(s, expr, n);
    const got = (await readMany(s, [{ address: at, length: size }]))[0];
    if (!got || got.length !== size) throw new EngineError(`readmem: can't read ${size} bytes at ${expr}`);
    return got;
  };

  let site: string | undefined;
  let labels = new Map<string, string>();
  try {
    // Phase A: the site, aobScan, alloc, and registerSymbol steps that need no label.
    let siteMatch: { module: string; pattern: string; address: string } | undefined;
    if (cheat.site) {
      const module = mapModule(cheat.site.module, o.mainModule);
      const matches = await aobScan(s, { module, pattern: cheat.site.pattern });
      if (matches.length === 0) {
        const named = cheat.enable.find((st) => st.op === 'aobScan' && st.module !== undefined
          && lower(mapModule(st.module, o.mainModule)) === lower(module) && samePattern(st.pattern, cheat.site!.pattern));
        throw new ScanError(`AOB ${named && named.op === 'aobScan' ? named.name : 'site'} not found in ${module}`);
      }
      siteMatch = { module, pattern: cheat.site.pattern, address: matches[0]! };
      site = addOffset(matches[0]!, cheat.site.offset);
      locals.set('site', site);
    }
    const labelNames = new Set(cheat.enable.flatMap((st) => (st.op === 'assemble' ? definedLabels(st.source) : [])));
    const deferred: StarlightPatchStep[] = [];
    for (const step of cheat.enable) {
      switch (step.op) {
        case 'aobScan': {
          const module = step.module !== undefined ? mapModule(step.module, o.mainModule) : undefined;
          let match: string | undefined;
          if (siteMatch && module !== undefined && lower(module) === lower(siteMatch.module) && samePattern(step.pattern, siteMatch.pattern)) {
            match = siteMatch.address;
          } else {
            match = (await aobScan(s, { ...(module !== undefined ? { module } : {}), pattern: step.pattern }))[0];
          }
          if (match === undefined) throw new ScanError(`AOB ${step.name} not found in ${module ?? 'executable memory'}`);
          locals.set(lower(step.name), match);
          break;
        }
        case 'alloc': {
          const near = step.near !== undefined ? await resolveExpr(s, step.near, names()) : undefined;
          locals.set(lower(step.name), await alloc(s, { size: step.size, prot: 'rwx', ...(near !== undefined ? { near } : {}) }));
          break;
        }
        case 'registerSymbol': {
          const base = baseName(step.at);
          if (base !== null && labelNames.has(base) && !locals.has(base)) { deferred.push(step); break; }
          exportSymbol(step.name, await resolveExpr(s, step.at, names()));
          break;
        }
        case 'unregisterSymbol':
          deferred.push(step);
          break;
        case 'assert': {
          const at = await resolveExpr(s, step.at, names());
          const got = (await readMany(s, [{ address: at, length: patternLength(step.pattern) }]))[0];
          if (!got || !matchesPattern(got, step.pattern)) {
            throw new ScanError(`expected bytes not found at ${step.at} (the table is probably for another game version)`);
          }
          break;
        }
        case 'assemble':
        case 'writeBytes':
          break;
      }
    }

    // Phase B: lay out every assemble step, and find every write's address, before writing anything.
    // readmem copies the game's bytes as they are now, before any write.
    const steps = await withReadmem(cheat.enable, (expr, size) => readAt(expr, size, names()));
    const symbolsFor = (extra: ReadonlyMap<string, string>) => merge(registry, locals, extra);
    const lay = await layout(steps, merge(registry, locals), {
      resolveAt: (expr, known) => resolveExpr(s, expr, { locals: known, mainModule: o.mainModule }),
      assemble: (at, source, symbols) => assemble(s, { address: at, source, symbols }),
    }).catch((err) => { throw unwrap(err); });
    labels = lay.labels;
    const writes: Array<{ at: string; bytes: Buffer }> = [];
    for (const [i, step] of steps.entries()) {
      if (step.op === 'assemble') writes.push(lay.code.get(i)!);
      else if (step.op === 'writeBytes') {
        writes.push({ at: await resolveExpr(s, step.at, { locals: symbolsFor(labels), mainModule: o.mainModule }), bytes: Buffer.from(step.bytes, 'hex') });
      }
    }

    // Phase C: write in step order (the compiler puts the caves first and the jumps into them last).
    for (const w of writes) applied.push(await patch(s, w.at, w.bytes));

    // Phase D: symbols that name labels, and unregisterSymbol in step order.
    for (const step of deferred) {
      if (step.op === 'registerSymbol') exportSymbol(step.name, await resolveExpr(s, step.at, names(labels)));
      else if (step.op === 'unregisterSymbol') { locals.delete(lower(step.name)); registry?.delete(lower(step.name)); }
    }
  } catch (err) {
    await rollback();
    throw err;
  }

  const firstWrite = cheat.enable.find((st) => st.op === 'assemble' || st.op === 'writeBytes');
  const address = site ?? (firstWrite && 'at' in firstWrite ? await resolveExpr(s, firstWrite.at, names(labels)).catch(() => '0x0') : '0x0');
  let off = false;

  /** D8: the table's own restore bytes are only compared with the game's, never written. */
  const checkDisableSteps = async () => {
    const known = merge(registry, locals, labels);
    for (const step of cheat.disable ?? []) {
      if (step.op !== 'writeBytes' && step.op !== 'assemble') continue;
      let same = false;
      try {
        const at = await resolveExpr(s, step.at, { locals: known, mainModule: o.mainModule });
        const source = step.op === 'assemble'
          ? await expandReadmem(step.source, (expr, size) => readAt(expr, size, { locals: known, mainModule: o.mainModule }))
          : '';
        const bytes = step.op === 'writeBytes'
          ? Buffer.from(step.bytes, 'hex')
          : (await assemble(s, { address: at, source, symbols: Object.fromEntries(known) })).bytes;
        const got = bytes.length > 0 ? (await readMany(s, [{ address: at, length: bytes.length }]))[0] : Buffer.alloc(0);
        same = !!got && got.equals(bytes);
      } catch { /* can't check it: the original stays either way */ }
      if (!same) o.log?.(`disable bytes at ${step.at} differ from the game's original; kept the original`);
    }
  };
  const unregister = () => {
    for (const step of cheat.disable ?? []) {
      if (step.op !== 'unregisterSymbol') continue;
      locals.delete(lower(step.name));
      registry?.delete(lower(step.name));
    }
  };

  return {
    kind: 'patch',
    address,
    async setValue() { throw new EngineError("patch cheats don't have a value"); },
    async disable() {
      if (off) return;
      if (!s.attached || s.client.closed) { // the daemon reverts patches when the session ends
        applied.length = 0;
        unregister();
        off = true;
        return;
      }
      // Newest first. Patches that fail to revert stay in the list so a later disable() retries them.
      const stuck: typeof applied = [];
      const errors: string[] = [];
      for (const p of [...applied].reverse()) {
        try { await p.revert(); } catch (err) {
          stuck.push(p);
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      applied.length = 0;
      applied.push(...stuck.reverse());
      if (errors.length) {
        throw new EngineError(`${errors.length} patch${errors.length === 1 ? '' : 'es'} could not be reverted, the cheat is still on: ${errors.join('; ')}`);
      }
      off = true;
      await checkDisableSteps();
      unregister();
    },
  };
}

const ALLOC_PLACEHOLDER = 0x10000000n;
const NAME_PLACEHOLDER = 0x11000000n;
const MODULE_TOKEN = /"([^"]+)"|\b([A-Za-z_][\w.]*\.(?:exe|dll|so(?:\.[\w.]*)?))\b/gi;

/**
 * Assembles a compiled cheat without a game (the daemon's game-less `assemble`), to tell whether
 * every segment is in the assembler's subset. Allocations are placeholders at
 * `0x10000000 + i·0x10000`; aob names, `site`, `known` names (the table's registered symbols)
 * and module names at `0x11000000 + j·0x100000`; labels go through the same layout as a real run.
 * Every name is matched lowercased (R16). `step` is the failing step's index in `enable`, or
 * `enable.length + k` for the k-th `disable` step.
 */
export async function checkAssembles(
  c: EngineClient,
  cheat: StarlightPatchCheat,
  o: { known?: string[] } = {},
): Promise<{ ok: true } | { ok: false; step: number; message: string }> {
  const names = new Map<string, string>();
  cheat.enable.filter((st) => st.op === 'alloc').forEach((st, i) => {
    if (st.op === 'alloc') names.set(lower(st.name), hex(ALLOC_PLACEHOLDER + BigInt(i) * 0x10000n));
  });
  let j = 0;
  const place = (name: string): string => {
    const k = lower(name);
    let v = names.get(k);
    if (v === undefined) { v = hex(NAME_PLACEHOLDER + BigInt(j++) * 0x100000n); names.set(k, v); }
    return v;
  };
  if (cheat.site) { place('site'); place(cheat.site.module); }
  for (const st of cheat.enable) {
    if (st.op === 'aobScan') { place(st.name); if (st.module) place(st.module); }
  }
  for (const k of o.known ?? []) place(k);
  // No game to read from: readmem becomes that many placeholder bytes.
  const filler = async (_expr: string, size: number) => Buffer.alloc(size, 0x90);
  const enable = await withReadmem(cheat.enable, filler);
  const disable = await withReadmem(cheat.disable ?? [], filler);
  const steps = [...enable, ...disable];
  for (const st of steps) {
    if (st.op !== 'assemble') continue;
    for (const m of st.source.matchAll(MODULE_TOKEN)) place(m[1] ?? m[2]!);
  }
  for (const st of cheat.enable) if (st.op === 'registerSymbol') place(st.name);

  // Unknown names in addresses are modules here (the live run resolves them).
  const resolveAt = async (expr: string, known: ReadonlyMap<string, string>) =>
    hex(await evalExpr(expr, async (raw) => {
      const k = lower(raw.replace(/^"|"$/g, ''));
      return BigInt(known.get(k) ?? place(k));
    }));
  const asm = async (at: string, source: string, symbols: Record<string, string>) =>
    assemble(c, { address: at, source, symbols: { ...Object.fromEntries(names), ...symbols } });

  let labels: Map<string, string>;
  try {
    labels = (await layout(enable, names, { resolveAt, assemble: asm })).labels;
  } catch (err) {
    if (err instanceof StepFailure && !c.closed) return { ok: false, step: err.step, message: err.message };
    throw unwrap(err);
  }
  const known = merge(names, labels);
  for (const [k, st] of disable.entries()) {
    if (st.op !== 'assemble') continue;
    try {
      await asm(await resolveAt(st.at, known), st.source, Object.fromEntries(known));
    } catch (err) {
      if (c.closed) throw err;
      return { ok: false, step: cheat.enable.length + k, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true };
}
