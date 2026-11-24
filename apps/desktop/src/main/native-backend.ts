/**
 * Runs a compiled Cheat Engine table on starlightd. It takes the CE bridge's
 * commands and answers in the bridge's reply shapes (ce-control-script.ts), so
 * the game page drives either backend the same way.
 *
 * - One symbol registry per session (D11): `registerSymbol` steps export to it,
 *   `uses` names and symbol addresses read from it.
 * - Value records (D23): switched on = frozen at the value read when switched
 *   on; `set_value` writes, and moves the freeze when active.
 * - Toggles serialize per record id. Errors are plain text.
 * - Table hotkeys and the player's bindings go to the hotkey host's session
 *   slot; binding ids are opaque and map to (record, action, value) (R13).
 */
import * as realEngine from '@starlight/engine';
import type { FreezeHandle, RunningCheat, Session, SymbolRegistry } from '@starlight/engine';
import { vkKeysToAccelerator, type CompiledHotkey, type CompiledRecord, type CompiledTable } from '@starlight/ct-importer';
import type { CeRecord } from './ce-session.js';
import type { EngineApi } from './agent/tools.js';
import type { BackendCommand, TableBackend } from './table-backend.js';
import type { setSessionHotkeys, clearSessionHotkeys } from './hotkey-host.js';

export interface NativeBackendDeps {
  session: Session;
  compiled: CompiledTable;
  /** The game's main module (AA's `$process`). */
  mainModule: string;
  engine?: Partial<EngineApi>;
  hotkeys?: { set: typeof setSessionHotkeys; clear: typeof clearSessionHotkeys };
  /** Hotkey presses: `{ type: 'hotkey', id, ok, active, error? }`, like the bridge's `/event` posts. */
  onEvent?(e: Record<string, unknown>): void;
  log?(line: string): void;
  /** Compiles another table for `load_table`. */
  loadCompiled?(path: string): Promise<CompiledTable>;
}

type ValueRecord = Extract<CompiledRecord, { kind: 'value' }>;
type Reply = { ok: boolean; active: boolean; error?: string };
type Live =
  | { kind: 'flag' }
  | { kind: 'patch'; cheat: RunningCheat }
  | { kind: 'value'; address: string; handle: FreezeHandle };
interface HotkeyTarget { recordId: number; action: CompiledHotkey['action']; value?: string }

const FREEZE_INTERVAL_MS = 50;
const READ_MANY_MAX = 4096;
const NOT_ATTACHED = 'not attached to a game process';
/** The on/off actions; CE's `set_hotkeys` `replace` drops only these (`action <= 2`). */
const ON_OFF = new Set<CompiledHotkey['action']>(['toggle', 'activate', 'deactivate']);

const SIZES: Record<string, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, double: 8,
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const hasOpt = (r: CompiledRecord, name: string) => (r.opts ?? '').split(/[\s,[\]]+/).includes(name);
const isValue = (r: CompiledRecord): r is ValueRecord => r.kind === 'value';
const sizeOf = (r: ValueRecord) => SIZES[r.valueType] ?? r.length ?? 1;
const isFloat = (r: ValueRecord) => r.valueType === 'float' || r.valueType === 'double';
const isInteger = (r: ValueRecord) => r.valueType in SIZES && !isFloat(r);

function readUnsigned(buf: Buffer, size: number): bigint {
  return size === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUIntLE(0, size));
}

/** A value as numbers: BigInt for integer types (signed per the record), number for floats. */
function numberOf(r: ValueRecord, buf: Buffer): bigint | number {
  if (r.valueType === 'float') return buf.readFloatLE(0);
  if (r.valueType === 'double') return buf.readDoubleLE(0);
  const raw = readUnsigned(buf, sizeOf(r));
  return r.valueType.startsWith('int') || r.showAsSigned ? BigInt.asIntN(sizeOf(r) * 8, raw) : raw;
}

/** D23 display: decimal, uppercase hex for ShowAsHex, signed for ShowAsSigned, spaced hex for byte arrays. */
function display(r: ValueRecord, buf: Buffer): string {
  if (r.valueType === 'bytes') return [...buf].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  if (r.valueType === 'string') {
    const nul = buf.indexOf(0);
    return buf.subarray(0, nul < 0 ? buf.length : nul).toString('utf8');
  }
  if (buf.length < sizeOf(r)) return '??';
  if (r.valueType === 'float') {
    const v = buf.readFloatLE(0);
    return Number.isFinite(v) ? String(Number(v.toPrecision(7))) : String(v);
  }
  if (r.valueType === 'double') return String(buf.readDoubleLE(0));
  if (r.showAsHex) return readUnsigned(buf, sizeOf(r)).toString(16).toUpperCase();
  return String(numberOf(r, buf));
}

function invalid(text: string): Error {
  return new Error(`"${text}" isn't a value this record takes`);
}

/** Player text (or a hotkey's value) as a number for this record. Hex records take hex. */
function parseNumber(r: ValueRecord, text: string): bigint | number {
  const t = text.trim();
  if (isFloat(r)) {
    const n = Number(t);
    if (t === '' || Number.isNaN(n)) throw invalid(t);
    return n;
  }
  const hex = /^([+-]?)(?:0x|\$)?([0-9a-f]+)$/i.exec(t);
  if (hex && (r.showAsHex || /^[+-]?(?:0x|\$)/i.test(t))) {
    const v = BigInt('0x' + hex[2]);
    return hex[1] === '-' ? -v : v;
  }
  if (/^[+-]?\d+$/.test(t)) return BigInt(t);
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) throw invalid(t);
  return BigInt(Math.trunc(n));
}

/** Little-endian bytes of a number; integers wrap to the record's width, as CE does. */
function encodeNumber(r: ValueRecord, v: bigint | number): Buffer {
  const size = sizeOf(r);
  const buf = Buffer.alloc(size);
  if (r.valueType === 'float') buf.writeFloatLE(Number(v));
  else if (r.valueType === 'double') buf.writeDoubleLE(Number(v));
  else {
    const raw = BigInt.asUintN(size * 8, typeof v === 'bigint' ? v : BigInt(Math.trunc(v)));
    if (size === 8) buf.writeBigUInt64LE(raw);
    else buf.writeUIntLE(Number(raw), 0, size);
  }
  return buf;
}

/** What `set_value` writes for a record. Dropdown labels map to their values; dropdown values are numbers. */
function encode(r: ValueRecord, input: unknown): Buffer {
  let text = String(input ?? '').trim();
  const opt = r.options?.find((o) => o.label === text && o.value !== text);
  if (opt && !r.options!.some((o) => o.value === text)) text = opt.value;
  if (r.valueType === 'bytes') {
    const toks = text.split(/\s+/).filter(Boolean);
    if (toks.length === 0 || toks.length > sizeOf(r) || !toks.every((x) => /^[0-9a-f]{1,2}$/i.test(x))) {
      throw new Error(`"${text}" isn't bytes this record takes (hex, like 90 90, at most ${sizeOf(r)})`);
    }
    return Buffer.from(toks.map((x) => parseInt(x, 16)));
  }
  if (r.valueType === 'string') {
    const len = sizeOf(r);
    const bytes = Buffer.from(text, 'utf8').subarray(0, len);
    return bytes.length < len ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
  }
  return encodeNumber(r, parseNumber(r, text));
}

function lazyHotkeys(): NonNullable<NativeBackendDeps['hotkeys']> {
  // Loaded on first use, so the backend doesn't pull the keyboard hook in until it binds keys.
  const host = () => import('./hotkey-host.js');
  return {
    set: (bindings, onPress) => { void host().then((h) => h.setSessionHotkeys(bindings, onPress)); },
    clear: () => { void host().then((h) => h.clearSessionHotkeys()); },
  };
}

export function createNativeBackend(deps: NativeBackendDeps): TableBackend {
  const E = { ...realEngine, ...deps.engine } as EngineApi;
  const s = deps.session;
  const log = deps.log ?? (() => {});
  const hotkeys = deps.hotkeys ?? lazyHotkeys();
  const mainModule = deps.mainModule;

  let compiled = deps.compiled;
  let registry: SymbolRegistry = new Map();
  const live = new Map<number, Live>();
  /** Ids of active records, oldest first. */
  const order: number[] = [];
  const chains = new Map<number, Promise<unknown>>();

  const find = (id: unknown) => compiled.records.find((r) => r.id === id);
  const forget = (id: number) => {
    live.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
  };

  /** Runs `fn` after every earlier operation on the same record. */
  function serial<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? Promise.resolve()).then(fn);
    const tail = next.then(() => {}, () => {});
    chains.set(id, tail);
    void tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
    return next;
  }

  function childrenOf(rec: CompiledRecord): CompiledRecord[] {
    const out: CompiledRecord[] = [];
    const i = compiled.records.indexOf(rec);
    for (const r of compiled.records.slice(i + 1)) {
      if (r.depth <= rec.depth) break;
      if (r.depth === rec.depth + 1) out.push(r);
    }
    return out;
  }

  const addressOf = (r: ValueRecord) => E.resolveCheatAddress(s, r.address, { symbols: registry, mainModule });

  async function turnOn(rec: CompiledRecord): Promise<Live> {
    if (rec.kind === 'unsupported') throw new Error('this record needs Cheat Engine');
    if (rec.kind === 'value') {
      const address = await addressOf(rec);
      const [now] = await E.readMany(s, [{ address, length: sizeOf(rec) }]);
      if (!now) throw new Error(`can't read the value at ${address}`);
      const handle = await E.freeze(s, { address, bytes: now, intervalMs: FREEZE_INTERVAL_MS });
      return { kind: 'value', address, handle };
    }
    const script = rec.script;
    if (!script?.cheat) return { kind: 'flag' };
    for (const use of script.uses) {
      const name = use.toLowerCase();
      if (registry.has(name)) continue;
      const owner = find(compiled.registeredBy[name]);
      throw new Error(owner
        ? `symbol ${name} isn't registered; switch on "${owner.name}" first`
        : `symbol ${name} isn't registered`);
    }
    const cheat = await E.enableCheat(s, script.cheat, { symbols: registry, mainModule, log });
    return { kind: 'patch', cheat };
  }

  async function turnOff(l: Live): Promise<void> {
    if (l.kind === 'patch') await l.cheat.disable();
    else if (l.kind === 'value') await l.handle.cancel();
  }

  /** Switches a record on/off (serialized per id), cascading per moActivate/moDeactivateChildrenAsWell. */
  function setActive(rec: CompiledRecord, want: boolean | 'toggle'): Promise<Reply> {
    return serial(rec.id, async (): Promise<Reply> => {
      const cur = live.get(rec.id);
      const on = want === 'toggle' ? !cur : want;
      if (on === !!cur) return { ok: true, active: on };
      if (on) {
        if (!s.attached) return { ok: false, active: false, error: NOT_ATTACHED };
        try {
          live.set(rec.id, await turnOn(rec));
          order.push(rec.id);
        } catch (err) {
          return { ok: false, active: false, error: message(err) };
        }
        if (hasOpt(rec, 'moActivateChildrenAsWell')) {
          for (const child of childrenOf(rec)) {
            const r = await setActive(child, true);
            if (!r.ok) log(`[native-table] "${child.name}" didn't switch on with "${rec.name}": ${r.error}`);
          }
        }
        return { ok: true, active: true };
      }
      if (hasOpt(rec, 'moDeactivateChildrenAsWell')) {
        for (const child of childrenOf(rec)) {
          const r = await setActive(child, false);
          if (!r.ok) log(`[native-table] "${child.name}" didn't switch off with "${rec.name}": ${r.error}`);
        }
      }
      try {
        await turnOff(cur!);
      } catch (err) {
        return { ok: false, active: true, error: message(err) };
      }
      forget(rec.id);
      return { ok: true, active: false };
    });
  }

  async function writeRaw(address: string, bytes: Buffer): Promise<void> {
    await s.client.call('write', { handle: s.handle, address, bytes: bytes.toString('hex') });
  }

  /** Writes a value record (moving its freeze when active) and returns what it reads back. */
  async function writeValue(rec: ValueRecord, bytes: Buffer): Promise<string> {
    const l = live.get(rec.id);
    const address = l?.kind === 'value' ? l.address : await addressOf(rec);
    await writeRaw(address, bytes);
    if (l?.kind === 'value') {
      await l.handle.cancel();
      l.handle = await E.freeze(s, { address, bytes, intervalMs: FREEZE_INTERVAL_MS });
    }
    const [got] = await E.readMany(s, [{ address, length: sizeOf(rec) }]);
    return got ? display(rec, got) : '??';
  }

  /** Inc/dec hotkeys: the current value plus or minus the hotkey's value. */
  async function stepValue(rec: ValueRecord, delta: string, sign: 1 | -1): Promise<void> {
    if (!isInteger(rec) && !isFloat(rec)) throw new Error("this value can't go up or down");
    const l = live.get(rec.id);
    const address = l?.kind === 'value' ? l.address : await addressOf(rec);
    const [now] = await E.readMany(s, [{ address, length: sizeOf(rec) }]);
    if (!now) throw new Error(`can't read the value at ${address}`);
    const cur = numberOf(rec, now);
    const d = parseNumber(rec, delta);
    const next = typeof cur === 'bigint'
      ? cur + BigInt(sign) * (typeof d === 'bigint' ? d : BigInt(Math.trunc(d)))
      : cur + sign * Number(d);
    await writeValue(rec, encodeNumber(rec, next));
  }

  /** Every value record's display text through one readMany (per 4096 items); unresolvable or unreadable is `??`. */
  async function readValues(): Promise<Map<number, string>> {
    const recs = compiled.records.filter(isValue);
    const out = new Map<number, string>(recs.map((r) => [r.id, '??']));
    if (!s.attached || recs.length === 0) return out;
    const addrs = await Promise.all(recs.map((r) => {
      const l = live.get(r.id);
      return l?.kind === 'value' ? Promise.resolve(l.address) : addressOf(r).catch(() => null);
    }));
    const items: Array<{ rec: ValueRecord; address: string; length: number }> = [];
    recs.forEach((rec, i) => { if (addrs[i]) items.push({ rec, address: addrs[i]!, length: sizeOf(rec) }); });
    for (let k = 0; k < items.length; k += READ_MANY_MAX) {
      const chunk = items.slice(k, k + READ_MANY_MAX);
      let bufs: Array<Buffer | null> = [];
      try { bufs = await E.readMany(s, chunk.map(({ address, length }) => ({ address, length }))); } catch { /* all ?? */ }
      chunk.forEach((it, j) => { const b = bufs[j]; if (b) out.set(it.rec.id, display(it.rec, b)); });
    }
    return out;
  }

  function describe(r: CompiledRecord, values: Map<number, string>): CeRecord {
    const toggle = r.hotkeys.find((h) => ON_OFF.has(h.action));
    return {
      id: r.id,
      name: r.name,
      isActive: live.has(r.id),
      isGroupHeader: r.kind === 'header',
      kind: r.kind === 'unsupported' ? 'script' : r.kind,
      depth: r.depth,
      ...(r.opts ? { opts: r.opts } : {}),
      ...(toggle ? { hotkey: toggle.accelerator } : {}),
      ...(r.kind === 'value' ? { value: values.get(r.id) ?? '??', ...(r.options ? { options: r.options } : {}) } : {}),
    };
  }

  async function checkScript(rec: CompiledRecord) {
    const cheat = rec.kind === 'script' || rec.kind === 'header' ? rec.script?.cheat ?? null : null;
    const sigs: Array<{ name: string; module?: string; pattern: string }> = [];
    const norm = (p: string) => p.trim().split(/\s+/).join(' ').toLowerCase();
    const mod = (m: string | undefined) => (m !== undefined && m.toLowerCase() === '$process' ? mainModule : m);
    for (const st of cheat?.enable ?? []) {
      if (st.op === 'aobScan') sigs.push({ name: st.name, ...(st.module !== undefined ? { module: mod(st.module)! } : {}), pattern: st.pattern });
    }
    const site = cheat?.site;
    if (site && !sigs.some((x) => x.module?.toLowerCase() === mod(site.module)!.toLowerCase() && norm(x.pattern) === norm(site.pattern))) {
      sigs.unshift({ name: 'site', module: mod(site.module)!, pattern: site.pattern });
    }
    if (sigs.length === 0) return { unknown: true, reason: 'no signatures to look up' };
    let found = 0;
    let missing = 0;
    let problem: string | undefined;
    for (const sig of sigs) {
      let hit = false;
      try {
        hit = (await E.aobScan(s, { ...(sig.module !== undefined ? { module: sig.module } : {}), pattern: sig.pattern })).length > 0;
      } catch (err) {
        const notLoaded = err instanceof realEngine.EngineError && err.code === realEngine.RpcCode.ModuleNotFound;
        if (!notLoaded) return { unknown: true, reason: 'scan unavailable' };
      }
      if (hit) found++;
      else {
        missing++;
        problem ??= `signature '${sig.name}' is not in the game`;
      }
    }
    return missing > 0 ? { ok: false, found, missing, error: problem } : { ok: true, found };
  }

  function onHotkey(t: HotkeyTarget, table: CompiledTable): void {
    void (async () => {
      const rec = table === compiled ? find(t.recordId) : undefined;
      if (!rec) return;
      let r: Reply;
      if (t.action === 'toggle') r = await setActive(rec, 'toggle');
      else if (t.action === 'activate') r = await setActive(rec, true);
      else if (t.action === 'deactivate') r = await setActive(rec, false);
      else {
        r = await serial(rec.id, async (): Promise<Reply> => {
          try {
            if (!isValue(rec)) throw new Error('this record has no value');
            if (!s.attached) throw new Error(NOT_ATTACHED);
            if (t.action === 'set') await writeValue(rec, encode(rec, t.value ?? ''));
            else await stepValue(rec, t.value ?? '1', t.action === 'inc' ? 1 : -1);
            return { ok: true, active: live.has(rec.id) };
          } catch (err) {
            return { ok: false, active: live.has(rec.id), error: message(err) };
          }
        });
      }
      deps.onEvent?.({ type: 'hotkey', id: rec.id, ok: r.ok, active: r.active, ...(r.error !== undefined ? { error: r.error } : {}) });
    })().catch((err) => log(`[native-table] hotkey failed: ${message(err)}`));
  }

  function setHotkeys(p: { bindings?: Array<{ id: number; keys: number | number[] }>; replace?: number[] }) {
    const replace = new Set(p.replace ?? []);
    const targets: HotkeyTarget[] = [];
    const list: Array<{ id: number; accelerator: string }> = [];
    const add = (t: HotkeyTarget, accelerator: string) => { list.push({ id: targets.length, accelerator }); targets.push(t); };
    for (const rec of compiled.records) {
      for (const hk of rec.hotkeys) {
        if (replace.has(rec.id) && ON_OFF.has(hk.action)) continue;
        add({ recordId: rec.id, action: hk.action, ...(hk.value !== undefined ? { value: hk.value } : {}) }, hk.accelerator);
      }
    }
    let count = 0;
    for (const b of p.bindings ?? []) {
      const accelerator = find(b.id) ? vkKeysToAccelerator(b.keys) : undefined;
      if (!accelerator) continue;
      add({ recordId: b.id, action: 'toggle' }, accelerator);
      count++;
    }
    const table = compiled;
    hotkeys.set(list, (id) => { const t = targets[id]; if (t) onHotkey(t, table); });
    return { ok: true, count };
  }

  /** Every active record off, newest first. */
  async function disableAll(): Promise<void> {
    await Promise.allSettled([...chains.values()]);
    for (const id of [...order].reverse()) {
      await serial(id, async () => {
        const l = live.get(id);
        if (!l) return;
        try { await turnOff(l); } catch (err) { log(`[native-table] record ${id} didn't switch off: ${message(err)}`); }
        forget(id);
      });
    }
  }

  async function send(cmd: BackendCommand): Promise<unknown> {
    const p = (cmd.params ?? {}) as Record<string, unknown>;
    switch (cmd.method) {
      case 'ping':
        return { ok: true, ready: true, attached: s.attached };
      case 'status':
        return { attached: s.attached, pid: s.pid, ready: true };
      case 'list_records': {
        const values = await readValues();
        return { records: compiled.records.map((r) => describe(r, values)) };
      }
      case 'refresh': {
        const values = await readValues();
        return {
          states: compiled.records.map((r) => ({
            id: r.id, a: live.has(r.id), ...(r.kind === 'value' ? { v: values.get(r.id) ?? '??' } : {}),
          })),
        };
      }
      case 'set_active': {
        if (p['id'] === undefined) return { ok: false, error: 'missing id' };
        const rec = find(p['id']);
        if (!rec) return { ok: false, error: 'record not found' };
        return setActive(rec, Boolean(p['active']));
      }
      case 'check_script': {
        const rec = find(p['id']);
        if (!rec) return { ok: false, error: 'record not found' };
        return checkScript(rec);
      }
      case 'set_value': {
        const rec = find(p['id']);
        if (!rec) return { ok: false, error: 'record not found' };
        if (!s.attached) return { ok: false, error: NOT_ATTACHED };
        if (!isValue(rec)) return { ok: false, error: 'this record has no value' };
        return serial(rec.id, async () => {
          try {
            return { ok: true, value: await writeValue(rec, encode(rec, p['value'])) };
          } catch (err) {
            return { ok: false, error: message(err) };
          }
        });
      }
      case 'set_hotkeys':
        return setHotkeys(p as Parameters<typeof setHotkeys>[0]);
      case 'load_table': {
        const path = p['path'];
        if (typeof path !== 'string' || !path) return { ok: false, error: 'missing path' };
        if (!deps.loadCompiled) return { ok: false, error: "this session can't load another table" };
        await disableAll();
        hotkeys.clear();
        try {
          compiled = await deps.loadCompiled(path);
        } catch (err) {
          return { ok: false, error: message(err) };
        }
        registry = new Map();
        return { ok: true };
      }
      case 'set_speed':
        return { ok: false, error: 'game speed is handled by the session' };
      case 'shutdown':
        await disableAll();
        hotkeys.clear();
        return { ok: true };
      default:
        return { ok: false, error: `unknown method: ${cmd.method}` };
    }
  }

  return {
    kind: 'native',
    send,
    async close() { await send({ method: 'shutdown' }); },
  };
}
