// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPlayerPrompts } from '../../../src/main/agent/player-prompt.js';
import type { Notifier } from '../../../src/main/agent/notifier.js';

function fakeNotifier() {
  const shown: Array<{ title: string; body: string; onClick?: () => void; close: ReturnType<typeof vi.fn> }> = [];
  const notifier: Notifier = {
    show(o) {
      const close = vi.fn();
      shown.push({ ...o, close });
      return { close };
    },
  };
  return { notifier, shown };
}

const req = { label: 'Claude', game: '9Kings.exe', pid: 42, closesCeTable: false, timeoutMs: 120_000 };

afterEach(() => { vi.useRealTimers(); });

describe('player prompts: attach approval', () => {
  it('approval shows the notification with the attach copy', async () => {
    const { notifier, shown } = fakeNotifier();
    const onChange = vi.fn();
    const p = createPlayerPrompts({ notifier, focusAgentView: () => {}, onChange, now: () => 1000 });
    void p.requestApproval(req);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Claude wants to attach to 9Kings.exe', body: 'Allow it in Starlight.' });
    expect(p.approval()).toEqual({ id: expect.any(String), label: 'Claude', game: '9Kings.exe', pid: 42, closesCeTable: false, expiresAt: 121_000 });
    expect(onChange).toHaveBeenCalled();

    void p.requestApproval({ ...req, closesCeTable: true });
    expect(shown[1]!.body).toBe('Allow it in Starlight. This closes the current Cheat Engine table.');
    p.cancelAll();
  });

  it('clicking the notification focuses the agent view', () => {
    const { notifier, shown } = fakeNotifier();
    const focusAgentView = vi.fn();
    const p = createPlayerPrompts({ notifier, focusAgentView, onChange: () => {} });
    void p.requestApproval(req);
    shown[0]!.onClick!();
    expect(focusAgentView).toHaveBeenCalledTimes(1);
    p.cancelAll();
  });

  it('respondApproval resolves allow/deny once', async () => {
    const { notifier, shown } = fakeNotifier();
    const p = createPlayerPrompts({ notifier, focusAgentView: () => {}, onChange: () => {} });
    const a = p.requestApproval(req);
    const id = p.approval()!.id;
    expect(p.respondApproval('nope', true)).toBe(false);
    expect(p.respondApproval(id, true)).toBe(true);
    expect(p.respondApproval(id, false)).toBe(false);
    await expect(a).resolves.toBe('allow');
    expect(p.approval()).toBeNull();
    expect(shown[0]!.close).toHaveBeenCalled();

    const b = p.requestApproval(req);
    expect(p.respondApproval(p.approval()!.id, false)).toBe(true);
    await expect(b).resolves.toBe('deny');
  });

  it('approval times out', async () => {
    vi.useFakeTimers();
    const { notifier, shown } = fakeNotifier();
    const onChange = vi.fn();
    const p = createPlayerPrompts({ notifier, focusAgentView: () => {}, onChange });
    const a = p.requestApproval({ ...req, timeoutMs: 30_000 });
    const id = p.approval()!.id;
    vi.advanceTimersByTime(29_999);
    expect(p.approval()).not.toBeNull();
    vi.advanceTimersByTime(1);
    await expect(a).resolves.toBe('timeout');
    expect(p.approval()).toBeNull();
    expect(p.respondApproval(id, true)).toBe(false);
    expect(shown[0]!.close).toHaveBeenCalled();
  });

  it('cancelAll resolves a pending approval as stopped', async () => {
    const { notifier } = fakeNotifier();
    const p = createPlayerPrompts({ notifier, focusAgentView: () => {}, onChange: () => {} });
    const a = p.requestApproval(req);
    p.cancelAll();
    await expect(a).resolves.toBe('stopped');
    expect(p.approval()).toBeNull();
  });

  it('a new request replaces an older one, which resolves as stopped', async () => {
    const { notifier } = fakeNotifier();
    const p = createPlayerPrompts({ notifier, focusAgentView: () => {}, onChange: () => {} });
    const a = p.requestApproval(req);
    const b = p.requestApproval({ ...req, label: 'Codex' });
    await expect(a).resolves.toBe('stopped');
    expect(p.approval()!.label).toBe('Codex');
    p.cancelAll();
    await expect(b).resolves.toBe('stopped');
  });
});
