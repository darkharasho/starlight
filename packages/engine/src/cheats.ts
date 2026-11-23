import type {
  StarlightAddress, StarlightCheat, StarlightPatchCheat, StarlightValueCheat, StarlightVerify,
} from '@starlight/ct-importer';
import type { Session } from './session.js';
import type { ValueType, VerifyResult } from './types.js';
import { aobScan } from './aob-scan.js';
import { resolvePointerChain } from './pointer-chain.js';
import { read, readMany } from './memory.js';
import { freeze, type FreezeHandle } from './freeze.js';
import { assemble, alloc, patch } from './code.js';
import { EngineError, NeedsUpdateError, RpcCode, ScanError } from './errors.js';

const HEX = /^[0-9a-fA-F]+$/;

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

/** Resolves `0x…` or `module±offset` to an absolute address. A module that isn't loaded is a ScanError (ModuleNotFound). */
export async function resolveAddressExpr(s: Session, expr: string): Promise<string> {
  const p = parseAddressExpr(expr);
  if (!p) throw new EngineError(`can't read the address ${expr}`);
  if (p.module === null) return '0x' + p.offset.toString(16);
  let base: string;
  try {
    base = await resolvePointerChain(s, {
      module: p.module,
      baseAddress: '0x' + (p.offset < 0n ? 0n : p.offset).toString(16),
      offsets: [],
    });
  } catch (err) {
    if (err instanceof EngineError && err.code === RpcCode.ModuleNotFound) throw moduleNotFound(p.module);
    throw err;
  }
  return p.offset < 0n ? '0x' + (BigInt(base) + p.offset).toString(16) : base;
}

function addOffset(address: string, offset: string | undefined): string {
  if (!offset) return address;
  const neg = offset.startsWith('-');
  const digits = offset.replace(/^-/, '').replace(/^0x/i, '');
  const n = BigInt('0x' + digits);
  return '0x' + (BigInt(address) + (neg ? -n : n)).toString(16);
}

/** Resolves a cheat address. An AOB address uses the first match plus `offset`. */
export async function resolveCheatAddress(s: Session, a: StarlightAddress): Promise<string> {
  switch (a.kind) {
    case 'absolute':
      return a.address;
    case 'module':
      return resolveAddressExpr(s, `"${a.module}"+${a.offset.replace(/^0x/i, '')}`);
    case 'pointer':
      return resolvePointerChain(s, {
        baseAddress: a.baseOffset,
        offsets: a.offsets,
        ...(a.module !== undefined ? { module: a.module } : {}),
      }).catch((err) => {
        if (err instanceof EngineError && err.code === RpcCode.ModuleNotFound && a.module) throw moduleNotFound(a.module);
        throw err;
      });
    case 'aob': {
      const matches = await aobScan(s, { module: a.module, pattern: a.pattern });
      if (matches.length === 0) throw new ScanError(`the AOB pattern isn't in ${a.module} any more`);
      return addOffset(matches[0]!, a.offset);
    }
  }
}

type Symbols = Record<string, string>;

/** `name`, `name±hex` against the symbol table, else a plain address expression. */
async function resolveExpr(s: Session, expr: string, symbols: Symbols): Promise<string> {
  const e = expr.trim();
  const m = /^([A-Za-z_]\w*)(?:\s*([+-])\s*(?:0x)?([0-9a-fA-F]+))?$/.exec(e);
  if (m && Object.hasOwn(symbols, m[1]!)) {
    const base = BigInt(symbols[m[1]!]!);
    const off = m[3] ? BigInt('0x' + m[3]) : 0n;
    return '0x' + (m[2] === '-' ? base - off : base + off).toString(16);
  }
  if (parseAddressExpr(e)) {
    try { return await resolveAddressExpr(s, e); } catch (err) {
      // A bare identifier that is neither a symbol nor a loaded module is most likely a mistyped symbol.
      if (m && err instanceof EngineError && err.code === RpcCode.ModuleNotFound) throw new EngineError(`unknown symbol ${m[1]}`);
      throw err;
    }
  }
  if (m) throw new EngineError(`unknown symbol ${m[1]}`);
  throw new EngineError(`can't read the address ${expr}`);
}

const spaced = (b: Buffer) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

function matchesPattern(actual: Buffer, pattern: string): boolean {
  const toks = pattern.trim().split(/\s+/);
  if (toks.length !== actual.length) return false;
  return toks.every((t, i) => t === '??' || t === '?' || parseInt(t, 16) === actual[i]);
}

const patternLength = (pattern: string) => pattern.trim().split(/\s+/).length;

function isUnsupported(c: StarlightCheat): boolean {
  return 'unsupported' in c && c.unsupported === true;
}

/**
 * Checks a cheat against the live game. A cheat with no `verify` block (or an unsupported one) is
 * `unverified`; with one, the AOB must match exactly once and every check in the block must pass.
 */
export async function verifyCheat(s: Session, cheat: StarlightCheat): Promise<VerifyResult> {
  if (isUnsupported(cheat)) return { status: 'unverified', reasons: [] };
  const c = cheat as StarlightValueCheat | StarlightPatchCheat;
  const verify: StarlightVerify | undefined = c.verify;
  if (!verify) return { status: 'unverified', reasons: [] };
  const patchCheat = c.type === 'patch';
  const a: StarlightAddress = patchCheat ? (c as StarlightPatchCheat).site : (c as StarlightValueCheat).address;
  const reasons: string[] = [];

  let address: string | null = null;
  try {
    if (a.kind === 'aob') {
      const matches = await aobScan(s, { module: a.module, pattern: a.pattern });
      if (matches.length === 0) reasons.push(`the AOB pattern isn't in ${a.module} any more`);
      else if (matches.length > 1) reasons.push(`the AOB pattern matches ${matches.length} places in ${a.module}; it must match exactly one`);
      else address = addOffset(matches[0]!, a.offset);
    } else {
      address = await resolveCheatAddress(s, a);
    }
  } catch (err) {
    if (err instanceof EngineError && err.code === RpcCode.ModuleNotFound) {
      reasons.push(a.kind === 'aob' || a.kind === 'module' || a.kind === 'pointer' ? `${(a as { module?: string }).module ?? 'the module'} isn't loaded` : String(err.message));
    } else if (err instanceof EngineError && err.code === RpcCode.ReadFailed) {
      reasons.push(`can't read the value at ${describeAddress(a)}`);
    } else throw err;
  }

  if (address !== null) {
    const symbols: Symbols = { site: address };
    const unreadable = (at: string) => reasons.push(`can't read the value at ${at}`);

    if (c.type !== 'patch') {
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
      const where = await resolveExpr(s, at, symbols);
      const got = (await readMany(s, [{ address: where, length: patternLength(b.expect) }]))[0];
      if (!got) unreadable(where);
      else if (!matchesPattern(got, b.expect)) reasons.push(`the bytes at ${at} are ${spaced(got)}, expected ${b.expect}`);
    }

    if (patchCheat) {
      for (const step of (c as StarlightPatchCheat).enable) {
        if (step.op !== 'writeBytes' || !step.original) continue;
        let where: string;
        try { where = await resolveExpr(s, step.at, symbols); } catch (err) {
          if (err instanceof EngineError && /^unknown symbol/.test(err.message)) continue; // made by an earlier step
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
 * A patch that fails halfway has every earlier patch reverted (newest first) before the error is rethrown.
 */
export async function enableCheat(
  s: Session,
  cheat: StarlightValueCheat | StarlightPatchCheat,
  o: { value?: number; intervalMs?: number } = {},
): Promise<RunningCheat> {
  if (cheat.type === 'patch') {
    if (cheat.disable && cheat.disable.length > 0) {
      throw new EngineError('this cheat needs the native table runner (coming with .CT support)');
    }
  } else if (cheat.valueType === 'string') {
    throw new EngineError("string values can't be cheats yet");
  }

  const v = await verifyCheat(s, cheat);
  if (v.status === 'needs-update') throw new NeedsUpdateError(v.reasons);

  return cheat.type === 'patch' ? enablePatch(s, cheat) : enableValue(s, cheat, o);
}

async function enableValue(
  s: Session,
  cheat: StarlightValueCheat,
  o: { value?: number; intervalMs?: number },
): Promise<RunningCheat> {
  const address = await resolveCheatAddress(s, cheat.address);
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

async function enablePatch(s: Session, cheat: StarlightPatchCheat): Promise<RunningCheat> {
  const site = await resolveCheatAddress(s, cheat.site);
  const symbols: Symbols = { site };
  const applied: Array<{ revert(force?: boolean): Promise<void> }> = [];

  const rollback = async () => {
    for (const p of applied.reverse()) {
      try { await p.revert(); } catch { /* best effort: the original error matters more */ }
    }
  };

  try {
    for (const step of cheat.enable) {
      switch (step.op) {
        case 'alloc': {
          const near = step.near !== undefined ? await resolveExpr(s, step.near, symbols) : undefined;
          symbols[step.name] = await alloc(s, { size: step.size, prot: 'rwx', ...(near !== undefined ? { near } : {}) });
          break;
        }
        case 'registerSymbol':
          symbols[step.name] = await resolveExpr(s, step.at, symbols);
          break;
        case 'assemble': {
          const at = await resolveExpr(s, step.at, symbols);
          const r = await assemble(s, { address: at, source: step.source, symbols });
          Object.assign(symbols, r.labels);
          applied.push(await patch(s, at, r.bytes));
          break;
        }
        case 'writeBytes': {
          const at = await resolveExpr(s, step.at, symbols);
          applied.push(await patch(s, at, Buffer.from(step.bytes, 'hex')));
          break;
        }
      }
    }
  } catch (err) {
    await rollback();
    throw err;
  }

  return {
    kind: 'patch',
    address: site,
    async setValue() { throw new EngineError("patch cheats don't have a value"); },
    async disable() {
      if (applied.length === 0) return;
      if (!s.attached || s.client.closed) { applied.length = 0; return; } // the daemon reverts patches when the session ends
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
    },
  };
}
