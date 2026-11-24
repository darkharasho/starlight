import { importCt, listCtRecords, parseCt, type CtRecord } from '@starlight/ct-importer';

export type Compiler = 'baseline' | 'native';

export interface TableCoverage {
  id: string;
  records: number;
  nativeRecords: number;
  native: boolean;
  /** Unsupported-reason code -> number of records. */
  codes: Record<string, number>;
  tableCodes: string[];
}

export interface BaselineRecord {
  id: number;
  native: boolean;
  code: string | null;
}

export interface CoverageReport {
  compiler: Compiler;
  generatedAt: string;
  tables: { total: number; native: number; pct: number };
  records: { total: number; native: number; pct: number };
  byCode: Array<{ code: string; tables: number; records: number }>;
  failed: number;
}

interface RawEntry {
  ID?: number;
  GroupHeader?: number;
  VariableType?: unknown;
  Address?: unknown;
  LuaScript?: unknown;
  AssemblerScript?: unknown;
  CheatEntries?: { CheatEntry?: RawEntry | RawEntry[] };
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

/** Raw entries in the same depth-first order as listCtRecords. */
function flattenEntries(xml: string): RawEntry[] {
  const out: RawEntry[] = [];
  const walk = (entries: RawEntry[]): void => {
    for (const e of entries) {
      out.push(e);
      walk(asArray(e.CheatEntries?.CheatEntry));
    }
  };
  walk(asArray(parseCt(xml).CheatTable.CheatEntries?.CheatEntry as RawEntry | RawEntry[] | undefined));
  return out;
}

function hasScript(e: RawEntry): boolean {
  return text(e.LuaScript).trim().length > 0 || text(e.AssemblerScript).trim().length > 0;
}

function codeFor(e: RawEntry): string {
  if (text(e.LuaScript).trim().length > 0) return 'lua:script';
  if (text(e.AssemblerScript).trim().length > 0) {
    return /\{\$lua\}/i.test(text(e.AssemblerScript)) ? 'lua:block' : 'aa:script';
  }
  if (!text(e.VariableType) || !text(e.Address)) return 'value:type';
  return 'addr:expression';
}

/** True when Lua source holds anything besides comments and whitespace. */
function hasLuaCode(src: string): boolean {
  const stripped = src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');
  return stripped.trim().length > 0;
}

export function baselineCompile(xml: string): { records: BaselineRecord[]; tableCodes: string[] } {
  const listed: CtRecord[] = listCtRecords(xml);
  const raw = flattenEntries(xml);

  // Which records importCt turns into value cheats (id `cheat-<ID>`, deduped with `-N`).
  const result = importCt(xml, { gameName: 'coverage', processName: [] });
  const nativeIds = new Set<string>();
  for (const cat of result.trainer.categories) {
    for (const c of cat.cheats) if (!('unsupported' in c && c.unsupported)) nativeIds.add(c.id);
  }
  const isNativeCheat = (id: string): boolean => nativeIds.has(id);

  const records: BaselineRecord[] = [];
  const seen = new Map<string, number>();
  listed.forEach((rec, i) => {
    const e = raw[i];
    if (!e) return;
    if (rec.isGroupHeader && !hasScript(e)) return;
    const raw0 = `cheat-${e.ID ?? 'anon'}`;
    const n = (seen.get(raw0) ?? 0) + 1;
    seen.set(raw0, n);
    const cheatId = n === 1 ? raw0 : `${raw0}-${n}`;
    const native = !rec.isGroupHeader && isNativeCheat(cheatId);
    records.push({ id: rec.id, native, code: native ? null : codeFor(e) });
  });
  const tableCodes: string[] = [];
  if (records.length === 0) tableCodes.push('table:empty');
  const tableLua = (parseCt(xml).CheatTable as { LuaScript?: unknown }).LuaScript;
  if (hasLuaCode(text(tableLua))) tableCodes.push('lua:table-script');
  return { records, tableCodes };
}

export function measureTable(id: string, xml: string, compiler: Compiler): TableCoverage {
  if (compiler === 'native') throw new Error('native compiler not built yet');
  const { records, tableCodes } = baselineCompile(xml);
  const codes: Record<string, number> = {};
  for (const r of records) if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
  const nativeRecords = records.filter((r) => r.native).length;
  return {
    id,
    records: records.length,
    nativeRecords,
    native: records.length > 0 && nativeRecords === records.length && tableCodes.length === 0,
    codes,
    tableCodes,
  };
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function summarize(rows: TableCoverage[], failed: number, compiler: Compiler): CoverageReport {
  const byCode = new Map<string, { tables: number; records: number }>();
  const bump = (code: string, records: number): void => {
    const cur = byCode.get(code) ?? { tables: 0, records: 0 };
    cur.tables += 1;
    cur.records += records;
    byCode.set(code, cur);
  };
  for (const r of rows) {
    for (const [code, n] of Object.entries(r.codes)) bump(code, n);
    for (const code of r.tableCodes) bump(code, 0);
  }
  const recTotal = rows.reduce((s, r) => s + r.records, 0);
  const recNative = rows.reduce((s, r) => s + r.nativeRecords, 0);
  const tabNative = rows.filter((r) => r.native).length;
  return {
    compiler,
    generatedAt: new Date().toISOString(),
    tables: { total: rows.length, native: tabNative, pct: pct(tabNative, rows.length) },
    records: { total: recTotal, native: recNative, pct: pct(recNative, recTotal) },
    byCode: [...byCode.entries()]
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => b.tables - a.tables || b.records - a.records || a.code.localeCompare(b.code)),
    failed,
  };
}
