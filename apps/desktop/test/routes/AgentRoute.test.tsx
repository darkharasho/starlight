import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AgentRoute } from '../../src/renderer/routes/AgentRoute.js';
import { useAgentStore } from '../../src/renderer/stores/agent-store.js';
import { useConfigStore } from '../../src/renderer/stores/config-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import { DEFAULT_AGENT_PREFS, type AgentSnapshot } from '../../src/shared/ipc.js';
import { snap } from '../agent-fixtures.js';

let calls: unknown[];
let answerResult: { ok: true } | { ok: false; error: string };
function setup(s: AgentSnapshot): void {
  useAgentStore.setState({ state: s });
  render(<MemoryRouter><AgentRoute /></MemoryRouter>);
}
const q = (over: object) => ({ id: 'q1', question: 'What is your gold now?', answer: 'number', askedAt: 1, expiresAt: Date.now() + 60_000, label: 'Claude', ...over });

beforeEach(() => {
  clearStarlightApi();
  calls = [];
  answerResult = { ok: true };
  useConfigStore.setState({ config: { agent: { ...DEFAULT_AGENT_PREFS } } as never, loading: false, error: null });
  setStarlightApi({
    agentGetState: async () => useAgentStore.getState().state,
    agentAnswer: async (r: unknown) => { calls.push(['answer', r]); return answerResult; },
    agentSetCanModify: async (r: unknown) => { calls.push(['mod', r]); },
    agentStop: async () => { calls.push(['stop']); },
    onEvent: () => () => {},
  } as never);
});

describe('AgentRoute', () => {
  it('lists activity newest first with old → new for writes', () => {
    setup(snap({ activity: [
      { id: 2, at: Date.now(), tool: 'write', summary: 'Wrote gold', status: 'ok', change: { address: '0x10', old: '5', new: '999' } },
      { id: 1, at: Date.now() - 5000, tool: 'scan', summary: 'Scanned memory', status: 'error', error: 'Process gone' },
    ] }));
    const rows = screen.getAllByRole('listitem');
    expect(rows[0].textContent).toContain('Wrote gold');
    expect(rows[0].textContent).toContain('5 → 999');
    expect(rows[1].textContent).toContain('Scanned memory');
    expect(rows[1].textContent).toContain('Process gone');
  });

  it('a number question focuses its input and submits the number', async () => {
    setup(snap({ questions: [q({})] }));
    const input = screen.getByLabelText('Your answer') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await userEvent.type(input, '1200');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls).toEqual([['answer', { id: 'q1', value: 1200 }]]);
  });

  it('shows the answer error under the input', async () => {
    answerResult = { ok: false, error: 'Type a number' };
    setup(snap({ questions: [q({})] }));
    await userEvent.type(screen.getByLabelText('Your answer'), '7{Enter}');
    expect(await screen.findByText('Type a number')).toBeTruthy();
  });

  it('confirm questions show Yes/No with the hotkey labels', async () => {
    setup(snap({ questions: [q({ answer: 'confirm', question: 'Did HP drop?' })] }));
    expect(screen.getByRole('button', { name: /Yes.*Ctrl\+Shift\+Y/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /No.*Ctrl\+Shift\+N/ }));
    expect(calls).toEqual([['answer', { id: 'q1', value: false }]]);
  });

  it('choice questions show one button per choice', async () => {
    setup(snap({ questions: [q({ answer: 'choice', question: 'Which?', choices: ['Gold', 'Gems'] })] }));
    await userEvent.click(screen.getByRole('button', { name: 'Gems' }));
    expect(calls).toEqual([['answer', { id: 'q1', value: 'Gems' }]]);
  });

  it('the switch calls setCanModify; Stop calls agentStop', async () => {
    setup(snap());
    expect(screen.getByText('Hades')).toBeTruthy();
    expect(screen.getByText(/Claude/)).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Agent can modify the game' }));
    await userEvent.click(screen.getByRole('button', { name: /Stop.*Ctrl\+Shift\+End/ }));
    expect(calls).toEqual([['mod', { on: false }], ['stop']]);
  });

  it('the Live strip shows freezes, test cheats, watches and speed', () => {
    setup(snap({ live: {
      freezes: [{ id: 1, address: '0xAB', where: 'Gold', type: 'int32', value: '999' }, { id: 2, address: '0xCD', where: null, type: 'int32', value: '5' }],
      tests: [{ id: 3, name: 'Infinite ammo' }],
      watches: [{ id: 4, address: '0xEF', kind: 'write', endsAt: Date.now() + 30_000 }],
      speed: 2,
    } }));
    const live = screen.getByLabelText('Live');
    expect(live.textContent).toContain('Gold = 999');
    expect(live.textContent).toContain('0xCD = 5');
    expect(live.textContent).toContain('Infinite ammo');
    expect(live.textContent).toMatch(/0xEF.*\d+s/);
    expect(live.textContent).toContain('2×');
  });

  it('idle state points to Settings', () => {
    setup(snap({ status: 'idle', game: null, client: null }));
    expect(screen.getByText('No agent attached')).toBeTruthy();
    expect(screen.getByText('Connect Claude Code or Codex in Settings, then ask it to find a cheat.')).toBeTruthy();
    expect((screen.getByRole('link', { name: /Settings/ }) as HTMLAnchorElement).getAttribute('href')).toBe('/settings');
  });
});
