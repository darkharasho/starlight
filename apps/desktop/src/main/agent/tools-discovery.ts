// apps/desktop/src/main/agent/tools-discovery.ts
//
// Read-only discovery tools: value scans, reading memory, pointer scans,
// disassembly and signatures. They never change the game.
import { z } from 'zod';
import {
  scanFirst, scanNext, scanResults, read, readMany, pointerScan, pointerResults, pointerRescan,
  disassemble, makeSignature, resolveAddressExpr,
} from '@starlight/engine';
import type { EngineApi } from './tools.js';
import type { Session, ValueType } from '@starlight/engine';
import { ToolError, hex, live, type AttachedContext, type ToolDef } from './tools.js';

const VALUE_TYPES = ['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'float', 'double', 'string'] as const;
const FIRST_MODES = ['exact', 'bigger', 'smaller', 'range', 'unknown'] as const;
const NEXT_MODES = ['exact', 'bigger', 'smaller', 'range', 'changed', 'unchanged', 'increased', 'decreased', 'increased_by', 'decreased_by'] as const;

/** Scan ids each engine session started (a scan id from anywhere else is refused). */
const scanIds = new WeakMap<Session, Set<number>>();

const addressDoc = 'An address expression: "0x7ff6a1b2c3d4", "<module>+<hex>" (e.g. "target+0x4010"), or a quoted module name ("\\"My Game.exe\\"+10").';

interface Pathish { module: string; base: string; offsets: string[]; text: string }

function toPath(p: { module?: string; baseAddress: string; offsets: string[] }): Pathish {
  const module = p.module ?? '';
  const base = p.baseAddress;
  return { module, base, offsets: p.offsets, text: `${module}+${base} → ${p.offsets.join(' → ')}` };
}

function parseMaxOffset(s: string | undefined): `0x${string}` | undefined {
  return s === undefined ? undefined : (s.toLowerCase() as `0x${string}`);
}

export function discoveryTools(engine: Partial<EngineApi> = {}): ToolDef<any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const eng = {
    scanFirst: engine.scanFirst ?? scanFirst,
    scanNext: engine.scanNext ?? scanNext,
    scanResults: engine.scanResults ?? scanResults,
    read: engine.read ?? read,
    readMany: engine.readMany ?? readMany,
    pointerScan: engine.pointerScan ?? pointerScan,
    pointerResults: engine.pointerResults ?? pointerResults,
    pointerRescan: engine.pointerRescan ?? pointerRescan,
    disassemble: engine.disassemble ?? disassemble,
    makeSignature: engine.makeSignature ?? makeSignature,
    resolveAddressExpr: engine.resolveAddressExpr ?? resolveAddressExpr,
  };

  const resolve = (a: AttachedContext, expr: string): Promise<string> => eng.resolveAddressExpr(a.session, expr);

  async function annotate(a: AttachedContext, rows: Array<{ address: string; value: string | null }>) {
    return Promise.all(rows.map(async (r) => {
      const address = hex(r.address);
      return { address, where: await a.describe(address), value: r.value };
    }));
  }

  function knownScan(a: AttachedContext, id: number): void {
    if (!scanIds.get(a.session)?.has(id)) throw new ToolError(`Unknown scan ${id}; start one with scan_first.`);
  }

  const scanFirstInput = {
    type: z.enum([...VALUE_TYPES, 'bytes']).describe('What the value is. "bytes" scans for a byte pattern.'),
    mode: z.enum(FIRST_MODES).describe('"unknown" snapshots memory so scan_next can narrow by change.'),
    value: z.string().optional().describe('The value to look for, as a string.'),
    min: z.string().optional().describe('Lower bound for mode "range".'),
    max: z.string().optional().describe('Upper bound for mode "range".'),
    encoding: z.enum(['utf-8', 'utf-16le']).optional().describe('For type "string".'),
  };
  const scanFirstTool: ToolDef<typeof scanFirstInput> = {
    name: 'scan_first',
    title: 'First scan',
    description:
      "Starts a value scan over the game's writable memory and returns a scan id and the match count. Results are included only when " +
      'there are 50 or fewer; otherwise narrow with scan_next or page with scan_results.',
    tier: 'attached', readOnly: true, input: scanFirstInput,
    async run(args, ctx) {
      const a = live(ctx);
      const r = await eng.scanFirst(a.session, {
        type: args.type, mode: args.mode,
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.min !== undefined ? { min: args.min } : {}),
        ...(args.max !== undefined ? { max: args.max } : {}),
        ...(args.encoding !== undefined ? { encoding: args.encoding } : {}),
      });
      let ids = scanIds.get(a.session);
      if (!ids) scanIds.set(a.session, (ids = new Set()));
      ids.add(r.scan);
      if (r.count > 50) return { scan: r.scan, count: r.count };
      const page = await eng.scanResults(a.session, r.scan, { limit: 50 });
      return { scan: r.scan, count: r.count, results: await annotate(a, page.results) };
    },
    summarize: (args, result) => {
      const r = result as { count: number };
      return `scan_first ${args.type} ${args.mode}${args.value ? ' ' + args.value : ''} → ${r.count.toLocaleString('en-US')} matches`;
    },
  };

  const scanNextInput = {
    scan: z.number().int().describe('The scan id from scan_first.'),
    mode: z.enum(NEXT_MODES),
    value: z.string().optional(),
    min: z.string().optional(),
    max: z.string().optional(),
  };
  const scanNextTool: ToolDef<typeof scanNextInput> = {
    name: 'scan_next',
    title: 'Next scan',
    description: 'Narrows an earlier scan after the value changed in the game. Results are included only when 50 or fewer remain.',
    tier: 'attached', readOnly: true, input: scanNextInput,
    async run(args, ctx) {
      const a = live(ctx);
      knownScan(a, args.scan);
      const r = await eng.scanNext(a.session, args.scan, {
        mode: args.mode,
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.min !== undefined ? { min: args.min } : {}),
        ...(args.max !== undefined ? { max: args.max } : {}),
      });
      if (r.count > 50) return { count: r.count };
      const page = await eng.scanResults(a.session, args.scan, { limit: 50 });
      return { count: r.count, results: await annotate(a, page.results) };
    },
    summarize: (args, result) => `scan_next ${args.mode}${args.value ? ' ' + args.value : ''} → ${(result as { count: number }).count} matches`,
  };

  const scanResultsInput = {
    scan: z.number().int(),
    offset: z.number().int().min(0).optional().describe('Default 0.'),
    limit: z.number().int().min(1).max(500).optional().describe('Default 50, at most 500.'),
  };
  const scanResultsTool: ToolDef<typeof scanResultsInput> = {
    name: 'scan_results',
    title: 'Scan results',
    description: "A page of a scan's candidates with their current values and module+offset.",
    tier: 'attached', readOnly: true, input: scanResultsInput,
    async run(args, ctx) {
      const a = live(ctx);
      knownScan(a, args.scan);
      const page = await eng.scanResults(a.session, args.scan, { offset: args.offset ?? 0, limit: args.limit ?? 50 });
      return { count: page.count, results: await annotate(a, page.results) };
    },
    summarize: (args, result) => `scan_results ${args.scan} → ${(result as { results: unknown[] }).results.length} shown`,
  };

  const readInput = {
    address: z.string().min(1).describe(addressDoc),
    type: z.enum([...VALUE_TYPES, 'bytes']),
    length: z.number().int().min(1).max(4096).optional().describe('Required for "bytes" (the byte count) and "string" (the maximum length).'),
    encoding: z.enum(['utf-8', 'utf-16le']).optional().describe('For "string"; default utf-8.'),
  };
  const readTool: ToolDef<typeof readInput> = {
    name: 'read',
    title: 'Read memory',
    description: 'Reads one value (or bytes, as hex) from the game.',
    tier: 'attached', readOnly: true, input: readInput,
    async run(args, ctx) {
      const a = live(ctx);
      if ((args.type === 'bytes' || args.type === 'string') && args.length === undefined) {
        throw new ToolError(`length is required for type ${args.type}.`);
      }
      const address = hex(await resolve(a, args.address));
      const where = await a.describe(address);
      let value: string;
      if (args.type === 'bytes') {
        const [buf] = await eng.readMany(a.session, [{ address, length: args.length! }]);
        if (!buf) throw new ToolError(`can't read ${args.length} bytes at ${address}`);
        value = buf.toString('hex');
      } else if (args.type === 'string') {
        value = String(await eng.read(a.session, address, { type: 'string', encoding: args.encoding ?? 'utf-8', maxLength: args.length! }));
      } else {
        value = String(await eng.read(a.session, address, args.type as ValueType));
      }
      return { address, where, value };
    },
    summarize: (args, result) => {
      const r = result as { address: string; where: string | null; value: string };
      return `read ${r.where ?? r.address} = ${r.value}`;
    },
  };

  const pointerScanInput = {
    address: z.string().min(1).describe(addressDoc),
    max_depth: z.number().int().min(1).max(7).optional().describe('Default 5.'),
    max_offset: z.string().regex(/^0x[0-9a-f]+$/i).refine((s) => parseInt(s, 16) <= 0x10000, 'at most 0x10000').optional().describe('Hex, at most "0x10000"; default "0x1000".'),
    modules: z.array(z.string()).optional().describe('Only paths that start in these modules.'),
  };
  const pointerScanTool: ToolDef<typeof pointerScanInput> = {
    name: 'pointer_scan',
    title: 'Pointer scan',
    description: 'Finds stable pointer paths (module + offsets) to an address. Returns the id and the first 20 paths; page the rest with pointer_results.',
    tier: 'attached', readOnly: true, input: pointerScanInput,
    async run(args, ctx) {
      const a = live(ctx);
      const address = hex(await resolve(a, args.address));
      const maxOffset = parseMaxOffset(args.max_offset);
      const r = await eng.pointerScan(a.session, {
        address,
        ...(args.max_depth !== undefined ? { maxDepth: args.max_depth } : {}),
        ...(maxOffset !== undefined ? { maxOffset } : {}),
        ...(args.modules !== undefined ? { modules: args.modules } : {}),
      });
      a.track.pointerScan(a.gen, r.id);
      const page = await eng.pointerResults(a.session, r.id, { limit: 20 });
      return { id: r.id, count: r.count, truncated: r.truncated, paths: page.paths.map(toPath) };
    },
    summarize: (args, result) => `pointer_scan ${args.address} → ${(result as { count: number }).count} paths`,
  };

  const pointerResultsInput = {
    id: z.number().int(),
    offset: z.number().int().min(0).optional().describe('Default 0.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50, at most 200.'),
  };
  const pointerResultsTool: ToolDef<typeof pointerResultsInput> = {
    name: 'pointer_results',
    title: 'Pointer scan results',
    description: 'A page of the paths a pointer scan found.',
    tier: 'attached', readOnly: true, input: pointerResultsInput,
    async run(args, ctx) {
      const a = live(ctx);
      const page = await eng.pointerResults(a.session, args.id, { offset: args.offset ?? 0, limit: args.limit ?? 50 });
      return { count: page.count, paths: page.paths.map(toPath) };
    },
    summarize: (args, result) => `pointer_results ${args.id} → ${(result as { paths: unknown[] }).paths.length} shown`,
  };

  const pointerRescanInput = {
    id: z.number().int(),
    address: z.string().min(1).optional().describe(`The new target address (for example after the game restarted). ${addressDoc}`),
  };
  const pointerRescanTool: ToolDef<typeof pointerRescanInput> = {
    name: 'pointer_rescan',
    title: 'Pointer rescan',
    description: 'Re-checks a pointer scan\'s paths against the running game and keeps the ones that still reach the target. Returns the first 20.',
    tier: 'attached', readOnly: true, input: pointerRescanInput,
    async run(args, ctx) {
      const a = live(ctx);
      const address = args.address !== undefined ? hex(await resolve(a, args.address)) : undefined;
      const r = await eng.pointerRescan(a.session, args.id, address);
      const page = await eng.pointerResults(a.session, args.id, { limit: 20 });
      return { count: r.count, paths: page.paths.map(toPath) };
    },
    summarize: (args, result) => `pointer_rescan ${args.id} → ${(result as { count: number }).count} paths`,
  };

  const disassembleInput = {
    address: z.string().min(1).describe(addressDoc),
    count: z.number().int().min(1).max(100).optional().describe('Default 20, at most 100.'),
  };
  const disassembleTool: ToolDef<typeof disassembleInput> = {
    name: 'disassemble',
    title: 'Disassemble',
    description: 'Disassembles instructions starting at an address.',
    tier: 'attached', readOnly: true, input: disassembleInput,
    async run(args, ctx) {
      const a = live(ctx);
      const address = hex(await resolve(a, args.address));
      const list = await eng.disassemble(a.session, address, args.count ?? 20);
      const instructions = await Promise.all(list.map(async (i) => {
        const addr = hex(i.address);
        const out: { address: string; where: string | null; bytes: string; text: string; target?: { address: string; where: string | null } } = {
          address: addr, where: await a.describe(addr), bytes: i.bytes, text: i.text,
        };
        if (i.target) {
          const t = hex(i.target.address);
          out.target = { address: t, where: await a.describe(t) };
        }
        return out;
      }));
      return { instructions };
    },
    summarize: (args, result) => `disassemble ${args.address} → ${(result as { instructions: unknown[] }).instructions.length} instructions`,
  };

  const makeSignatureInput = {
    address: z.string().min(1).describe(addressDoc),
    max_length: z.number().int().min(8).max(128).optional().describe('Default 64.'),
  };
  const makeSignatureTool: ToolDef<typeof makeSignatureInput> = {
    name: 'make_signature',
    title: 'Make signature',
    description: 'Builds a byte pattern (with ?? wildcards) for the code at an address. `aob` can be used directly as a cheat address.',
    tier: 'attached', readOnly: true, input: makeSignatureInput,
    async run(args, ctx) {
      const a = live(ctx);
      const address = hex(await resolve(a, args.address));
      const r = await eng.makeSignature(a.session, address, args.max_length ?? 64);
      return { ...r, aob: { kind: 'aob', module: r.module, pattern: r.pattern } };
    },
    summarize: (args, result) => {
      const r = result as { unique: boolean; matches: number };
      return `make_signature ${args.address} → ${r.unique ? 'unique' : r.matches + ' matches'}`;
    },
  };

  return [
    scanFirstTool, scanNextTool, scanResultsTool, readTool,
    pointerScanTool, pointerResultsTool, pointerRescanTool, disassembleTool, makeSignatureTool,
  ];
}

