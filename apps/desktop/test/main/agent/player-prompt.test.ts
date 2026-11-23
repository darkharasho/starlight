// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPlayerPrompts } from '../../../src/main/agent/player-prompt.js';
import { DEFAULT_AGENT_PREFS } from '../../../src/shared/ipc.js';
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

type Handlers = { yes?(): void; no?(): void; stop?(): void };
function fakeHotkeys() {
  const bound: Record<string, string | null | undefined> = {};
  const handlers: Handlers = {};
  const set = vi.fn((b: Record<string, string | null> | null, on?: Handlers) => {
    if (b === null) { for (const k of Object.keys(bound)) bound[k] = null; return { ok: true as const }; }
    for (const [k, v] of Object.entries(b)) bound[k] = v;
    Object.assign(handlers, on);
    return { ok: true as const };
  });
  return { port: { set } as never, bound, handlers, set };
}
const base = () => ({ hotkeys: fakeHotkeys().port, prefs: async () => ({ ...DEFAULT_AGENT_PREFS }) });
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

const req = { label: 'Claude', game: '9Kings.exe', pid: 42, closesCeTable: false, timeoutMs: 120_000 };

afterEach(() => { vi.useRealTimers(); });

describe('player prompts: attach approval', () => {
  it('approval shows the notification with the attach copy', async () => {
    const { notifier, shown } = fakeNotifier();
    const onChange = vi.fn();
    const p = createPlayerPrompts({ ...base(), notifier, focusAgentView: () => {}, onChange, now: () => 1000 });
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
    const p = createPlayerPrompts({ ...base(), notifier, focusAgentView, onChange: () => {} });
    void p.requestApproval(req);
    shown[0]!.onClick!();
    expect(focusAgentView).toHaveBeenCalledTimes(1);
    p.cancelAll();
  });

  it('respondApproval resolves allow/deny once', async () => {
    const { notifier, shown } = fakeNotifier();
    const p = createPlayerPrompts({ ...base(), notifier, focusAgentView: () => {}, onChange: () => {} });
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
    const p = createPlayerPrompts({ ...base(), notifier, focusAgentView: () => {}, onChange });
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
    const p = createPlayerPrompts({ ...base(), notifier, focusAgentView: () => {}, onChange: () => {} });
    const a = p.requestApproval(req);
    p.cancelAll();
    await expect(a).resolves.toBe('stopped');
    expect(p.approval()).toBeNull();
  });

  it('a new request replaces an older one, which resolves as stopped', async () => {
    const { notifier } = fakeNotifier();
    const p = createPlayerPrompts({ ...base(), notifier, focusAgentView: () => {}, onChange: () => {} });
    const a = p.requestApproval(req);
    const b = p.requestApproval({ ...req, label: 'Codex' });
    await expect(a).resolves.toBe('stopped');
    expect(p.approval()!.label).toBe('Codex');
    p.cancelAll();
    await expect(b).resolves.toBe('stopped');
  });
});

const q = { question: 'Did your gold change?', answer: 'confirm' as const, timeoutMs: 300_000, label: 'Claude' };

function questions() {
  const { notifier, shown } = fakeNotifier();
  const hk = fakeHotkeys();
  const focusAgentView = vi.fn();
  const p = createPlayerPrompts({ notifier, focusAgentView, onChange: () => {}, hotkeys: hk.port, prefs: async () => ({ ...DEFAULT_AGENT_PREFS }) });
  return { p, shown, hk, focusAgentView };
}

describe('player prompts: ask_player', () => {
  it('ask shows a notification with the question and the hotkeys', async () => {
    const { p, shown, focusAgentView } = questions();
    void p.ask(q);
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Claude asks');
    expect(shown[0]!.body).toBe('Did your gold change?\nPress Ctrl+Shift+Y for yes or Ctrl+Shift+N for no.');
    shown[0]!.onClick!();
    expect(focusAgentView).toHaveBeenCalled();
    expect(p.pending()).toEqual([expect.objectContaining({ question: 'Did your gold change?', answer: 'confirm', label: 'Claude' })]);
    p.cancelAll();
    void p.ask({ ...q, answer: 'number' });
    await flush();
    expect(shown[1]!.body).toBe('Did your gold change?\nSwitch to Starlight to type the number.');
    p.cancelAll();
    void p.ask({ ...q, answer: 'choice', choices: ['a', 'b'] });
    await flush();
    expect(shown[2]!.body).toBe('Did your gold change?\nSwitch to Starlight to pick: a / b.');
    p.cancelAll();
  });

  it('the Yes hotkey answers a confirm question true; No answers false', async () => {
    const { p, hk } = questions();
    const a = p.ask(q);
    await flush();
    hk.handlers.yes!();
    expect(await a).toEqual({ answered: true, answer: true });
    const b = p.ask(q);
    await flush();
    hk.handlers.no!();
    expect(await b).toEqual({ answered: true, answer: false });
  });

  it('yes/no hotkeys are unbound when no confirm question is pending', async () => {
    const { p, hk, shown } = questions();
    const n = p.ask({ ...q, answer: 'number' });
    await flush();
    expect(hk.bound.yes ?? null).toBeNull();
    p.cancelAll();
    await n;
    const a = p.ask(q);
    await flush();
    expect(hk.bound).toMatchObject({ yes: 'Ctrl+Shift+Y', no: 'Ctrl+Shift+N' });
    hk.handlers.yes!();
    await a;
    expect(hk.bound).toMatchObject({ yes: null, no: null });
    expect(shown[1]!.close).toHaveBeenCalled();
  });

  it('a number answer from the app resolves the ask; a non-number is refused', async () => {
    const { p } = questions();
    const a = p.ask({ ...q, answer: 'number' });
    await flush();
    const id = p.pending()[0]!.id;
    expect(p.answer(id, 'abc')).toEqual({ ok: false, error: 'Type a number' });
    expect(p.answer(id, Number.NaN)).toEqual({ ok: false, error: 'Type a number' });
    expect(p.answer(id, 120)).toEqual({ ok: true });
    expect(await a).toEqual({ answered: true, answer: 120 });
    expect(p.answer(id, 1)).toEqual({ ok: false, error: 'That question was already answered' });
  });

  it('a confirm answer must be yes or no', async () => {
    const { p } = questions();
    const a = p.ask(q);
    await flush();
    const id = p.pending()[0]!.id;
    expect(p.answer(id, 'maybe')).toEqual({ ok: false, error: 'Answer yes or no' });
    expect(p.answer(id, false)).toEqual({ ok: true });
    expect(await a).toEqual({ answered: true, answer: false });
  });

  it('a choice must be one of the choices', async () => {
    const { p } = questions();
    const a = p.ask({ ...q, answer: 'choice', choices: ['x', 'y'] });
    await flush();
    const id = p.pending()[0]!.id;
    expect(p.answer(id, 'z')).toEqual({ ok: false, error: 'Pick one of the choices' });
    expect(p.answer(id, 'y')).toEqual({ ok: true });
    expect(await a).toEqual({ answered: true, answer: 'y' });
  });

  it('times out with reason timeout', async () => {
    vi.useFakeTimers();
    const { p, shown } = questions();
    const a = p.ask(q);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await a).toEqual({ answered: false, reason: 'timeout' });
    expect(p.pending()).toEqual([]);
    expect(shown[0]!.close).toHaveBeenCalled();
  });

  it('a second question while one is waiting is a tool error', async () => {
    const { p } = questions();
    void p.ask(q);
    await expect(p.ask(q)).rejects.toMatchObject({ name: 'ToolError', message: 'A question is already waiting for the player.' });
    p.cancelAll();
  });

  it('Stop resolves the pending question as stopped', async () => {
    const { p, hk } = questions();
    const a = p.ask(q);
    await flush();
    p.cancelAll();
    expect(await a).toEqual({ answered: false, reason: 'stopped' });
    expect(p.pending()).toEqual([]);
    expect(hk.bound).toMatchObject({ yes: null, no: null });
  });

  it('an aborted request clears the question, the notification and the hotkeys', async () => {
    const { p, hk, shown } = questions();
    const ac = new AbortController();
    const a = p.ask({ ...q, signal: ac.signal });
    await flush();
    ac.abort();
    expect(await a).toEqual({ answered: false, reason: 'stopped' });
    expect(p.pending()).toEqual([]);
    expect(shown[0]!.close).toHaveBeenCalled();
    expect(hk.bound).toMatchObject({ yes: null, no: null });
    const already = new AbortController();
    already.abort();
    expect(await p.ask({ ...q, signal: already.signal })).toEqual({ answered: false, reason: 'stopped' });
    expect(p.pending()).toEqual([]);
  });
});
