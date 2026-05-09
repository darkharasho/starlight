import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StarlightApi, StarlightEvent } from '../../src/shared/ipc.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import { useProcessStore, attachProcessEvents, detachProcessEvents } from '../../src/renderer/stores/process-store.js';

let listeners: Array<(e: StarlightEvent) => void> = [];

function installFakeApi(): void {
  listeners = [];
  setStarlightApi({
    listProcesses: async () => ({ processes: [{ pid: 9, name: 'manual' }] }),
    onEvent: (l: (e: StarlightEvent) => void) => {
      listeners.push(l);
      return () => { listeners = listeners.filter(x => x !== l); };
    },
  } as unknown as StarlightApi);
}

function emit(e: StarlightEvent): void { for (const l of listeners) l(e); }

beforeEach(() => {
  detachProcessEvents();
  useProcessStore.setState({ processes: [], matchedPid: null });
  clearStarlightApi();
  installFakeApi();
});

describe('process-store', () => {
  it('updates processes on process:list events', () => {
    attachProcessEvents();
    emit({ type: 'process:list', processes: [{ pid: 1, name: 'a' }, { pid: 2, name: 'b' }] });
    expect(useProcessStore.getState().processes).toHaveLength(2);
  });

  it('tracks matchedPid on process:matched', () => {
    attachProcessEvents();
    expect(useProcessStore.getState().matchedPid).toBeNull();
    emit({ type: 'process:matched', pid: 42, name: 'target' });
    expect(useProcessStore.getState().matchedPid).toBe(42);
  });

  it('refresh() calls listProcesses and updates state', async () => {
    attachProcessEvents();
    await useProcessStore.getState().refresh();
    expect(useProcessStore.getState().processes).toEqual([{ pid: 9, name: 'manual' }]);
  });
});
