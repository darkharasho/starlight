// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTable, type CompiledTable, type StarlightAddress } from '@starlight/ct-importer';
import { EngineError, ScanError, type Session, type SymbolRegistry } from '@starlight/engine';
import { createNativeBackend } from '../../src/main/native-backend.js';

const FIXTURES = join(__dirname, '../../../../packages/ct-importer/test/fixtures/tables');
const fixture = (name: string): CompiledTable => compileTable(readFileSync(join(FIXTURES, name), 'utf8'));

const MODULE_BASE = 0x400000n;
const hex = (n: bigint) => '0x' + n.toString(16);

/** A game's memory and an engine faked over it. */
function fakeGame() {
  const mem = new Map<string, Buffer>();
  const writes: Array<{ address: string; bytes: string }> = [];
  const freezes: Array<{ address: string; bytes: string; cancelled: boolean }> = [];
  const enabled: string[] = [];
  const disabled: string[] = [];
  const session = {
    pid: 4242, handle: 1, attached: true,
    client: {
      closed: false,
      call: vi.fn(async (method: string, p: { address: string; bytes: string }) => {
        if (method !== 'write') throw new Error(`unexpected call ${method}`);
        writes.push({ address: p.address, bytes: p.bytes });
        mem.set(p.address, Buffer.from(p.bytes, 'hex'));
        return {};
      }),
    },
    detach: vi.fn(), onDetached: () => () => {},
  } as unknown as Session;

  const resolveCheatAddress = vi.fn(async (_s: Session, a: StarlightAddress, o: { symbols?: SymbolRegistry } = {}) => {
    if (a.kind === 'module') return hex(MODULE_BASE + BigInt(a.offset));
    if (a.kind === 'symbol') {
      const base = o.symbols?.get(a.expr.toLowerCase());
      if (base === undefined) throw new EngineError(`symbol ${a.expr} isn't registered`);
      return hex(BigInt(base) + (a.offsets ?? []).reduce((t, x) => t + BigInt(x), 0n));
    }
    throw new EngineError(`can't resolve ${a.kind}`);
  });
  const readMany = vi.fn(async (_s: Session, items: Array<{ address: string; length: number }>) =>
    items.map((it) => {
      const b = mem.get(it.address);
      return b ? Buffer.from(b.subarray(0, it.length)) : null;
    }));
  const freeze = vi.fn(async (_s: Session, spec: { address: string; bytes?: Buffer | string; type?: string; value?: number }) => {
    const bytes = typeof spec.bytes === 'string' ? spec.bytes : spec.bytes!.toString('hex');
    const f = { address: spec.address, bytes, cancelled: false };
    freezes.push(f);
    return { get active() { return !f.cancelled; }, cancel: async () => { f.cancelled = true; } };
  });
  const enableCheat = vi.fn(async (_s: Session, cheat: { name: string }, o: { symbols?: SymbolRegistry }) => {
    enabled.push(cheat.name);
    if (cheat.name === 'Get player') o.symbols!.set('pplayer', '0x9000');
    return {
      kind: 'patch' as const, address: '0x1', setValue: async () => {},
      disable: async () => {
        disabled.push(cheat.name);
        if (cheat.name === 'Get player') o.symbols!.delete('pplayer');
      },
    };
  });
  const aobScan = vi.fn(async (): Promise<string[]> => []);
  const engine = { resolveCheatAddress, readMany, freeze, enableCheat, aobScan } as never;
  const hotkeys = { set: vi.fn(), clear: vi.fn() };
  const events: Array<Record<string, unknown>> = [];
  const setU32 = (address: string, v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); mem.set(address, b); };
  return { mem, writes, freezes, enabled, disabled, session, engine, hotkeys, events, setU32, enableCheat, aobScan };
}

function backendFor(compiled: CompiledTable, g = fakeGame(), extra: Record<string, unknown> = {}) {
  const b = createNativeBackend({
    session: g.session, compiled, mainModule: 'target', engine: g.engine, hotkeys: g.hotkeys,
    onEvent: (e) => g.events.push(e), ...extra,
  });
  return { b, g };
}

const CASCADE = compileTable(`<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45"><CheatEntries>
  <CheatEntry><ID>1</ID><Description>"All"</Description>
    <Options moActivateChildrenAsWell="1" moDeactivateChildrenAsWell="1"/>
    <GroupHeader>1</GroupHeader>
    <CheatEntries>
      <CheatEntry><ID>2</ID><Description>"First"</Description><VariableType>Auto Assembler Script</VariableType>
        <AssemblerScript>[ENABLE]
"target"+10:
  db 90
[DISABLE]
"target"+10:
  db 00
</AssemblerScript></CheatEntry>
      <CheatEntry><ID>3</ID><Description>"Second"</Description><VariableType>Auto Assembler Script</VariableType>
        <AssemblerScript>[ENABLE]
"target"+20:
  db 90
[DISABLE]
"target"+20:
  db 00
</AssemblerScript></CheatEntry>
    </CheatEntries>
  </CheatEntry>
</CheatEntries></CheatTable>`);

const VALUES = compileTable(`<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45"><CheatEntries>
  <CheatEntry><ID>1</ID><Description>"Flags"</Description><ShowAsHex>1</ShowAsHex><VariableType>4 Bytes</VariableType><Address>"target"+100</Address></CheatEntry>
  <CheatEntry><ID>2</ID><Description>"Bytes"</Description><VariableType>Array of byte</VariableType><ByteLength>3</ByteLength><Address>"target"+200</Address></CheatEntry>
  <CheatEntry><ID>3</ID><Description>"Delta"</Description><ShowAsSigned>1</ShowAsSigned><VariableType>Byte</VariableType><Address>"target"+300</Address></CheatEntry>
</CheatEntries></CheatTable>`);

describe('native table backend', () => {
  it('list_records mirrors the CE bridge shape', async () => {
    const g = fakeGame();
    g.mem.set('0x405000', Buffer.from([1]));
    g.setU32('0x405010', 1234);
    const { b } = backendFor(fixture('dropdown-hotkeys.CT'), g);
    expect(b.kind).toBe('native');
    const { records } = await b.send({ method: 'list_records' }) as { records: unknown[] };
    expect(records).toEqual([
      { id: 1, name: 'God mode', isActive: false, isGroupHeader: false, kind: 'value', depth: 0, value: '1',
        options: [{ value: '0', label: 'Off' }, { value: '1', label: 'On' }] },
      { id: 2, name: 'Enemy god mode', isActive: false, isGroupHeader: false, kind: 'value', depth: 0, value: '??',
        options: [{ value: '0', label: 'Off' }, { value: '1', label: 'On' }] },
      { id: 3, name: 'Money', isActive: false, isGroupHeader: false, kind: 'value', depth: 0, value: '1234' },
    ]);

    const tree = await backendFor(fixture('native-ok.CT')).b.send({ method: 'list_records' }) as { records: Array<Record<string, unknown>> };
    expect(tree.records.map((r) => [r['id'], r['kind'], r['depth'], r['isGroupHeader'], r['opts'], r['hotkey']])).toEqual([
      [0, 'header', 0, true, 'moHideChildren', undefined],
      [1, 'value', 1, false, undefined, undefined],
      [2, 'value', 1, false, undefined, undefined],
      [5, 'script', 0, false, undefined, 'Ctrl+A'],
      [6, 'script', 0, false, undefined, undefined],
    ]);
  });

  it('ping, status and set_speed answer like the bridge', async () => {
    const { b } = backendFor(fixture('native-ok.CT'));
    expect(await b.send({ method: 'ping' })).toEqual({ ok: true, ready: true, attached: true });
    expect(await b.send({ method: 'status' })).toEqual({ attached: true, pid: 4242, ready: true });
    expect(await b.send({ method: 'set_speed', params: { speed: 2 } })).toEqual({ ok: false, error: 'game speed is handled by the session' });
  });

  it('switching a script on runs its patch cheat with the shared registry', async () => {
    const { b, g } = backendFor(fixture('symbol-children.CT'));
    expect(await b.send({ method: 'set_active', params: { id: 10, active: true } })).toEqual({ ok: true, active: true });
    const [, cheat, opts] = g.enableCheat.mock.calls[0]! as unknown as [Session, { name: string }, { symbols: SymbolRegistry; mainModule: string }];
    expect(cheat.name).toBe('Get player');
    expect(opts.mainModule).toBe('target');
    expect(opts.symbols.get('pplayer')).toBe('0x9000');
    // The next script sees the same registry.
    expect(await b.send({ method: 'set_active', params: { id: 14, active: true } })).toEqual({ ok: true, active: true });
    const opts2 = g.enableCheat.mock.calls[1]![2] as { symbols: SymbolRegistry };
    expect(opts2.symbols).toBe(opts.symbols);
    const { states } = await b.send({ method: 'refresh' }) as { states: Array<{ id: number; a: boolean }> };
    expect(states.filter((s) => s.a).map((s) => s.id)).toEqual([10, 14]);
    expect(await b.send({ method: 'set_active', params: { id: 14, active: false } })).toEqual({ ok: true, active: false });
    expect(g.disabled).toEqual(['Inf health']);
  });

  it('a script that needs another record\'s symbol says which record to switch on', async () => {
    const { b, g } = backendFor(fixture('symbol-children.CT'));
    expect(await b.send({ method: 'set_active', params: { id: 14, active: true } })).toEqual({
      ok: false, active: false, error: 'symbol pplayer isn\'t registered; switch on "Get player" first',
    });
    expect(g.enableCheat).not.toHaveBeenCalled();
  });

  it('engine errors come back as plain text', async () => {
    const g = fakeGame();
    g.enableCheat.mockRejectedValueOnce(new ScanError('AOB PLAYER_AOB not found in target'));
    const { b } = backendFor(fixture('symbol-children.CT'), g);
    expect(await b.send({ method: 'set_active', params: { id: 10, active: true } }))
      .toEqual({ ok: false, active: false, error: 'AOB PLAYER_AOB not found in target' });
    expect(await b.send({ method: 'set_active', params: { id: 99, active: true } })).toEqual({ ok: false, error: 'record not found' });
  });

  it('values through a registered symbol show ?? until it is registered', async () => {
    const { b, g } = backendFor(fixture('symbol-children.CT'));
    g.setU32('0x9010', 100);
    g.setU32('0x9048', 7);
    const before = await b.send({ method: 'refresh' }) as { states: Array<{ id: number; v?: string }> };
    expect(before.states.filter((s) => s.v !== undefined)).toEqual([
      { id: 11, a: false, v: '??' }, { id: 12, a: false, v: '??' }, { id: 13, a: false, v: '??' },
    ]);
    await b.send({ method: 'set_active', params: { id: 10, active: true } });
    const after = await b.send({ method: 'refresh' }) as { states: Array<{ id: number; v?: string }> };
    expect(after.states.filter((s) => s.v !== undefined)).toEqual([
      { id: 11, a: false, v: '100' }, { id: 12, a: false, v: '??' }, { id: 13, a: false, v: '7' },
    ]);
  });

  it('a value record switched on freezes at its current value; set_value updates the freeze', async () => {
    const { b, g } = backendFor(fixture('dropdown-hotkeys.CT'));
    g.setU32('0x405010', 500);
    expect(await b.send({ method: 'set_active', params: { id: 3, active: true } })).toEqual({ ok: true, active: true });
    expect(g.freezes).toEqual([{ address: '0x405010', bytes: 'f4010000', cancelled: false }]);
    expect(await b.send({ method: 'set_value', params: { id: 3, value: '999' } })).toEqual({ ok: true, value: '999' });
    expect(g.writes).toEqual([{ address: '0x405010', bytes: 'e7030000' }]);
    expect(g.freezes.map((f) => [f.bytes, f.cancelled])).toEqual([['f4010000', true], ['e7030000', false]]);
    expect(await b.send({ method: 'set_active', params: { id: 3, active: false } })).toEqual({ ok: true, active: false });
    expect(g.freezes.every((f) => f.cancelled)).toBe(true);
  });

  it('set_value writes dropdowns as numbers, takes hex for hex records and spaced hex for byte arrays', async () => {
    const dd = backendFor(fixture('dropdown-hotkeys.CT'));
    expect(await dd.b.send({ method: 'set_value', params: { id: 1, value: '1' } })).toEqual({ ok: true, value: '1' });
    expect(await dd.b.send({ method: 'set_value', params: { id: 2, value: 'On' } })).toEqual({ ok: true, value: '1' });
    expect(dd.g.writes).toEqual([{ address: '0x405000', bytes: '01' }, { address: '0x405001', bytes: '01' }]);

    const { b, g } = backendFor(VALUES);
    expect(await b.send({ method: 'set_value', params: { id: 1, value: 'ff' } })).toEqual({ ok: true, value: 'FF' });
    expect(await b.send({ method: 'set_value', params: { id: 2, value: '90 90 c3' } })).toEqual({ ok: true, value: '90 90 C3' });
    expect(await b.send({ method: 'set_value', params: { id: 3, value: '-2' } })).toEqual({ ok: true, value: '-2' });
    expect(g.writes).toEqual([
      { address: '0x400100', bytes: 'ff000000' }, { address: '0x400200', bytes: '9090c3' }, { address: '0x400300', bytes: 'fe' },
    ]);
    const bad = await b.send({ method: 'set_value', params: { id: 2, value: 'zz' } }) as { ok: boolean };
    expect(bad.ok).toBe(false);

    // An active byte array freezes raw bytes.
    expect(await b.send({ method: 'set_active', params: { id: 2, active: true } })).toEqual({ ok: true, active: true });
    expect(g.freezes.at(-1)).toEqual({ address: '0x400200', bytes: '9090c3', cancelled: false });
  });

  it('moActivateChildrenAsWell switches the children on in order', async () => {
    const { b, g } = backendFor(CASCADE);
    expect(await b.send({ method: 'set_active', params: { id: 1, active: true } })).toEqual({ ok: true, active: true });
    expect(g.enabled).toEqual(['First', 'Second']);
    const { states } = await b.send({ method: 'refresh' }) as { states: Array<{ id: number; a: boolean }> };
    expect(states).toEqual([{ id: 1, a: true }, { id: 2, a: true }, { id: 3, a: true }]);
    expect(await b.send({ method: 'set_active', params: { id: 1, active: false } })).toEqual({ ok: true, active: false });
    expect(g.disabled).toEqual(['First', 'Second']);
  });

  it('concurrent toggles of one record are serialized', async () => {
    const { b, g } = backendFor(CASCADE);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    g.enableCheat.mockImplementationOnce(async (_s, cheat) => {
      await gate;
      g.enabled.push(cheat.name);
      return { kind: 'patch', address: '0x1', setValue: async () => {}, disable: async () => { g.disabled.push(cheat.name); } };
    });
    const first = b.send({ method: 'set_active', params: { id: 2, active: true } });
    const second = b.send({ method: 'set_active', params: { id: 2, active: true } });
    const third = b.send({ method: 'set_active', params: { id: 2, active: false } });
    release();
    expect(await first).toEqual({ ok: true, active: true });
    expect(await second).toEqual({ ok: true, active: true });
    expect(await third).toEqual({ ok: true, active: false });
    expect(g.enableCheat).toHaveBeenCalledTimes(1);
    expect(g.disabled).toEqual(['First']);
  });

  it('check_script reports a missing signature in CE\'s words', async () => {
    const { b, g } = backendFor(fixture('symbol-children.CT'));
    expect(await b.send({ method: 'check_script', params: { id: 10 } })).toEqual({
      ok: false, found: 0, missing: 1, error: "signature 'PLAYER_AOB' is not in the game",
    });
    expect(g.aobScan).toHaveBeenCalledTimes(1);
    expect(g.aobScan.mock.calls[0]![1]).toEqual({ module: 'target', pattern: '48 8B 43 18 8B 40 10' });
    g.aobScan.mockResolvedValueOnce(['0x401000']);
    expect(await b.send({ method: 'check_script', params: { id: 10 } })).toEqual({ ok: true, found: 1 });
    expect(await b.send({ method: 'check_script', params: { id: 14 } })).toEqual({ unknown: true, reason: 'no signatures to look up' });
    expect(g.enableCheat).not.toHaveBeenCalled();
    expect(g.writes).toEqual([]);
  });

  it('set_hotkeys registers table hotkeys except replaced records, plus user bindings', async () => {
    const { b, g } = backendFor(fixture('native-ok.CT'));
    expect(await b.send({ method: 'set_hotkeys', params: { bindings: [{ id: 6, keys: [0x11, 0x70] }], replace: [5] } }))
      .toEqual({ ok: true, count: 1 });
    expect(g.hotkeys.set).toHaveBeenCalledTimes(1);
    const bindings = g.hotkeys.set.mock.calls[0]![0] as Array<{ id: number; accelerator: string }>;
    expect(bindings.map((x) => x.accelerator)).toEqual(['Ctrl+F1']);

    const dd = backendFor(fixture('dropdown-hotkeys.CT'));
    await dd.b.send({ method: 'set_hotkeys', params: { bindings: [], replace: [3] } });
    const ddb = dd.g.hotkeys.set.mock.calls[0]![0] as Array<{ id: number; accelerator: string }>;
    // Replace drops only toggle hotkeys (CE's action <= 2): value, Activate and Deactivate hotkeys stay.
    expect(ddb.map((x) => x.accelerator)).toEqual(['F3', 'Shift+PageUp', 'Num0', 'Alt+F1', 'Alt+F2']);

    const all = backendFor(fixture('native-ok.CT'));
    await all.b.send({ method: 'set_hotkeys', params: { bindings: [{ id: 6, keys: [0x70] }] } });
    const ab = all.g.hotkeys.set.mock.calls[0]![0] as Array<{ id: number; accelerator: string }>;
    expect(ab.map((x) => x.accelerator)).toEqual(['Ctrl+A', 'F1']);
    expect(new Set(ab.map((x) => x.id)).size).toBe(2);
  });

  it('an Activate-only record has no toggle hotkey, and its Activate key survives replace', async () => {
    const t = compileTable(`<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45"><CheatEntries>
  <CheatEntry><ID>4</ID><Description>"Turbo"</Description><VariableType>Auto Assembler Script</VariableType>
    <AssemblerScript>[ENABLE]
"target"+10:
  db 90
[DISABLE]
"target"+10:
  db 00
</AssemblerScript>
    <Hotkeys><Hotkey><Action>Activate</Action><Keys><Key>18</Key><Key>112</Key></Keys><ID>0</ID></Hotkey></Hotkeys>
  </CheatEntry>
</CheatEntries></CheatTable>`);
    const { b, g } = backendFor(t);
    const { records } = await b.send({ method: 'list_records' }) as { records: Array<Record<string, unknown>> };
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty('hotkey');
    expect(await b.send({ method: 'set_hotkeys', params: { bindings: [], replace: [4] } })).toEqual({ ok: true, count: 0 });
    const [bindings, onPress] = g.hotkeys.set.mock.calls[0]! as [Array<{ id: number; accelerator: string }>, (id: number) => void];
    expect(bindings.map((x) => x.accelerator)).toEqual(['Alt+F1']);
    onPress(bindings[0]!.id);
    await vi.waitFor(() => expect(g.events).toHaveLength(1));
    expect(g.events[0]).toEqual({ type: 'hotkey', id: 4, ok: true, active: true });
  });

  it('a hotkey press toggles the record and posts the hotkey event', async () => {
    const { b, g } = backendFor(fixture('native-ok.CT'));
    await b.send({ method: 'set_hotkeys', params: { bindings: [], replace: [] } });
    const [bindings, onPress] = g.hotkeys.set.mock.calls[0]! as [Array<{ id: number }>, (id: number) => void];
    onPress(bindings[0]!.id);
    await vi.waitFor(() => expect(g.events).toHaveLength(1));
    expect(g.events[0]).toEqual({ type: 'hotkey', id: 5, ok: true, active: true });
    expect(g.enabled).toEqual(['Infinite ammo']);
    onPress(bindings[0]!.id);
    await vi.waitFor(() => expect(g.events).toHaveLength(2));
    expect(g.events[1]).toEqual({ type: 'hotkey', id: 5, ok: true, active: false });
    expect(g.disabled).toEqual(['Infinite ammo']);
  });

  it('set value hotkeys write their value', async () => {
    const { b, g } = backendFor(fixture('dropdown-hotkeys.CT'));
    g.setU32('0x405010', 100);
    await b.send({ method: 'set_hotkeys', params: { bindings: [] } });
    const [bindings, onPress] = g.hotkeys.set.mock.calls[0]! as [Array<{ id: number; accelerator: string }>, (id: number) => void];
    const press = async (accel: string, n: number) => {
      onPress(bindings.find((x) => x.accelerator === accel)!.id);
      await vi.waitFor(() => expect(g.events).toHaveLength(n));
    };
    await press('F3', 1);
    expect(g.writes.at(-1)).toEqual({ address: '0x405010', bytes: 'e7030000' });
    await press('Shift+PageUp', 2);
    expect(g.writes.at(-1)).toEqual({ address: '0x405010', bytes: 'f1030000' }); // 999 + 10
    await press('Alt+F1', 3);
    expect(g.events[2]).toEqual({ type: 'hotkey', id: 3, ok: true, active: true });
    expect(g.freezes.at(-1)).toEqual({ address: '0x405010', bytes: 'f1030000', cancelled: false });
    await press('Alt+F2', 4);
    expect(g.events[3]).toEqual({ type: 'hotkey', id: 3, ok: true, active: false });
  });

  it('shutdown disables everything newest first and clears hotkeys', async () => {
    const { b, g } = backendFor(fixture('symbol-children.CT'));
    await b.send({ method: 'set_active', params: { id: 10, active: true } });
    await b.send({ method: 'set_active', params: { id: 14, active: true } });
    g.setU32('0x9010', 5);
    await b.send({ method: 'set_active', params: { id: 11, active: true } });
    expect(await b.send({ method: 'shutdown' })).toEqual({ ok: true });
    expect(g.freezes.every((f) => f.cancelled)).toBe(true);
    expect(g.disabled).toEqual(['Inf health', 'Get player']);
    expect(g.hotkeys.clear).toHaveBeenCalled();
    const { states } = await b.send({ method: 'refresh' }) as { states: Array<{ a: boolean }> };
    expect(states.some((s) => s.a)).toBe(false);
  });

  it('load_table switches everything off and loads the new table', async () => {
    const loadCompiled = vi.fn(async () => fixture('native-ok.CT'));
    const g = fakeGame();
    const { b } = backendFor(fixture('symbol-children.CT'), g, { loadCompiled });
    await b.send({ method: 'set_active', params: { id: 10, active: true } });
    expect(await b.send({ method: 'load_table', params: { path: '/tmp/x.CT' } })).toEqual({ ok: true });
    expect(loadCompiled).toHaveBeenCalledWith('/tmp/x.CT');
    expect(g.disabled).toEqual(['Get player']);
    expect(g.hotkeys.clear).toHaveBeenCalled();
    const { records } = await b.send({ method: 'list_records' }) as { records: Array<{ id: number }> };
    expect(records.map((r) => r.id)).toEqual([0, 1, 2, 5, 6]);
  });

  it('unknown methods are refused', async () => {
    const { b } = backendFor(fixture('native-ok.CT'));
    expect(await b.send({ method: 'scan_first' })).toEqual({ ok: false, error: 'unknown method: scan_first' });
  });
});
