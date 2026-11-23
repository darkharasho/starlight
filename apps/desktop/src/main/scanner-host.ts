import {
  attach as engineAttach, scanFirst, scanNext, scanResults, scanEnd, readMany, write, freeze, setSpeed as engineSetSpeed,
  type EngineClient, type Session, type FreezeHandle, type ValueType,
} from '@starlight/engine';
import { detectAntiCheat, antiCheatMessage } from './anti-cheat.js';

/**
 * The memory scanner panel's commands. They keep the reply shapes the Cheat
 * Engine bridge had (ce-control-script.ts), but run on starlightd. Scans read
 * through process_vm_readv, so they work alongside a Cheat Engine session on
 * the same game.
 */
export const SCANNER_METHODS: ReadonlySet<string> = new Set([
  'scan_first', 'scan_next', 'scan_status', 'scan_results', 'scan_reset',
  'mem_read', 'mem_write', 'freeze_set', 'freeze_clear', 'speed_set',
]);

export interface ScannerHost {
  call(pid: number, method: string, params: unknown): Promise<Record<string, unknown>>;
  /** Cancels freezes, ends the scan and detaches. */
  end(): Promise<void>;
}

type PanelType = 'i8' | 'i16' | 'i32' | 'i64' | 'f32' | 'f64';
const ENGINE_TYPE = {
  i8: 'int8', i16: 'int16', i32: 'int32', i64: 'int64', f32: 'float', f64: 'double',
} as const satisfies Record<PanelType, ValueType>;
const SIZE: Record<PanelType, number> = { i8: 1, i16: 2, i32: 4, i64: 8, f32: 4, f64: 8 };
const BITS: Record<PanelType, number> = { i8: 8, i16: 16, i32: 32, i64: 64, f32: 0, f64: 0 };

const FIRST_OPS = new Set(['exact', 'bigger', 'smaller', 'unknown']);
const NEXT_OPS = new Set(['exact', 'increased', 'decreased', 'changed', 'unchanged', 'bigger', 'smaller']);

const RESULT_CAP = 500;
const FREEZE_INTERVAL_MS = 100;

const isPanelType = (t: unknown): t is PanelType => typeof t === 'string' && t in ENGINE_TYPE;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A CE-format address (hex, uppercase, no prefix; `0x` tolerated) as a bigint, or null. */
function parseAddress(a: unknown): bigint | null {
  const s = typeof a === 'number' ? a.toString(16) : typeof a === 'string' ? a.trim().replace(/^0x/i, '') : '';
  return /^[0-9a-fA-F]{1,16}$/.test(s) ? BigInt('0x' + s) : null;
}
const wireAddress = (a: bigint): string => '0x' + a.toString(16);
const ceAddress = (a: string): string => a.replace(/^0x/i, '').toUpperCase();

/** Lua's tostring() of a float: `%.14g`, with `.0` added when it looks like an integer. */
function luaFloat(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n < 0 ? '-inf' : 'inf';
  let s: string;
  if (n === 0) {
    s = Object.is(n, -0) ? '-0' : '0';
  } else {
    const [mant, exp] = n.toExponential(13).split('e') as [string, string];
    const x = Number(exp);
    if (x < -4 || x >= 14) {
      const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
      s = `${m}e${x < 0 ? '-' : '+'}${String(Math.abs(x)).padStart(2, '0')}`;
    } else {
      s = n.toFixed(13 - x);
      if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
  }
  return /^[-0-9]+$/.test(s) ? s + '.0' : s;
}

/** A value read from game memory, written the way the Cheat Engine bridge's `tostring` did. */
function formatBytes(buf: Buffer, t: PanelType): string {
  switch (t) {
    case 'i8': return String(buf.readInt8(0));
    case 'i16': return String(buf.readInt16LE(0));
    case 'i32': return String(buf.readInt32LE(0));
    case 'i64': return String(buf.readBigInt64LE(0));
    case 'f32': return luaFloat(buf.readFloatLE(0));
    case 'f64': return luaFloat(buf.readDoubleLE(0));
  }
}

/** A value string from a scan result, in the same form `mem_read` gives, so the two never disagree. */
function formatScanValue(v: string | null, t: PanelType): string {
  if (v === null) return '';
  if (t === 'f32') { const n = Number(v); return Number.isNaN(n) && v.trim().toLowerCase() !== 'nan' ? v : luaFloat(Math.fround(n)); }
  if (t === 'f64') { const n = Number(v); return Number.isNaN(n) && v.trim().toLowerCase() !== 'nan' ? v : luaFloat(n); }
  return v;
}

/** Like Lua's tonumber, then coerced to what a write of this type takes. Null when it isn't a number. */
function toWritable(raw: unknown, t: PanelType): number | bigint | null {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  if (t === 'f32' || t === 'f64') {
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }
  let big: bigint;
  if (/^[-+]?\d+$/.test(s)) big = BigInt(s);
  else {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    big = BigInt(Math.floor(n));
  }
  const wrapped = BigInt.asIntN(BITS[t], big);
  return t === 'i64' ? wrapped : Number(wrapped);
}

interface ScanState {
  id: number | null;
  busy: boolean;
  started: boolean;
  count: number;
  valueType: PanelType;
  /** A background failure, handed to the next scan_status once. */
  pendingError: string | null;
}

const idleScan = (): ScanState => ({ id: null, busy: false, started: false, count: 0, valueType: 'i32', pendingError: null });

export function createScannerHost(deps: {
  getClient: () => Promise<EngineClient>;
  attach?: typeof engineAttach;
  setSpeed?: typeof engineSetSpeed;
  detectAntiCheatFn?: typeof detectAntiCheat;
}): ScannerHost {
  const attachFn = deps.attach ?? engineAttach;
  const setSpeedFn = deps.setSpeed ?? engineSetSpeed;
  const antiCheat = deps.detectAntiCheatFn ?? detectAntiCheat;

  let session: Session | null = null;
  let attaching: Promise<Session> | null = null;
  let pid: number | null = null;
  let scan = idleScan();
  /** Bumped by every teardown: work that began in an earlier epoch must clean up after itself. */
  let epoch = 0;
  /** Keyed by address (bigint as hex). */
  const freezes = new Map<string, { handle: FreezeHandle; type: PanelType }>();

  async function cancelFreezes(): Promise<void> {
    const all = [...freezes.values()];
    freezes.clear();
    await Promise.all(all.map((f) => f.handle.cancel().catch(() => undefined)));
  }

  async function teardown(): Promise<void> {
    const s = session;
    const old = scan;
    epoch++;
    session = null; attaching = null; pid = null; scan = idleScan();
    await cancelFreezes();
    if (s?.attached) {
      if (old.id !== null) await scanEnd(s, old.id).catch(() => undefined);
      await s.detach().catch(() => undefined);
    }
  }

  async function ensureSession(forPid: number): Promise<Session | { ok: false; error: string }> {
    if (session && !session.attached) await teardown();
    if (session) return session;
    const ep = epoch;
    attaching ??= (async () => {
      const hit = await antiCheat(forPid);
      if (hit) throw new Error(antiCheatMessage(hit));
      return attachFn(await deps.getClient(), forPid);
    })();
    const pending = attaching;
    try {
      const s = await pending;
      if (epoch !== ep) {
        // end() or a pid change came in while attaching: nobody owns this handle any more.
        await s.detach().catch(() => undefined);
        return { ok: false, error: 'session ended' };
      }
      if (attaching === pending) attaching = null;
      session ??= s;
      return session;
    } catch (err) {
      if (epoch === ep && attaching === pending) attaching = null;
      return { ok: false, error: errMsg(err) };
    }
  }

  const asObj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' ? p as Record<string, unknown> : {});

  async function scanFirstCall(forPid: number, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (scan.busy) return { ok: false, error: 'a scan is already running' };
    const type = p['valueType']; const op = p['op'];
    if (!isPanelType(type) || typeof op !== 'string' || !FIRST_OPS.has(op)) return { ok: false, error: 'unsupported scan' };
    const s = await ensureSession(forPid);
    if ('ok' in s) return s;
    if (scan.busy) return { ok: false, error: 'a scan is already running' };
    // Busy is set before anything yields, so a second scan_first or a scan_reset can't slip in.
    const old = scan;
    const mine: ScanState = { ...idleScan(), valueType: type, busy: true, started: true };
    scan = mine;
    const ep = epoch;
    const value = p['value'] === undefined || p['value'] === null ? undefined : String(p['value']);
    void (async () => {
      if (old.id !== null) await scanEnd(s, old.id).catch(() => undefined);
      return scanFirst(s, {
        type: ENGINE_TYPE[type], mode: op as 'exact' | 'bigger' | 'smaller' | 'unknown',
        ...(op !== 'unknown' && value !== undefined ? { value } : {}),
      });
    })().then((r) => {
      if (epoch !== ep) { void scanEnd(s, r.scan).catch(() => undefined); return; }
      mine.id = r.scan; mine.count = r.count;
    }, (err: unknown) => {
      mine.started = false; mine.pendingError = errMsg(err);
    }).finally(() => { mine.busy = false; });
    return { ok: true };
  }

  async function scanNextCall(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mine = scan;
    if (!mine.started || (mine.id === null && !mine.busy)) return { ok: false, error: 'start a new scan first' };
    if (mine.busy) return { ok: false, error: 'a scan is already running' };
    const op = p['op'];
    if (typeof op !== 'string' || !NEXT_OPS.has(op) || !session || mine.id === null) return { ok: false, error: 'unsupported scan' };
    const value = p['value'] === undefined || p['value'] === null ? undefined : String(p['value']);
    mine.busy = true;
    void scanNext(session, mine.id, {
      mode: op as 'exact',
      ...(value !== undefined && value !== '' ? { value } : {}),
    }).then((r) => { mine.count = r.count; }, (err: unknown) => { mine.pendingError = errMsg(err); })
      .finally(() => { mine.busy = false; });
    return { ok: true };
  }

  async function scanResultsCall(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { valueType: vt, count } = scan;
    const items: Array<{ address: string; value: string }> = [];
    if (session && scan.id !== null && !scan.busy) {
      const limit = Math.min(Number(p['limit']) || 100, RESULT_CAP);
      try {
        const r = await scanResults(session, scan.id, { limit });
        for (const x of r.results) items.push({ address: ceAddress(x.address), value: formatScanValue(x.value, vt) });
      } catch { /* an empty page, like an unreadable list */ }
    }
    return { count, items, valueType: vt };
  }

  async function scanResetCall(): Promise<Record<string, unknown>> {
    if (scan.busy) return { ok: false, error: 'a scan is still running' };
    const old = scan;
    scan = idleScan();
    if (session && old.id !== null) await scanEnd(session, old.id).catch(() => undefined);
    return { ok: true };
  }

  async function memRead(forPid: number, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = Array.isArray(p['items']) ? p['items'] as Array<Record<string, unknown>> : [];
    const s = await ensureSession(forPid);
    if ('ok' in s) return s;
    const values: string[] = raw.map(() => '');
    const idx: number[] = [];
    const reads: Array<{ address: string; length: number }> = [];
    raw.forEach((it, i) => {
      const a = parseAddress(it['address']); const t = it['valueType'];
      if (a === null || !isPanelType(t)) return;
      idx.push(i); reads.push({ address: wireAddress(a), length: SIZE[t] });
    });
    // The daemon takes at most 4096 items a call.
    for (let off = 0; off < reads.length; off += 4096) {
      let bufs: Array<Buffer | null>;
      try { bufs = await readMany(s, reads.slice(off, off + 4096)); } catch { continue; }
      bufs.forEach((b, j) => {
        const i = idx[off + j]!;
        const t = raw[i]!['valueType'] as PanelType;
        if (b && b.length >= SIZE[t]) values[i] = formatBytes(b, t);
      });
    }
    return { values };
  }

  async function startFreeze(s: Session, addr: bigint, t: PanelType, value: number | bigint): Promise<void> {
    const key = addr.toString(16);
    const ep = epoch;
    const handle = await freeze(s, { address: wireAddress(addr), type: ENGINE_TYPE[t], value, intervalMs: FREEZE_INTERVAL_MS });
    if (epoch !== ep) {
      await handle.cancel().catch(() => undefined);
      throw new Error('session ended');
    }
    const old = freezes.get(key);
    freezes.set(key, { handle, type: t });
    await old?.handle.cancel().catch(() => undefined);
  }

  async function memWrite(forPid: number, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const addr = parseAddress(p['address']);
    if (addr === null) return { ok: false, error: 'bad address' };
    const t = p['valueType'];
    const value = isPanelType(t) ? toWritable(p['value'], t) : null;
    if (!isPanelType(t) || value === null) return { ok: false, error: 'could not write that address' };
    const s = await ensureSession(forPid);
    if ('ok' in s) return s;
    try {
      // A frozen address keeps the new value: the freeze is replaced, not fought.
      if (freezes.has(addr.toString(16))) await startFreeze(s, addr, t, value);
      await write(s, wireAddress(addr), ENGINE_TYPE[t], value);
      return { ok: true };
    } catch {
      return { ok: false, error: 'could not write that address' };
    }
  }

  async function freezeSet(forPid: number, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const addr = parseAddress(p['address']);
    if (addr === null) return { ok: false, error: 'bad address' };
    const t = p['valueType'];
    const value = isPanelType(t) ? toWritable(p['value'], t) : null;
    if (!isPanelType(t) || value === null) return { ok: false, error: 'could not freeze that address' };
    const s = await ensureSession(forPid);
    if ('ok' in s) return s;
    try {
      await startFreeze(s, addr, t, value);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  async function freezeClear(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const addr = parseAddress(p['address']);
    const key = addr?.toString(16);
    const f = key ? freezes.get(key) : undefined;
    if (key && f) {
      freezes.delete(key);
      await f.handle.cancel().catch(() => undefined);
    }
    return { ok: true };
  }

  async function speedSet(forPid: number, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const speed = Number(p['speed']);
    if (!Number.isFinite(speed)) return { ok: false, error: 'bad speed' };
    const s = await ensureSession(forPid);
    if ('ok' in s) return s;
    try {
      await setSpeedFn(s, speed);
      return { ok: true, speed };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  return {
    async call(forPid, method, params) {
      if (!SCANNER_METHODS.has(method)) return { ok: false, error: `unsupported command: ${method}` };
      // A different game means everything held for the old one is stale.
      if (pid !== null && pid !== forPid) await teardown();
      pid = forPid;
      const p = asObj(params);
      switch (method) {
        case 'scan_first': return scanFirstCall(forPid, p);
        case 'scan_next': return scanNextCall(p);
        case 'scan_status': {
          if (scan.pendingError !== null) {
            const error = scan.pendingError;
            scan.pendingError = null;
            return { ok: false, error };
          }
          return { busy: scan.busy, started: scan.started, count: scan.count, valueType: scan.valueType };
        }
        case 'scan_results': return scanResultsCall(p);
        case 'scan_reset': return scanResetCall();
        case 'mem_read': return memRead(forPid, p);
        case 'mem_write': return memWrite(forPid, p);
        case 'freeze_set': return freezeSet(forPid, p);
        case 'speed_set': return speedSet(forPid, p);
        default: return freezeClear(p);
      }
    },
    end: () => teardown(),
  };
}
