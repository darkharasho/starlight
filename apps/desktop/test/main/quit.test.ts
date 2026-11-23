// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBeforeQuit, runQuitSteps, type QuitStep } from '../../src/main/quit.js';

afterEach(() => { vi.useRealTimers(); });

const ev = () => ({ preventDefault: vi.fn() });

describe('quit sequence (I6, R21)', () => {
  it('runs every step in order, awaiting each, and a failing step does not stop the rest', async () => {
    const log: string[] = [];
    const steps: QuitStep[] = [
      { name: 'pause', run: () => { log.push('pause'); } },
      { name: 'agent', run: async () => { await new Promise((r) => setTimeout(r, 5)); log.push('agent'); } },
      { name: 'boom', run: async () => { log.push('boom'); throw new Error('x'); } },
      { name: 'sync-throw', run: () => { log.push('sync-throw'); throw new Error('y'); } },
      { name: 'engine', run: async () => { log.push('engine'); } },
    ];
    expect(await runQuitSteps(steps, { capMs: 1000 })).toBe('done');
    expect(log).toEqual(['pause', 'agent', 'boom', 'sync-throw', 'engine']);
  });

  it('gives up after the cap', async () => {
    vi.useFakeTimers();
    const later = vi.fn();
    const r = runQuitSteps([{ name: 'hang', run: () => new Promise(() => {}) }, { name: 'later', run: later }], { capMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await r).toBe('timeout');
    expect(later).not.toHaveBeenCalled();
  });

  it('before-quit holds the quit once, runs the steps, then exits; re-entry is guarded', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const exit = vi.fn(() => { log.push('exit'); });
    const steps = vi.fn((): QuitStep[] => [
      { name: 'a', run: async () => { log.push('a'); await gate; } },
      { name: 'b', run: () => { log.push('b'); } },
    ]);
    const onBeforeQuit = createBeforeQuit({ steps, exit, capMs: 3000 });

    const e1 = ev();
    onBeforeQuit(e1);
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    // The player quits again while cleanup runs: still held, nothing runs twice.
    const e2 = ev();
    onBeforeQuit(e2);
    expect(e2.preventDefault).toHaveBeenCalledTimes(1);
    expect(steps).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(log).toEqual(['a', 'b', 'exit']);

    // After cleanup, a quit passes straight through.
    const e3 = ev();
    onBeforeQuit(e3);
    expect(e3.preventDefault).not.toHaveBeenCalled();
    expect(steps).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits after the cap even when a step hangs', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const onBeforeQuit = createBeforeQuit({ steps: () => [{ name: 'hang', run: () => new Promise(() => {}) }], exit, capMs: 3000 });
    onBeforeQuit(ev());
    await vi.advanceTimersByTimeAsync(2999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
