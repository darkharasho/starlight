import type { StarlightAddress } from './starlight-format.js';

export type ParsedAddress = StarlightAddress;

const HEX_ONLY = /^[0-9a-fA-F]+$/;
const HEX_WITH_PREFIX = /^0x([0-9a-fA-F]+)$/i;

const QUOTED_MODULE = /^"([^"]+)"\s*\+\s*([0-9a-fA-F]+)$/;
const UNQUOTED_MODULE = /^([A-Za-z_][A-Za-z0-9_.]*\.(exe|dll))\s*\+\s*([0-9a-fA-F]+)$/i;

const AOBSCAN = /^aobscanmodule\s*\(\s*[^,]+\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s*\)(?:\s*\+\s*([0-9a-fA-F]+))?$/i;

function toHex(n: number | string): string {
  if (typeof n === 'number') return '0x' + n.toString(16);
  const stripped = n.toLowerCase().replace(/^0x/, '').replace(/^0+/, '') || '0';
  return '0x' + stripped;
}

export function parseAddress(addr: string, offsets?: number[]): ParsedAddress | null {
  const trimmed = addr.trim();

  let base:
    | { kind: 'absolute'; address: string }
    | { kind: 'module'; module: string; offset: string }
    | null = null;

  let aobMatch: { kind: 'aob'; module: string; pattern: string; offset?: string } | null = null;

  const m = AOBSCAN.exec(trimmed);
  if (m) {
    aobMatch = {
      kind: 'aob',
      module: m[1]!.trim(),
      pattern: m[2]!.trim(),
      ...(m[3] ? { offset: toHex(m[3]) } : {}),
    };
  } else if (QUOTED_MODULE.test(trimmed)) {
    const q = QUOTED_MODULE.exec(trimmed)!;
    base = { kind: 'module', module: q[1]!, offset: toHex(q[2]!) };
  } else if (UNQUOTED_MODULE.test(trimmed)) {
    const q = UNQUOTED_MODULE.exec(trimmed)!;
    base = { kind: 'module', module: q[1]!, offset: toHex(q[3]!) };
  } else if (HEX_WITH_PREFIX.test(trimmed)) {
    base = { kind: 'absolute', address: toHex(trimmed) };
  } else if (HEX_ONLY.test(trimmed)) {
    base = { kind: 'absolute', address: toHex(trimmed) };
  } else {
    return null; // unrecognised — caller should flag unsupported
  }

  if (aobMatch) {
    if (offsets && offsets.length > 0) {
      // We don't model AOB-with-pointer-chain in v1; flag as unsupported.
      return null;
    }
    return aobMatch;
  }

  if (!base) return null; // unreachable in practice but satisfies TS

  if (offsets && offsets.length > 0) {
    if (base.kind === 'module') {
      return {
        kind: 'pointer',
        module: base.module,
        baseOffset: base.offset,
        offsets: offsets.map(toHex),
      };
    }
    return {
      kind: 'pointer',
      baseOffset: base.address,
      offsets: offsets.map(toHex),
    };
  }

  return base;
}
