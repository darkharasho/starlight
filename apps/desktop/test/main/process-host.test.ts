import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessHost } from '../../src/main/process-host.js';
import type { StarlightEvent } from '../../src/shared/ipc.js';

function makeHost(opts: {
  psList?: () => Promise<{ pid: number; name: string }[]>;
  isAttached?: () => boolean;
} = {}): { host: ProcessHost; events: StarlightEvent[] } {
  const events: StarlightEvent[] = [];
  const host = new ProcessHost({
    intervalMs: 1000,
    emit: (e) => events.push(e),
    psList: opts.psList ?? (async () => []),
    isAttached: opts.isAttached ?? (() => false),
  });
  return { host, events };
}

describe('ProcessHost', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('emits process:list on each tick', async () => {
    const { host, events } = makeHost({
      psList: async () => [{ pid: 1, name: 'a' }, { pid: 2, name: 'b' }],
    });
    host.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter(e => e.type === 'process:list')).toHaveLength(2);
    host.pause();
  });

  it('skips ticks while attached', async () => {
    let attached = false;
    const { host, events } = makeHost({
      psList: async () => [{ pid: 1, name: 'a' }],
      isAttached: () => attached,
    });
    host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(e => e.type === 'process:list')).toHaveLength(1);
    attached = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter(e => e.type === 'process:list')).toHaveLength(1);
    host.pause();
  });

  it('pause/resume gates ticks', async () => {
    const { host, events } = makeHost({
      psList: async () => [{ pid: 1, name: 'a' }],
    });
    host.start();
    await vi.advanceTimersByTimeAsync(0);
    host.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.filter(e => e.type === 'process:list')).toHaveLength(1);
    host.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(e => e.type === 'process:list')).toHaveLength(2);
    host.pause();
  });

  it('emits process:matched on transition only', async () => {
    let procs: { pid: number; name: string }[] = [{ pid: 100, name: 'target' }];
    const { host, events } = makeHost({ psList: async () => procs });
    host.setTrainerProcessNames(['target', 'target.exe']);
    host.start();
    await vi.advanceTimersByTimeAsync(0);
    // procs unchanged — re-emit should not fire
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const matched = events.filter(e => e.type === 'process:matched');
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ type: 'process:matched', pid: 100, name: 'target' });
    host.pause();
  });

  it('matches case-insensitively, with .exe stripping', async () => {
    const { host, events } = makeHost({
      psList: async () => [{ pid: 200, name: 'TARGET.EXE' }],
    });
    host.setTrainerProcessNames(['target']);
    host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.find(e => e.type === 'process:matched')).toMatchObject({ pid: 200 });
    host.pause();
  });

  it('clearTrainer resets match dedup', async () => {
    let procs: { pid: number; name: string }[] = [{ pid: 1, name: 'target' }];
    const { host, events } = makeHost({ psList: async () => procs });
    host.setTrainerProcessNames(['target']);
    host.start();
    await vi.advanceTimersByTimeAsync(0);
    host.clearTrainer();
    host.setTrainerProcessNames(['target']);
    await vi.advanceTimersByTimeAsync(1000);
    const matched = events.filter(e => e.type === 'process:matched');
    expect(matched).toHaveLength(2);
    host.pause();
  });
});
