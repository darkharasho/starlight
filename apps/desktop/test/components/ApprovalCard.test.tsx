import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ApprovalCard } from '../../src/renderer/components/agent/ApprovalCard.js';
import { useAgentStore } from '../../src/renderer/stores/agent-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import { snap } from '../agent-fixtures.js';

let responses: unknown[];
const approval = { id: 'a1', label: 'Claude', game: 'Hades', pid: 1, closesCeTable: true, expiresAt: Date.now() + 90_000 };
const Loc = (): JSX.Element => <div data-testid="loc">{useLocation().pathname}</div>;
function setup(): void {
  render(<MemoryRouter initialEntries={['/library']}><ApprovalCard /><Loc /></MemoryRouter>);
}
beforeEach(() => {
  clearStarlightApi();
  responses = [];
  setStarlightApi({ agentRespondApproval: async (r: unknown) => { responses.push(r); }, onEvent: () => () => {} } as never);
  useAgentStore.setState({ state: snap({ status: 'awaiting-approval', approval }) });
});

describe('ApprovalCard', () => {
  it('shows the attach question and the CE-close note; Allow responds and opens the agent view', async () => {
    setup();
    expect(screen.getByText('Claude wants to attach to Hades — Allow?')).toBeTruthy();
    expect(screen.getByText('This closes the current Cheat Engine table.')).toBeTruthy();
    expect(screen.getByText(/1:3\d|1:30/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(responses).toEqual([{ id: 'a1', allow: true }]);
    expect(screen.getByTestId('loc').textContent).toBe('/agent');
  });

  it('Deny responds false', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(responses).toEqual([{ id: 'a1', allow: false }]);
    expect(screen.getByTestId('loc').textContent).toBe('/library');
  });

  it('renders nothing without an approval, and omits the note when no table closes', () => {
    useAgentStore.setState({ state: snap({ approval: { ...approval, closesCeTable: false } }) });
    setup();
    expect(screen.queryByText(/closes the current/)).toBeNull();
  });
});
