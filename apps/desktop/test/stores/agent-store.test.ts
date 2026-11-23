import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useAgentStore, attachAgentEvents } from '../../src/renderer/stores/agent-store.js';
import { AgentEvents } from '../../src/renderer/components/agent/AgentEvents.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import { snap } from '../agent-fixtures.js';

beforeEach(() => { clearStarlightApi(); useAgentStore.setState({ state: null }); });

describe('agent store', () => {
  it('load fetches the snapshot; actions call the bridge', async () => {
    const calls: unknown[] = [];
    setStarlightApi({
      agentGetState: async () => snap(),
      agentRespondApproval: async (r: unknown) => { calls.push(['approve', r]); },
      agentAnswer: async (r: unknown) => { calls.push(['answer', r]); return { ok: false, error: 'Type a number' }; },
      agentSetCanModify: async (r: unknown) => { calls.push(['mod', r]); },
      agentStop: async () => { calls.push(['stop']); },
      onEvent: () => () => {},
    } as never);
    await useAgentStore.getState().load();
    expect(useAgentStore.getState().state?.game?.name).toBe('Hades');
    useAgentStore.setState({ state: snap({ status: 'awaiting-approval', approval: { id: 'a1', label: 'Claude', game: 'Hades', pid: 1, closesCeTable: false, expiresAt: 1 } }) });
    await useAgentStore.getState().respond(true);
    expect(await useAgentStore.getState().answer('q1', 5)).toEqual({ ok: false, error: 'Type a number' });
    await useAgentStore.getState().setCanModify(false);
    await useAgentStore.getState().stop();
    expect(calls).toEqual([['approve', { id: 'a1', allow: true }], ['answer', { id: 'q1', value: 5 }], ['mod', { on: false }], ['stop']]);
  });

  it('agent:state events update the store', async () => {
    let listener: (e: unknown) => void = () => {};
    setStarlightApi({ agentGetState: async () => snap({ status: 'idle', game: null, client: null }), onEvent: (l: never) => { listener = l; return () => {}; } } as never);
    const off = attachAgentEvents();
    act(() => listener({ type: 'agent:state', state: snap() }));
    expect(useAgentStore.getState().state?.status).toBe('attached');
    off();
  });

  it('agent:focus navigates to /agent', () => {
    let listener: (e: unknown) => void = () => {};
    setStarlightApi({ agentGetState: async () => snap(), onEvent: (l: never) => { listener = l; return () => {}; } } as never);
    const Loc = (): JSX.Element => createElement('div', { 'data-testid': 'loc' }, useLocation().pathname);
    const { getByTestId } = render(createElement(MemoryRouter, { initialEntries: ['/library'] }, createElement(AgentEvents), createElement(Loc)));
    expect(getByTestId('loc').textContent).toBe('/library');
    act(() => listener({ type: 'agent:focus' }));
    expect(getByTestId('loc').textContent).toBe('/agent');
  });
});
