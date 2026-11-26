/**
 * Decides where a Cheat Engine table runs: on starlightd when every record
 * compiles and every script assembles (plan D13/D14), otherwise the whole table
 * goes to Cheat Engine with the reason codes (D12). Every route is logged and
 * counted once per table in `<userData>/ct-routing.json` (D20).
 */
import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { compileTable, reasonCopy, REASON_CODES, type CompiledTable } from '@starlight/ct-importer';
import { checkAssembles, type EngineClient } from '@starlight/engine';
import type { RouteSummary } from '../shared/ipc.js';

export interface RouteDecision {
  engine: 'native' | 'ce';
  compiled: CompiledTable | null;
  /** Reason code -> number of records (or 1 for a table-level code). */
  codes: Record<string, number>;
  first: { recordId: number | null; name: string; code: string; detail: string } | null;
  /** Records in the table (script-less headers aren't counted). */
  records: number;
  sha256: string;
  /** The bitness scripts were checked at: the game's, or 64 while it isn't known. */
  bits: 32 | 64;
}

export interface RouteDeps {
  getClient(): Promise<EngineClient>;
  /** `preferences.nativeTables` (D22). */
  enabled: boolean;
  check?: typeof checkAssembles;
  /** The game's code bitness (null while unknown); scripts are checked at it. */
  codeBits?: () => Promise<32 | 64 | null>;
  log?(line: string): void;
  /** `<cacheKey>#<tableId>`. */
  label: string;
}

/**
 * Routes that weren't decided by the table itself: they carry no reason codes,
 * and aren't counted in ct-routing.json.
 */
export const ROUTE_OFF = 'route:off';
export const ROUTE_NO_ENGINE = 'route:engine-unavailable';
export const ROUTE_CE_RUNNING = 'route:ce-running';

const ROUTE_COPY: Record<string, string> = {
  [ROUTE_OFF]: "Running tables on Starlight's engine is turned off in Settings.",
  [ROUTE_NO_ENGINE]: "Starlight's engine couldn't be reached to check this table.",
  [ROUTE_CE_RUNNING]: 'Cheat Engine was already running for an earlier table.',
};

const KNOWN_CODES = new Set<string>(REASON_CODES);

/** Records the way the coverage script counts them: script-less headers are not records. */
function countRecords(t: CompiledTable): number {
  return t.records.filter((r) => !(r.kind === 'header' && r.script === null)).length;
}

/** The D20 log line. */
function logLine(label: string, d: RouteDecision & { known?: boolean }): string {
  if (d.engine === 'native') return `[ct-runner] ${label}: native (${d.known ? `${d.bits}-bit, ` : ''}${d.records} records)`;
  const parts = Object.entries(d.codes)
    .map(([code, n], i) => ({ code, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(({ code, n }) => `${code} ×${n}`);
  return `[ct-runner] ${label}: ce (${parts.length > 0 ? parts.join(', ') : d.first?.detail ?? 'unknown'})`;
}

/** A route to Cheat Engine for a reason outside the table. */
export function outsideRoute(code: string, detail: string, base: { compiled: CompiledTable | null; records: number; sha256: string }): RouteDecision {
  return { engine: 'ce', compiled: base.compiled, codes: {}, first: { recordId: null, name: '', code, detail }, records: base.records, sha256: base.sha256, bits: 64 };
}

/** The log line for a candidate Cheat Engine runs because it is already running (D17). */
export function ceRunningLine(label: string): string {
  return `[ct-runner] ${label}: ce (cheat engine already running)`;
}

/**
 * Assembles every script record of `compiled` as `bits`-bit code (placeholder addresses).
 * Returns the records that fail; throws when the engine can't be asked.
 */
export async function checkAllAssemble(
  client: EngineClient,
  compiled: CompiledTable,
  bits: 32 | 64 | undefined,
  check: typeof checkAssembles = checkAssembles,
): Promise<Array<{ recordId: number; name: string; message: string }>> {
  const known = Object.keys(compiled.registeredBy);
  const failures: Array<{ recordId: number; name: string; message: string }> = [];
  for (const r of compiled.records) {
    if ((r.kind !== 'script' && r.kind !== 'header') || !r.script?.cheat) continue;
    const res = await check(client, r.script.cheat, bits === undefined ? { known } : { known, bits });
    if (!res.ok) failures.push({ recordId: r.id, name: r.name, message: res.message });
  }
  return failures;
}

export async function routeTable(ctPath: string, deps: RouteDeps): Promise<RouteDecision> {
  const bytes = await readFile(ctPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const log = deps.log ?? ((line: string) => console.log(line));
  let knownBits = false;
  const done = (d: RouteDecision): RouteDecision => { log(logLine(deps.label, { ...d, known: knownBits })); return d; };

  if (!deps.enabled) {
    const records = (() => { try { return countRecords(compileTable(bytes.toString('utf8'))); } catch { return 0; } })();
    return done(outsideRoute(ROUTE_OFF, 'turned off in Settings', { compiled: null, records, sha256 }));
  }

  const compiled = compileTable(bytes.toString('utf8'));
  const records = countRecords(compiled);
  if (!compiled.native) {
    const codes: Record<string, number> = {};
    for (const r of compiled.reasons) codes[r.code] = (codes[r.code] ?? 0) + 1;
    const f = compiled.reasons[0] ?? null;
    return done({
      engine: 'ce', compiled, codes, records, sha256, bits: 64,
      first: f ? { recordId: f.recordId, name: f.name, code: f.code, detail: f.detail } : null,
    });
  }

  // Every script must assemble (with placeholder addresses) before the table
  // can run natively; the daemon has to be up for that, and to run it at all.
  const unavailable = () => done(outsideRoute(ROUTE_NO_ENGINE, 'engine unavailable', { compiled, records, sha256 }));
  let client: EngineClient;
  try { client = await deps.getClient(); } catch { return unavailable(); }
  // Scripts are checked at the game's bitness; unknown (or no game) is 64.
  const gameBits = deps.codeBits ? await deps.codeBits().catch(() => null) : null;
  knownBits = gameBits !== null;
  const bits: 32 | 64 = gameBits ?? 64;
  let failures: Awaited<ReturnType<typeof checkAllAssemble>>;
  try {
    failures = await checkAllAssemble(client, compiled, deps.codeBits ? bits : undefined, deps.check ?? checkAssembles);
  } catch { return unavailable(); }
  if (failures.length > 0) {
    const f = failures[0]!;
    return done({
      engine: 'ce', compiled, codes: { 'asm:error': failures.length }, records, sha256, bits,
      first: { recordId: f.recordId, name: f.name, code: 'asm:error', detail: f.message },
    });
  }
  return done({ engine: 'native', compiled, codes: {}, first: null, records, sha256, bits });
}

/** What the renderer is told about a route (the first reason with its player copy). */
export function routeSummary(d: RouteDecision | null): RouteSummary | null {
  if (!d) return null;
  return {
    engine: d.engine,
    codes: { ...d.codes },
    first: d.first ? { ...d.first, copy: ROUTE_COPY[d.first.code] ?? reasonCopy(d.first.code) } : null,
  };
}

interface RoutingFile {
  version: 1;
  tables: { native: number; ce: number };
  records: { native: number; ce: number };
  /** Code -> number of tables it appeared in. */
  reasons: Record<string, number>;
  /** Table sha256s already counted, oldest first. */
  seen: string[];
}

const SEEN_MAX = 2000;

function emptyCounts(): RoutingFile {
  return { version: 1, tables: { native: 0, ce: 0 }, records: { native: 0, ce: 0 }, reasons: {}, seen: [] };
}

async function readCounts(file: string): Promise<RoutingFile> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as Partial<RoutingFile>;
    if (j.version !== 1) return emptyCounts();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      version: 1,
      tables: { native: num(j.tables?.native), ce: num(j.tables?.ce) },
      records: { native: num(j.records?.native), ce: num(j.records?.ce) },
      reasons: Object.fromEntries(Object.entries(j.reasons ?? {}).filter(([k, v]) => KNOWN_CODES.has(k) && typeof v === 'number')),
      seen: Array.isArray(j.seen) ? j.seen.filter((s): s is string => typeof s === 'string') : [],
    };
  } catch {
    return emptyCounts();
  }
}

/** Writes run one after another, so concurrent sessions can't lose a count. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Counts a route once per table sha256. Routes decided outside the table
 * (turned off in Settings, engine unavailable) say nothing about the table and
 * aren't counted.
 */
export function recordRoute(file: string, d: RouteDecision): Promise<void> {
  const run = queue.then(async () => {
    if (d.first && d.first.code in ROUTE_COPY) return;
    const counts = await readCounts(file);
    if (counts.seen.includes(d.sha256)) return;
    counts.tables[d.engine] += 1;
    counts.records[d.engine] += d.records;
    for (const code of Object.keys(d.codes)) counts.reasons[code] = (counts.reasons[code] ?? 0) + 1;
    counts.seen.push(d.sha256);
    if (counts.seen.length > SEEN_MAX) counts.seen.splice(0, counts.seen.length - SEEN_MAX);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(counts, null, 2));
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  });
  queue = run.catch(() => {});
  return run;
}
