import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTrainerStore } from '../../src/renderer/stores/trainer-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi, StarlightTrainer } from '../../src/shared/ipc.js';

const minimalTrainer: StarlightTrainer = {
  schemaVersion: 1,
  id: 't',
  game: { name: 'X', processName: ['x'], platform: ['linux'] },
  metadata: { source: { convertedFrom: '.CT' } },
  categories: [
    { name: 'P', cheats: [
      { id: 'a', name: 'A', type: 'freeze', valueType: 'int32', value: 1, address: { kind: 'absolute', address: '0x1000' } },
      { id: 'b', name: 'B', type: 'set', valueType: 'float', default: 1.5, step: 0.1, address: { kind: 'absolute', address: '0x2000' } },
    ] },
  ],
};

function fakeApi(overrides: Partial<StarlightApi> = {}): StarlightApi {
  return {
    loadTrainer:   vi.fn().mockResolvedValue({ ok: true, trainer: minimalTrainer, stats: { total: 2, supported: 2, unsupported: 0, categories: 1 } }),
    attach:        vi.fn().mockResolvedValue({ ok: true }),
    detach:        vi.fn().mockResolvedValue(undefined),
    toggleCheat:   vi.fn().mockResolvedValue({ ok: true }),
    setCheatValue: vi.fn().mockResolvedValue({ ok: true }),
    onEvent:       vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

beforeEach(() => {
  useTrainerStore.setState({ trainer: null, activeCheats: {}, values: {}, error: null });
  clearStarlightApi();
});

describe('trainer-store', () => {
  it('loadTrainer populates the trainer and seeds default values', async () => {
    setStarlightApi(fakeApi());
    await useTrainerStore.getState().loadTrainer();
    const s = useTrainerStore.getState();
    expect(s.trainer?.id).toBe('t');
    expect(s.values).toEqual({ b: 1.5 });
  });

  it('toggleCheat flips active state on success', async () => {
    setStarlightApi(fakeApi());
    useTrainerStore.setState({ trainer: minimalTrainer });
    await useTrainerStore.getState().toggleCheat('a', true);
    expect(useTrainerStore.getState().activeCheats.a).toBe(true);
    await useTrainerStore.getState().toggleCheat('a', false);
    expect(useTrainerStore.getState().activeCheats.a).toBe(false);
  });

  it('toggleCheat sets error on IPC failure', async () => {
    setStarlightApi(fakeApi({ toggleCheat: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) }));
    useTrainerStore.setState({ trainer: minimalTrainer });
    await useTrainerStore.getState().toggleCheat('a', true);
    expect(useTrainerStore.getState().activeCheats.a).toBe(false); // rolled back
    expect(useTrainerStore.getState().error).toMatch(/boom/);
  });

  it('setCheatValue updates the value map and clamps to [min,max] if defined', async () => {
    setStarlightApi(fakeApi());
    useTrainerStore.setState({ trainer: {
      ...minimalTrainer,
      categories: [{ name: 'P', cheats: [{
        id: 'c', name: 'C', type: 'set', valueType: 'float', default: 1, step: 0.1, min: 0, max: 5,
        address: { kind: 'absolute', address: '0x3000' },
      }] }],
    } });
    await useTrainerStore.getState().setCheatValue('c', 99);
    expect(useTrainerStore.getState().values.c).toBe(5); // clamped
  });

  it('setProcessName calls IPC and updates processName in trainer', async () => {
    const setProcessNameMock = vi.fn().mockResolvedValue(undefined);
    setStarlightApi(fakeApi({ setProcessName: setProcessNameMock }));
    useTrainerStore.setState({ trainer: minimalTrainer });
    await useTrainerStore.getState().setProcessName(['target', 'target.exe']);
    expect(setProcessNameMock).toHaveBeenCalledWith({ names: ['target', 'target.exe'] });
    expect(useTrainerStore.getState().trainer?.game.processName).toEqual(['target', 'target.exe']);
  });

  it('setProcessName persists to config processNameOverrides', async () => {
    let received: unknown;
    setStarlightApi(fakeApi({
      setProcessName: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockImplementation(async (req) => { received = req.patch; return { pollIntervalMs: 500, processNameOverrides: {} } as any; }),
    }));
    useTrainerStore.setState({ trainer: minimalTrainer });
    await useTrainerStore.getState().setProcessName(['game.exe']);
    expect(received).toEqual({ processNameOverrides: { 't': ['game.exe'] } });
  });
});

describe('trainer-store applyEvent', () => {
  beforeEach(() => {
    setStarlightApi(fakeApi());
    useTrainerStore.setState({ trainer: minimalTrainer, activeCheats: {}, values: {}, error: null });
  });

  it('updates activeCheats on cheat:toggled', () => {
    useTrainerStore.getState().applyEvent({ type: 'cheat:toggled', cheatId: 'a', on: true, cause: 'hotkey' });
    expect(useTrainerStore.getState().activeCheats.a).toBe(true);
  });

  it('updates values on cheat:value-changed', () => {
    useTrainerStore.getState().applyEvent({ type: 'cheat:value-changed', cheatId: 'b', value: 2.5, cause: 'hotkey' });
    expect(useTrainerStore.getState().values.b).toBe(2.5);
  });

  it('clears active state and surfaces an error on session:detached due to process-exit', () => {
    useTrainerStore.setState({ activeCheats: { a: true } });
    useTrainerStore.getState().applyEvent({ type: 'session:detached', reason: 'process-exit' });
    expect(useTrainerStore.getState().activeCheats).toEqual({});
    expect(useTrainerStore.getState().error).toMatch(/process exited/i);
  });
});
