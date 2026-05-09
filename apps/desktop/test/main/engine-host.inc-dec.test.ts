import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeMock = vi.fn(async () => undefined);
const freezeMock = vi.fn(async () => ({ cancel: vi.fn(async () => undefined) }));
const attachMock = vi.fn(async () => ({
  fridaSession: { detached: { connect: vi.fn() } },
  detach: vi.fn(async () => undefined),
  attached: true,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('@starlight/engine', () => ({
  attach: attachMock,
  read: vi.fn(),
  write: writeMock,
  resolvePointerChain: vi.fn(async (_s: unknown, a: { baseAddress: string }) => a.baseAddress),
  aobScan: vi.fn(async () => ['0x1000']),
  freeze: freezeMock,
  AttachError: class AttachError extends Error {},
  PermissionError: class PermissionError extends Error {},
  ScanError: class ScanError extends Error {},
  ReadError: class ReadError extends Error {},
  WriteError: class WriteError extends Error {},
}));

beforeEach(() => {
  writeMock.mockClear();
  freezeMock.mockClear();
  vi.resetModules();
});

describe('engine-host inc/dec', () => {
  it('returns error when not attached', async () => {
    const eh = await import('../../src/main/engine-host.js');
    const r = await eh.incCheat('x');
    expect(r.ok).toBe(false);
  });

  it('returns error on toggle-kind cheat', async () => {
    const eh = await import('../../src/main/engine-host.js');
    await eh.attach(123);
    eh.setActiveTrainer({
      game: { name: 'g', processName: ['x'] },
      categories: [{ name: 'c', cheats: [{
        id: 'g', name: 'God', type: 'toggle',
        valueType: 'uint32', address: { kind: 'absolute', address: '0x100' },
      }] }],
    } as never);
    const r = await eh.incCheat('g');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/value cheat/);
  });

  it('returns error when value cheat is not active', async () => {
    const eh = await import('../../src/main/engine-host.js');
    await eh.attach(123);
    eh.setActiveTrainer({
      game: { name: 'g', processName: ['x'] },
      categories: [{ name: 'c', cheats: [{
        id: 'sp', name: 'Speed', type: 'set',
        valueType: 'float', address: { kind: 'absolute', address: '0x100' },
        min: 0, max: 10, step: 0.5, default: 1,
      }] }],
    } as never);
    const r = await eh.incCheat('sp');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not active/);
  });

  it('increments active value cheat by step and updates freeze target', async () => {
    const eh = await import('../../src/main/engine-host.js');
    await eh.attach(123);
    eh.setActiveTrainer({
      game: { name: 'g', processName: ['x'] },
      categories: [{ name: 'c', cheats: [{
        id: 'sp', name: 'Speed', type: 'set',
        valueType: 'float', address: { kind: 'absolute', address: '0x100' },
        min: 0, max: 10, step: 0.5, default: 1,
      }] }],
    } as never);
    await eh.toggleCheat('sp', true);          // activate
    freezeMock.mockClear();
    const r = await eh.incCheat('sp');
    expect(r.ok).toBe(true);
    // setValue path takes the freeze branch and re-freezes with the new value
    expect(freezeMock).toHaveBeenCalled();
    const call = freezeMock.mock.calls[0]![1] as { value: number };
    expect(call.value).toBeCloseTo(1.5);
  });

  it('clamps at max', async () => {
    const eh = await import('../../src/main/engine-host.js');
    await eh.attach(123);
    eh.setActiveTrainer({
      game: { name: 'g', processName: ['x'] },
      categories: [{ name: 'c', cheats: [{
        id: 'sp', name: 'Speed', type: 'set',
        valueType: 'float', address: { kind: 'absolute', address: '0x100' },
        min: 0, max: 2, step: 0.5, default: 2,
      }] }],
    } as never);
    await eh.toggleCheat('sp', true);
    freezeMock.mockClear();
    const r = await eh.incCheat('sp');
    expect(r.ok).toBe(true);
    expect(freezeMock).not.toHaveBeenCalled();  // saturated, no-op
  });

  it('decCheat clamps at min', async () => {
    const eh = await import('../../src/main/engine-host.js');
    await eh.attach(123);
    eh.setActiveTrainer({
      game: { name: 'g', processName: ['x'] },
      categories: [{ name: 'c', cheats: [{
        id: 'sp', name: 'Speed', type: 'set',
        valueType: 'float', address: { kind: 'absolute', address: '0x100' },
        min: 0, max: 10, step: 0.5, default: 0,
      }] }],
    } as never);
    await eh.toggleCheat('sp', true);
    freezeMock.mockClear();
    const r = await eh.decCheat('sp');
    expect(r.ok).toBe(true);
    expect(freezeMock).not.toHaveBeenCalled();
  });
});
