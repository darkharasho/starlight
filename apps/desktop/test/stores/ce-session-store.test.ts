import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStart = vi.fn();
const mockSetActive = vi.fn();
const mockCall = vi.fn();
const mockRetry = vi.fn();
const mockLaunch = vi.fn();
const mockFind = vi.fn();
const mockUpdateConfig = vi.fn();
const mockAllow = vi.fn();
const mockDisable = vi.fn();
const mockAgentStop = vi.fn();
vi.mock('../../src/renderer/ipc-client.js', () => ({
  starlight: () => ({
    ceSessionStart: mockStart, ceSessionEnd: vi.fn().mockResolvedValue({ ok: true }), ceSessionSetActive: mockSetActive, ceSessionCall: mockCall,
    ceSessionRetry: mockRetry, launchGame: mockLaunch, findGameProcess: mockFind, updateConfig: mockUpdateConfig, allowMemoryAccess: mockAllow,
    userCheatsDisableAll: mockDisable, agentStop: mockAgentStop,
  }),
  api: () => ({}),
}));
import { useCeSessionStore, playTiming } from '../../src/renderer/stores/ce-session-store.js';
import { useConfigStore } from '../../src/renderer/stores/config-store.js';
import { useLibraryStore } from '../../src/renderer/stores/library-store.js';

beforeEach(() => {
  mockStart.mockReset();
  mockSetActive.mockReset();
  mockCall.mockReset();
  mockCall.mockResolvedValue({ states: [] });
  mockRetry.mockReset(); mockLaunch.mockReset(); mockFind.mockReset(); mockUpdateConfig.mockReset(); mockAllow.mockReset();
  Object.assign(playTiming, { pollMs: 2, timeoutMs: 200 });
  useConfigStore.setState({ config: { preferences: { cheatHotkeys: true }, cheatHotkeys: {} } as never });
  useLibraryStore.setState({ games: [] });
  useCeSessionStore.setState({
    sessionId: null,
    starting: false,
    startError: null,
    startReason: null,
    allowingAccess: false,
    records: [],
    attached: false,
    proton: false,
    notRunning: false,
    needsPicker: false,
    launch: null,
    lastReq: null,
    hiddenIds: [],
    recordErrors: {},
    retries: 0,
    retrying: false,
  });
});

describe('ce-session-store auto-attach', () => {
  it('sets notRunning when the game is not running', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'game not running', reason: 'not-running' });
    const ok = await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' } });
    expect(ok).toBe(false);
    expect(useCeSessionStore.getState().notRunning).toBe(true);
  });

  it('sets needsPicker when the match is ambiguous', async () => {
    mockStart.mockResolvedValue({ ok: true, sessionId: 's', records: [], proton: true, attached: false, needsPicker: true });
    await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' } });
    expect(useCeSessionStore.getState().needsPicker).toBe(true);
  });
});

describe('ce-session-store tables, errors and values', () => {
  const okStart = {
    ok: true, sessionId: 's1', proton: true, attached: true, needsPicker: false,
    records: [
      { id: 1, name: 'God Mode', isActive: false, isGroupHeader: false, kind: 'script', depth: 0 },
      { id: 2, name: 'Gold', isActive: false, isGroupHeader: false, kind: 'value', depth: 1, value: '??' },
    ],
    tables: [{ id: 30, filename: 'new.CT', url: 'u30', topicUrl: 't' }, { id: 10, filename: 'old.CT', url: 'u10', topicUrl: 't' }],
    tableId: 30,
    process: { pid: 99, name: 'Game.exe' },
  };

  it('keeps the table list and the resolved process from a successful start', async () => {
    mockStart.mockResolvedValue(okStart);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game', title: 'Game' });
    const s = useCeSessionStore.getState();
    expect(s.tables.map((t) => t.id)).toEqual([30, 10]);
    expect(s.tableId).toBe(30);
    expect(s.attachedTo).toEqual({ pid: 99, name: 'Game.exe' });
    expect(s.title).toBe('Game');
  });

  it('switchTable restarts on the same process with the chosen table', async () => {
    mockStart.mockResolvedValue(okStart);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockStart.mockResolvedValue({ ...okStart, sessionId: 's2', tableId: 10 });
    await useCeSessionStore.getState().switchTable(10);
    expect(mockStart).toHaveBeenLastCalledWith(expect.objectContaining({ tableId: 10, pid: 99, processName: 'Game.exe', cacheKey: 'game' }));
    expect(useCeSessionStore.getState().tableId).toBe(10);
  });

  it('clears a previous session when a start fails', async () => {
    mockStart.mockResolvedValue(okStart);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockStart.mockResolvedValue({ ok: false, error: 'no .CT attachment found' });
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game', tableId: 10 });
    const s = useCeSessionStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.startError).toBe('no .CT attachment found');
  });

  it('records a failed toggle against that cheat, and clears it on the next attempt', async () => {
    mockStart.mockResolvedValue(okStart);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockSetActive.mockResolvedValue({ ok: false, error: 'Error: Not all results found' });
    await useCeSessionStore.getState().setActive(1, true);
    expect(useCeSessionStore.getState().recordErrors[1]).toBe('Error: Not all results found');
    expect(useCeSessionStore.getState().records[0]!.isActive).toBe(false);
    mockSetActive.mockResolvedValue({ ok: true });
    await useCeSessionStore.getState().setActive(1, true);
    expect(useCeSessionStore.getState().recordErrors[1]).toBeUndefined();
    expect(useCeSessionStore.getState().records[0]!.isActive).toBe(true);
  });

  it('refresh folds live on/off states and values back into the records', async () => {
    mockStart.mockResolvedValue(okStart);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockCall.mockResolvedValue({ states: [{ id: 1, a: true }, { id: 2, a: false, v: '1500' }] });
    await useCeSessionStore.getState().refresh();
    const [god, gold] = useCeSessionStore.getState().records;
    expect(god!.isActive).toBe(true);
    expect(gold!.value).toBe('1500');
  });

  it('setValue writes through and shows the value Cheat Engine read back', async () => {
    mockStart.mockResolvedValue(okStart);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockCall.mockResolvedValue({ ok: true, value: '9999' });
    await useCeSessionStore.getState().setValue(2, '9999');
    expect(mockCall).toHaveBeenCalledWith({ sessionId: 's1', method: 'set_value', params: { id: 2, value: '9999' } });
    expect(useCeSessionStore.getState().records[1]!.value).toBe('9999');
  });

  it('setSpeed keeps the old speed and reports why when it fails', async () => {
    mockStart.mockResolvedValue(okStart);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockCall.mockResolvedValue({ ok: true, speed: 2 });
    await useCeSessionStore.getState().setSpeed(2);
    expect(useCeSessionStore.getState().speed).toBe(2);
    mockCall.mockResolvedValue({ ok: false, error: 'not attached to a game process' });
    await useCeSessionStore.getState().setSpeed(4);
    expect(useCeSessionStore.getState()).toMatchObject({ speed: 2, speedError: 'not attached to a game process' });
  });
});

describe('ce-session-store Play', () => {
  const req = { sources: ['t'], cacheKey: 'game', title: 'Game', game: { id: 'g', name: 'Game' }, launch: { source: 'steam' as const, appId: '440' } };
  const attached = {
    ok: true, sessionId: 's1', proton: true, attached: true, running: true, records: [], tables: [], tableId: 30,
    hiddenIds: [], prereqErrors: {}, verdict: 'works', attempts: [], process: { pid: 55, name: 'Game.exe' },
  };

  it('launches the game, waits for its process, lets it load, then attaches by pid', async () => {
    mockFind.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ pid: 55, name: 'Game.e' });
    mockLaunch.mockResolvedValue({ ok: true });
    mockStart.mockResolvedValue(attached);
    const phases: (string | undefined)[] = [];
    const unsub = useCeSessionStore.subscribe((s) => { if (phases[phases.length - 1] !== s.launch?.phase) phases.push(s.launch?.phase); });
    expect(await useCeSessionStore.getState().play(req)).toBe(true);
    unsub();
    expect(phases).toEqual(['launching', 'waiting', undefined]);
    expect(mockLaunch).toHaveBeenCalledWith({ source: 'steam', appId: '440' });
    // Only the pid goes over: the process list's name can be truncated.
    const sent = mockStart.mock.calls[0]![0];
    expect(sent).toMatchObject({ pid: 55, cacheKey: 'game' });
    expect(sent.processName).toBeUndefined();
    expect(sent).not.toHaveProperty('launch');
    expect(useCeSessionStore.getState()).toMatchObject({ attached: true, launch: null });
  });

  it('attaches straight away when the game is already running, without launching it again', async () => {
    mockFind.mockResolvedValue({ pid: 55, name: 'Game.exe' });
    mockStart.mockResolvedValue(attached);
    expect(await useCeSessionStore.getState().play(req)).toBe(true);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('says so when the launcher refuses, or the game never appears', async () => {
    mockFind.mockResolvedValue(null);
    mockLaunch.mockResolvedValue({ ok: false, error: 'no handler for steam://' });
    expect(await useCeSessionStore.getState().play(req)).toBe(false);
    expect(useCeSessionStore.getState()).toMatchObject({ launch: null, startError: 'no handler for steam://' });

    mockLaunch.mockResolvedValue({ ok: true });
    Object.assign(playTiming, { timeoutMs: 20 });
    expect(await useCeSessionStore.getState().play(req)).toBe(false);
    expect(useCeSessionStore.getState().startError).toMatch(/didn't start/);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('cancelling stops the wait and never attaches', async () => {
    mockFind.mockResolvedValue(null);
    mockLaunch.mockResolvedValue({ ok: true });
    const p = useCeSessionStore.getState().play(req);
    await new Promise((r) => setTimeout(r, 10));
    useCeSessionStore.getState().cancelPlay();
    expect(await p).toBe(false);
    expect(useCeSessionStore.getState().launch).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('finds the installed copy from the library when the request was built before the scan finished', async () => {
    useLibraryStore.setState({ games: [{ source: 'steam', appId: '999', name: 'Game', installDir: '/x' }] });
    mockFind.mockResolvedValueOnce(null).mockResolvedValue({ pid: 55, name: 'Game.exe' });
    mockLaunch.mockResolvedValue({ ok: true });
    mockStart.mockResolvedValue(attached);
    const { launch: _l, ...noLaunch } = req;
    expect(await useCeSessionStore.getState().play(noLaunch)).toBe(true);
    expect(mockLaunch).toHaveBeenCalledWith({ source: 'steam', appId: '999' });
  });
});

describe('ce-session-store tables that prepare themselves', () => {
  const MASTER = [
    { id: 1, name: 'Enable', isActive: true, isGroupHeader: false, kind: 'script', depth: 0, opts: '[moHideChildren]' },
    { id: 2, name: 'God Mode', isActive: false, isGroupHeader: false, kind: 'script', depth: 1 },
    { id: 3, name: 'Ammo', isActive: false, isGroupHeader: false, kind: 'script', depth: 1, hotkey: 'F3' },
  ];
  const started = {
    ok: true, sessionId: 's1', proton: true, attached: true, running: true, records: MASTER,
    tables: [{ id: 30, filename: 'new.CT', url: 'u', topicUrl: 't' }], tableId: 30,
    hiddenIds: [1], prereqErrors: {}, verdict: 'works', attempts: [{ id: 30, filename: 'new.CT', verdict: 'works' }],
    process: { pid: 9, name: 'Game.exe' },
  };

  it('keeps what the session switched on, and gives the cheats their hotkeys', async () => {
    mockStart.mockResolvedValue(started);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    expect(useCeSessionStore.getState()).toMatchObject({ hiddenIds: [1], verdict: 'works' });
    await vi.waitFor(() => expect(mockCall).toHaveBeenCalledWith({
      sessionId: 's1', method: 'set_hotkeys',
      // The hidden prerequisite gets no key; Ammo keeps the table's own F3.
      params: { bindings: [{ id: 2, keys: [0x61] }], replace: [] },
    }));
  });

  it('shows why a prerequisite failed against that record', async () => {
    mockStart.mockResolvedValue({ ...started, hiddenIds: [], verdict: 'broken', prereqErrors: { 1: 'No hook installed.' } });
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    expect(useCeSessionStore.getState().recordErrors[1]).toBe('No hook installed.');
  });

  it('retry swaps in whatever table now matches', async () => {
    mockStart.mockResolvedValue({ ...started, hiddenIds: [], verdict: 'broken', prereqErrors: { 1: 'No hook installed.' } });
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockRetry.mockResolvedValue({ ok: true, records: MASTER, tableId: 10, hiddenIds: [1], prereqErrors: {}, verdict: 'works', attempts: [] });
    await useCeSessionStore.getState().retry({ auto: true });
    expect(useCeSessionStore.getState()).toMatchObject({ verdict: 'works', tableId: 10, hiddenIds: [1], recordErrors: {}, retries: 1, retrying: false });
  });

  it('a hotkey press in the game shows up on the cheat', async () => {
    mockStart.mockResolvedValue(started);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    useCeSessionStore.getState().applyHotkey({ recordId: 2, ok: true, active: true });
    expect(useCeSessionStore.getState().records[1]!.isActive).toBe(true);
    useCeSessionStore.getState().applyHotkey({ recordId: 2, ok: false, active: false, error: 'No hook installed.' });
    expect(useCeSessionStore.getState().records[1]!.isActive).toBe(false);
    expect(useCeSessionStore.getState().recordErrors[2]).toBe('No hook installed.');
  });

  it('remembers a chosen hotkey per game and replaces the table\'s own', async () => {
    mockStart.mockResolvedValue(started);
    await useCeSessionStore.getState().start({ sources: ['t'], cacheKey: 'game' });
    mockUpdateConfig.mockResolvedValue({ preferences: { cheatHotkeys: true }, cheatHotkeys: { game: { Ammo: 'Ctrl+F9' } } });
    await useCeSessionStore.getState().setHotkey('Ammo', 'Ctrl+F9');
    expect(mockUpdateConfig).toHaveBeenCalledWith({ patch: { cheatHotkeys: { game: { Ammo: 'Ctrl+F9' } } } });
    expect(mockCall).toHaveBeenLastCalledWith({
      sessionId: 's1', method: 'set_hotkeys',
      params: { bindings: expect.arrayContaining([{ id: 2, keys: [0x61] }, { id: 3, keys: [0x11, 0x78] }]), replace: [3] },
    });
  });
});

describe('ce-session-store game exit', () => {
  it('goes back to the game\'s cheat list (not attached) when the game closes', async () => {
    mockStart.mockResolvedValueOnce({ ok: true, sessionId: 's1', records: [], proton: true, attached: true, process: { pid: 7, name: 'G.exe' } });
    await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' }, pid: 7, processName: 'G.exe' });
    mockStart.mockResolvedValueOnce({ ok: true, sessionId: 's2', records: [], proton: false, attached: false, running: false });
    await useCeSessionStore.getState().gameExited('s1');
    expect(mockStart).toHaveBeenLastCalledWith({ source: 'x', cacheKey: 'k', game: { id: 'g', name: 'G' } });
    expect(useCeSessionStore.getState()).toMatchObject({ sessionId: 's2', attached: false, running: false });
  });

  it('ignores the exit of a session that was already replaced', async () => {
    mockStart.mockResolvedValueOnce({ ok: true, sessionId: 's3', records: [], proton: true, attached: true });
    await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', pid: 7 });
    await useCeSessionStore.getState().gameExited('old');
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(useCeSessionStore.getState().sessionId).toBe('s3');
  });
});

describe('ce-session-store one game at a time', () => {
  const A = { source: 'a', cacheKey: 'game-a', title: 'Game A', game: { id: 'a', name: 'Game A' } };
  const B = { source: 'b', cacheKey: 'game-b', title: 'Game B', game: { id: 'b', name: 'Game B' } };

  async function connectA(): Promise<void> {
    mockStart.mockResolvedValueOnce({ ok: true, sessionId: 'sa', records: [], proton: true, attached: true, process: { pid: 7, name: 'A.exe' } });
    await useCeSessionStore.getState().start({ ...A, pid: 7 });
  }

  it('keeps the connected game and says why when another game is opened', async () => {
    await connectA();
    const ok = await useCeSessionStore.getState().start(B);
    expect(ok).toBe(false);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(useCeSessionStore.getState()).toMatchObject({ sessionId: 'sa', attached: true, title: 'Game A' });
    expect(useCeSessionStore.getState().startError).toBe('Game A is still connected. Quit it to use cheats in Game B.');
  });

  it('just shows the connected game when it is opened again, without reconnecting', async () => {
    await connectA();
    const ok = await useCeSessionStore.getState().start(A);
    expect(ok).toBe(true);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(useCeSessionStore.getState()).toMatchObject({ sessionId: 'sa', attached: true, startError: null });
  });

  it('does not start another game while one is still launching', async () => {
    useCeSessionStore.setState({ launch: { phase: 'waiting', title: 'Game A' }, lastReq: A, title: 'Game A' });
    const ok = await useCeSessionStore.getState().start(B);
    expect(ok).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
    expect(useCeSessionStore.getState().launch).toMatchObject({ title: 'Game A' });
  });

  it('switches freely between games that are not connected', async () => {
    mockStart.mockResolvedValueOnce({ ok: true, sessionId: 'pa', records: [], proton: false, attached: false, running: false });
    await useCeSessionStore.getState().start(A);
    mockStart.mockResolvedValueOnce({ ok: true, sessionId: 'pb', records: [], proton: false, attached: false, running: false });
    expect(await useCeSessionStore.getState().start(B)).toBe(true);
    expect(useCeSessionStore.getState().sessionId).toBe('pb');
  });
});

describe('ce-session-store native game permission', () => {
  const req = { cacheKey: 'k', source: 'https://x/t.CT', pid: 42 };

  it('keeps the reason a start needs permission, then attaches again once it is allowed', async () => {
    mockStart.mockResolvedValueOnce({ ok: false, error: 'needs permission', reason: 'ptrace' });
    await useCeSessionStore.getState().start(req);
    expect(useCeSessionStore.getState().startReason).toBe('ptrace');

    mockAllow.mockResolvedValueOnce({ ok: true });
    mockStart.mockResolvedValueOnce({ ok: true, sessionId: 's1', records: [], proton: false, attached: true });
    await useCeSessionStore.getState().allowMemoryAccess();
    expect(mockStart).toHaveBeenLastCalledWith(expect.objectContaining({ pid: 42 }));
    expect(useCeSessionStore.getState()).toMatchObject({ sessionId: 's1', startError: null, startReason: null, allowingAccess: false });
  });

  it('leaves the request up when the password prompt is dismissed', async () => {
    mockStart.mockResolvedValueOnce({ ok: false, error: 'needs permission', reason: 'ptrace' });
    await useCeSessionStore.getState().start(req);
    mockAllow.mockResolvedValueOnce({ ok: false, cancelled: true, error: 'no' });
    await useCeSessionStore.getState().allowMemoryAccess();
    expect(useCeSessionStore.getState()).toMatchObject({ startError: 'needs permission', startReason: 'ptrace' });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('shows why granting failed', async () => {
    mockStart.mockResolvedValueOnce({ ok: false, error: 'needs permission', reason: 'ptrace' });
    await useCeSessionStore.getState().start(req);
    mockAllow.mockResolvedValueOnce({ ok: false, error: 'setcap failed: boom' });
    await useCeSessionStore.getState().allowMemoryAccess();
    expect(useCeSessionStore.getState()).toMatchObject({ startError: 'setcap failed: boom', startReason: null });
  });
});

describe('ce-session-store engine', () => {
  const ok = { ok: true, sessionId: 's', records: [], proton: true, attached: true, running: true, tables: [], hiddenIds: [], prereqErrors: {} };

  it('takes engine and holders from the start result and from session:engine', async () => {
    mockStart.mockResolvedValue({ ...ok, engine: 'starlightd', holders: ['user-cheats'] });
    await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k' });
    expect(useCeSessionStore.getState().engine).toBe('starlightd');
    expect(useCeSessionStore.getState().holders).toEqual(['user-cheats']);
    useCeSessionStore.getState().setEngine('other', 'ce', []);
    expect(useCeSessionStore.getState().engine).toBe('starlightd');
    useCeSessionStore.getState().setEngine('s', 'ce', []);
    expect(useCeSessionStore.getState().engine).toBe('ce');
  });

  it('useTableInstead disables user cheats, stops the agent, then starts again', async () => {
    mockStart.mockResolvedValue({ ...ok, engine: 'starlightd', holders: ['agent'] });
    mockDisable.mockResolvedValue(undefined); mockAgentStop.mockResolvedValue(undefined);
    await useCeSessionStore.getState().start({ source: 'x', cacheKey: 'k', pid: 9 });
    mockStart.mockClear();
    mockStart.mockResolvedValue({ ...ok, engine: 'ce', holders: [] });
    await useCeSessionStore.getState().useTableInstead();
    expect(mockDisable).toHaveBeenCalledWith({ pid: 9 });
    expect(mockAgentStop).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'k', pid: 9 }));
    expect(useCeSessionStore.getState().engine).toBe('ce');
  });
});
