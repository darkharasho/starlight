import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CeSessionView, gameCandidates, looksStale } from '../../src/renderer/components/ce/CeSessionView.js';
import { useCeSessionStore } from '../../src/renderer/stores/ce-session-store.js';
import { useConfigStore } from '../../src/renderer/stores/config-store.js';
import { useLibraryStore } from '../../src/renderer/stores/library-store.js';
import { setStarlightApi } from '../../src/renderer/ipc-client.js';
import { useUserCheatsStore } from '../../src/renderer/stores/user-cheats-store.js';
import type { StarlightApi } from '../../src/shared/ipc.js';

const call = vi.fn();
const setActive = vi.fn();
const start = vi.fn();
const retry = vi.fn();
const launchGame = vi.fn();
const findGameProcess = vi.fn();
const updateConfig = vi.fn();

const TABLES = [
  { id: 30, filename: 'Game_v2.CT', url: 'u30', topicUrl: 't' },
  { id: 10, filename: 'Game_v1.CT', url: 'u10', topicUrl: 't' },
];

function seed(over: Partial<ReturnType<typeof useCeSessionStore.getState>> = {}): void {
  useCeSessionStore.setState({
    sessionId: 's1', title: '9 Kings', attached: true, proton: true, starting: false, startError: null,
    attachedTo: { pid: 42, name: '9Kings.exe' }, pending: new Set(), recordErrors: {},
    tables: TABLES, tableId: 30, tableError: null, speed: 1, speedError: null,
    hiddenIds: [], verdict: 'unknown', attempts: [], running: true, launch: null, progress: null, retrying: false, retries: 0,
    lastReq: { sources: ['t'], cacheKey: '9kings', title: '9 Kings', game: { id: '9-kings', name: '9 Kings' }, launch: { source: 'steam', appId: '2784470' } },
    records: [
      { id: 1, name: 'Player', isActive: false, isGroupHeader: true, kind: 'header', depth: 0 },
      { id: 2, name: 'Infinite Money', isActive: false, isGroupHeader: false, kind: 'script', depth: 1 },
      { id: 3, name: 'Gold', isActive: false, isGroupHeader: false, kind: 'value', depth: 2, value: '250' },
    ],
    ...over,
  });
}

const CONFIG = { preferences: { cheatHotkeys: true }, cheatHotkeys: {} } as never;

beforeEach(() => {
  call.mockReset(); setActive.mockReset(); start.mockReset(); retry.mockReset(); launchGame.mockReset(); findGameProcess.mockReset(); updateConfig.mockReset();
  call.mockResolvedValue({ states: [] });
  updateConfig.mockImplementation(async ({ patch }: { patch: { cheatHotkeys?: Record<string, Record<string, string | null>>; preferences?: { cheatHotkeys?: boolean } } }) => ({
    preferences: { cheatHotkeys: patch.preferences?.cheatHotkeys ?? true },
    cheatHotkeys: patch.cheatHotkeys ?? {},
  }));
  setStarlightApi({
    ceSessionCall: call, ceSessionSetActive: setActive, ceSessionStart: start, ceSessionRetry: retry,
    launchGame, findGameProcess, updateConfig,
    ceSessionEnd: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as StarlightApi);
  useConfigStore.setState({ config: CONFIG });
  useLibraryStore.setState({ games: [] });
  useUserCheatsStore.setState({ key: null, pid: null, items: [], pending: new Set(), errors: {}, confirm: null });
  seed();
});

describe('CeSessionView', () => {
  it('shows the game, the loaded table and what it is attached to', () => {
    render(<CeSessionView processes={[]} />);
    expect(screen.getByRole('heading', { name: '9 Kings' })).toBeInTheDocument();
    expect(screen.getByText('1 cheat')).toBeInTheDocument();
    expect(screen.getByText(/Connected to 9Kings\.exe/)).toBeInTheDocument();
  });

  it('shows a failed cheat\'s own error and points at other tables when it is a version mismatch', async () => {
    setActive.mockResolvedValue({ ok: false, error: 'No hook installed.\naddrA: 0 matches (check the AOB)' });
    render(<CeSessionView processes={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Infinite Money: Off' }));
    expect(await screen.findByText(/addrA: 0 matches/)).toBeInTheDocument();
    expect(screen.getByText(/made for a different version of the game/)).toBeInTheDocument();
    expect(screen.getByText(/Try another table/)).toBeInTheDocument();
  });

  it('lets the user switch to another table', async () => {
    start.mockResolvedValue({ ok: true, sessionId: 's2', records: [], proton: true, attached: true, running: true, tables: TABLES, tableId: 10, hiddenIds: [], prereqErrors: {}, verdict: 'unknown', attempts: [] });
    render(<CeSessionView processes={[]} />);
    await userEvent.selectOptions(screen.getByLabelText('Table'), 'Game_v1.CT');
    // An explicit pick: loaded as is, on the same process.
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ tableId: 10, pid: 42, cacheKey: '9kings' }));
  });

  it('edits a value record on Enter', async () => {
    call.mockImplementation(async (req: { method: string }) => (req.method === 'set_value' ? { ok: true, value: '9999' } : { states: [] }));
    seed({ records: [{ id: 3, name: 'Gold', isActive: false, isGroupHeader: false, kind: 'value', depth: 0, value: '250' }] });
    render(<CeSessionView processes={[]} />);
    const input = screen.getByLabelText('Value of Gold');
    expect(input).toHaveValue('250');
    await userEvent.clear(input);
    await userEvent.type(input, '9999{Enter}');
    expect(call).toHaveBeenCalledWith({ sessionId: 's1', method: 'set_value', params: { id: 3, value: '9999' } });
    expect(await screen.findByDisplayValue('9999')).toBeInTheDocument();
  });

  it('value records freeze rather than switch on, and unreadable values say so', () => {
    seed({ records: [{ id: 3, name: 'Gold', isActive: false, isGroupHeader: false, kind: 'value', depth: 0, value: '??' }] });
    render(<CeSessionView processes={[]} />);
    expect(screen.getByRole('button', { name: 'Gold: Freeze' })).toBeInTheDocument();
    expect(screen.getByLabelText('Value of Gold')).toHaveAttribute('placeholder', 'not readable yet');
  });

  it('sets game speed', async () => {
    call.mockImplementation(async (req: { method: string }) => (req.method === 'set_speed' ? { ok: true, speed: 2 } : { states: [] }));
    render(<CeSessionView processes={[]} />);
    const speed = within(screen.getByRole('group', { name: 'Game speed' }));
    await userEvent.click(speed.getByRole('button', { name: '2×' }));
    expect(call).toHaveBeenCalledWith({ sessionId: 's1', method: 'set_speed', params: { speed: 2 } });
    expect(await speed.findByRole('button', { name: '2×', pressed: true })).toBeInTheDocument();
  });

  it('groups cheats under tidy section titles and tucks options away until their cheat is on', () => {
    render(<CeSessionView processes={[]} />);
    expect(screen.getByRole('heading', { name: 'Player' })).toBeInTheDocument();
    expect(screen.getByText('1 option appears when on')).toBeInTheDocument();
    expect(screen.queryByLabelText('Value of Gold')).not.toBeInTheDocument();
    expect(screen.getByText('1 cheat')).toBeInTheDocument();
  });

  it('hides the prerequisite Starlight switched on and shows what was under it', () => {
    seed({
      hiddenIds: [1], verdict: 'works',
      records: [
        { id: 1, name: '→ Enable (Auto-Attach Game Process)', isActive: true, isGroupHeader: false, kind: 'script', depth: 0, opts: '[moHideChildren]' },
        { id: 2, name: 'Invulnerable ()->', isActive: false, isGroupHeader: false, kind: 'script', depth: 1 },
        { id: 3, name: '⚡ Discord', isActive: false, isGroupHeader: false, kind: 'script', depth: 0 },
      ],
    });
    render(<CeSessionView processes={[]} />);
    expect(screen.queryByText(/Enable \(Auto-Attach/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Discord/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invulnerable: Off' })).toBeEnabled();
  });

  it('says which table it settled on when newer ones were passed over', () => {
    seed({
      tableId: 10, verdict: 'works',
      attempts: [{ id: 30, filename: 'Game_v2.CT', verdict: 'broken' }, { id: 10, filename: 'Game_v1.CT', verdict: 'works' }],
    });
    render(<CeSessionView processes={[]} />);
    expect(screen.getByText(/first table Starlight could confirm works/)).toHaveTextContent('Game_v1.CT');
    expect(within(screen.getByLabelText('Table')).getByRole('option', { name: 'Game_v2.CT (newest) ✗' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('Table')).getByRole('option', { name: 'Game_v1.CT ✓' })).toBeInTheDocument();
  });

  it('when no table matches, says so and lets the user look again', async () => {
    retry.mockResolvedValue({ ok: true, records: [], tableId: 30, hiddenIds: [], prereqErrors: {}, verdict: 'works', attempts: [] });
    seed({ verdict: 'broken', attempts: [{ id: 30, filename: 'Game_v2.CT', verdict: 'broken' }, { id: 10, filename: 'Game_v1.CT', verdict: 'broken' }] });
    render(<CeSessionView processes={[]} />);
    expect(screen.getByText(/None of the 2 tables tried match/)).toBeInTheDocument();
    expect(screen.getByText(/Starlight keeps trying/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('gives the first cheats numpad hotkeys and shows the table author\'s own', () => {
    seed({ records: [
      { id: 1, name: 'God Mode', isActive: false, isGroupHeader: false, kind: 'script', depth: 0 },
      { id: 2, name: 'Infinite Ammo', isActive: false, isGroupHeader: false, kind: 'script', depth: 0, hotkey: 'F2' },
    ] });
    render(<CeSessionView processes={[]} />);
    expect(screen.getByRole('button', { name: 'Hotkey for God Mode: Num 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hotkey for Infinite Ammo: F2' })).toBeInTheDocument();
  });

  it('rebinds a cheat\'s hotkey from a key press, and Backspace removes it', async () => {
    seed({ records: [{ id: 1, name: 'God Mode', isActive: false, isGroupHeader: false, kind: 'script', depth: 0 }] });
    render(<CeSessionView processes={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hotkey for God Mode: Num 1' }));
    expect(screen.getByText('press a key…')).toBeInTheDocument();
    await userEvent.keyboard('{F6}');
    expect(updateConfig).toHaveBeenCalledWith({ patch: { cheatHotkeys: { '9kings': { 'God Mode': 'F6' } } } });
    expect(await screen.findByRole('button', { name: 'Hotkey for God Mode: F6' })).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith({ sessionId: 's1', method: 'set_hotkeys', params: { bindings: [{ id: 1, keys: [0x75] }], replace: [] } });

    await userEvent.click(screen.getByRole('button', { name: 'Hotkey for God Mode: F6' }));
    await userEvent.keyboard('{Backspace}');
    expect(updateConfig).toHaveBeenLastCalledWith({ patch: { cheatHotkeys: { '9kings': { 'God Mode': null } } } });
    expect(await screen.findByRole('button', { name: 'Hotkey for God Mode: none' })).toBeInTheDocument();
  });

  it('hotkeys can be switched off altogether', async () => {
    seed({ records: [{ id: 1, name: 'God Mode', isActive: false, isGroupHeader: false, kind: 'script', depth: 0 }] });
    render(<CeSessionView processes={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hotkeys on' }));
    expect(updateConfig).toHaveBeenCalledWith({ patch: { preferences: { cheatHotkeys: false } } });
    expect(await screen.findByRole('button', { name: 'Hotkeys off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hotkey for God Mode/ })).not.toBeInTheDocument();
    expect(call).toHaveBeenCalledWith({ sessionId: 's1', method: 'set_hotkeys', params: { bindings: [], replace: [] } });
  });

  it('filters long lists', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, name: i === 3 ? 'Infinite Stamina' : `Cheat ${i + 1}`, isActive: false, isGroupHeader: false, kind: 'script' as const, depth: 0 }));
    seed({ records: many });
    render(<CeSessionView processes={[]} />);
    await userEvent.type(screen.getByLabelText('Filter cheats'), 'stam');
    expect(screen.getByRole('button', { name: 'Infinite Stamina: Off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cheat 1: Off' })).not.toBeInTheDocument();
  });

  describe('before the game is attached', () => {
    const notAttached = { attached: false, attachedTo: null, running: false };

    it('offers Play first, shows every cheat, and keeps them disabled', () => {
      seed(notAttached);
      render(<CeSessionView processes={[]} />);
      expect(screen.getByRole('button', { name: '▶ Play' })).toBeInTheDocument();
      expect(screen.getByText(/Starts the game and attaches/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Infinite Money: Off' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Gold: Freeze' })).toBeDisabled();   // options shown in the preview
      expect(screen.queryByRole('group', { name: 'Game speed' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('Play launches the game, waits for it and attaches', async () => {
      const { playTiming } = await import('../../src/renderer/stores/ce-session-store.js');
      Object.assign(playTiming, { pollMs: 5 });
      findGameProcess.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ pid: 77, name: '9Kings.exe' });
      launchGame.mockResolvedValue({ ok: true });
      start.mockResolvedValue({ ok: true, sessionId: 's2', records: [], proton: true, attached: true, running: true, tables: TABLES, tableId: 30, hiddenIds: [], prereqErrors: {}, verdict: 'works', attempts: [], process: { pid: 77, name: '9Kings.exe' } });
      seed(notAttached);
      render(<CeSessionView processes={[]} />);
      await userEvent.click(screen.getByRole('button', { name: '▶ Play' }));
      expect(await screen.findByText(/Connected to 9Kings\.exe/)).toBeInTheDocument();
      expect(launchGame).toHaveBeenCalledWith({ source: 'steam', appId: '2784470' });
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ pid: 77, cacheKey: '9kings' }));
      expect(start.mock.calls[0]![0]).not.toHaveProperty('tableId');   // Starlight picks the table
    });

    it('shows what Play is doing and can be cancelled', async () => {
      seed({ ...notAttached, launch: { phase: 'waiting', title: '9 Kings' } });
      render(<CeSessionView processes={[]} />);
      expect(screen.getByText('Waiting for 9 Kings to start…')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: '▶ Play' })).toBeInTheDocument();
    });

    it('the arrow next to Play attaches to a game that is already running', async () => {
      start.mockResolvedValue({ ok: false, error: 'x' });
      seed(notAttached);
      render(<CeSessionView processes={[{ pid: 7, name: '9Kings.exe' }, { pid: 8, name: 'bash' }]} />);
      await userEvent.click(screen.getByRole('button', { name: 'Other ways to connect' }));
      const menu = screen.getByRole('menu', { name: 'Attach to a running game' });
      expect(within(menu).queryByText('bash')).not.toBeInTheDocument();
      await userEvent.click(within(menu).getByRole('menuitem', { name: /9Kings\.exe/ }));
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ pid: 7, processName: '9Kings.exe' }));
      expect(launchGame).not.toHaveBeenCalled();
    });

    it('a game that isn\'t in the library can only be attached to', async () => {
      seed({ ...notAttached, lastReq: { sources: ['t'], cacheKey: 'x', title: 'Mystery', game: { id: 'm', name: 'Mystery' } } });
      render(<CeSessionView processes={[{ pid: 7, name: 'Mystery.exe' }]} />);
      expect(screen.queryByRole('button', { name: '▶ Play' })).not.toBeInTheDocument();
      expect(screen.getByText(/isn’t in your library/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Attach to running game ▾' }));
      expect(screen.getByRole('menuitem', { name: /Mystery\.exe/ })).toBeInTheDocument();
    });
  });

  it('a game with no table opens straight on the memory scanner', () => {
    seed({ records: [], tables: [], tableId: null });
    render(<CeSessionView processes={[]} />);
    expect(screen.getByText(/No table for this game/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'First scan' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('CeSessionView with starlightd', () => {
  const disableAll = vi.fn();
  const agentStop = vi.fn();
  const MINE = [{ cheat: { id: 'god', name: 'God mode', type: 'toggle', valueType: 'int32', address: {} }, active: true, verify: null }];
  function api(over: Record<string, unknown> = {}): void {
    setStarlightApi({
      ceSessionCall: call, ceSessionSetActive: setActive, ceSessionStart: start, ceSessionRetry: retry,
      launchGame, findGameProcess, updateConfig, userCheatsDisableAll: disableAll, agentStop,
      userCheatsList: vi.fn().mockResolvedValue(MINE),
      ceSessionEnd: vi.fn().mockResolvedValue({ ok: true }),
      ...over,
    } as unknown as StarlightApi);
  }
  beforeEach(() => {
    disableAll.mockReset().mockResolvedValue(undefined); agentStop.mockReset().mockResolvedValue(undefined);
    start.mockResolvedValue({ ok: true, sessionId: 's2', records: [], proton: true, attached: true, running: true, tables: TABLES, tableId: 30, hiddenIds: [], prereqErrors: {}, verdict: 'unknown', attempts: [], engine: 'ce', holders: [] });
    api();
  });

  it('in starlightd mode the CE records are replaced by the paused notice', async () => {
    seed({ engine: 'starlightd', holders: ['user-cheats'] });
    render(<CeSessionView processes={[]} />);
    expect(await screen.findByText('The Cheat Engine table is paused while your cheats run.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Infinite Money: Off' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'God mode: On' })).toBeInTheDocument();
  });

  it('names the agent session when it holds the game', () => {
    seed({ engine: 'starlightd', holders: ['agent'] });
    render(<CeSessionView processes={[]} />);
    expect(screen.getByText('The Cheat Engine table is paused while the agent session runs.')).toBeInTheDocument();
  });

  it('offers to load the table when nothing holds the game', async () => {
    seed({ engine: 'starlightd', holders: [] });
    render(<CeSessionView processes={[]} />);
    expect(screen.getByText('The Cheat Engine table is closed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load the table' }));
    expect(start).toHaveBeenCalled();
  });

  it('Use the table instead turns user cheats off, stops the agent and restarts the session', async () => {
    seed({ engine: 'starlightd', holders: ['agent', 'user-cheats'] });
    render(<CeSessionView processes={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Use the table instead' }));
    expect(screen.getByText('This turns off your cheats and ends the agent session — continue?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(disableAll).toHaveBeenCalledWith({ pid: 42 });
    expect(agentStop).toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: '9kings', pid: 42 }));
  });

  it('a tools-only session with user cheats opens on the Cheats tab', async () => {
    seed({ records: [], tables: [], tableId: null });
    render(<CeSessionView processes={[]} />);
    expect(await screen.findByRole('button', { name: 'God mode: On' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Cheats', selected: true })).toBeInTheDocument();
  });

  it('does not poll refresh in starlightd mode', async () => {
    vi.useFakeTimers();
    try {
      seed({ engine: 'starlightd', holders: ['user-cheats'] });
      render(<CeSessionView processes={[]} />);
      await vi.advanceTimersByTimeAsync(5000);
      expect(call).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'refresh' }));
    } finally { vi.useRealTimers(); }
  });
});

describe('helpers', () => {
  it('gameCandidates prefers .exe processes', () => {
    expect(gameCandidates([{ pid: 1, name: 'bash' }, { pid: 2, name: 'B.exe' }, { pid: 3, name: 'A.exe' }]).map((p) => p.name)).toEqual(['A.exe', 'B.exe']);
    expect(gameCandidates([{ pid: 1, name: 'native-game' }])).toHaveLength(1);
  });
  it('looksStale separates version mismatches from other failures', () => {
    expect(looksStale("Error while scanning for AOB's : CashAOB\nError: Not all results found")).toBe(true);
    expect(looksStale('Failure determining what CargoItem:GetNameWithQnt+1d4 means')).toBe(true);
    expect(looksStale('not attached to a game process')).toBe(false);
    expect(looksStale('Cheat Engine did not respond (timed out)')).toBe(false);
  });
});
