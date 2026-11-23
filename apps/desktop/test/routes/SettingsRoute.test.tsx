import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SettingsRoute } from '../../src/renderer/routes/SettingsRoute.js';
import { useConfigStore } from '../../src/renderer/stores/config-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';

const baseConfig = {
  schemaVersion: 1 as const,
  processNameOverrides: {},
  recents: [],
  preferences: { theme: 'dark' as const, pollIntervalMs: 2000, catalogRefreshOnLaunch: true },
  manualGames: [],
  hotkeyOverrides: {},
};

beforeEach(() => {
  clearStarlightApi();
  useConfigStore.setState({ config: baseConfig, loading: false, error: null });
});

describe('SettingsRoute', () => {
  it('renders the current preferences', () => {
    render(<MemoryRouter><SettingsRoute /></MemoryRouter>);
    expect((screen.getByLabelText(/poll interval/i) as HTMLInputElement).value).toBe('2000');
    expect((screen.getByLabelText(/refresh catalog on launch/i) as HTMLInputElement).checked).toBe(true);
  });

  it('updates poll interval on blur', async () => {
    let received: unknown;
    setStarlightApi({
      getConfig: async () => baseConfig,
      updateConfig: async (req) => { received = req.patch; return baseConfig; },
      onEvent: () => () => {},
    } as never);
    render(<MemoryRouter><SettingsRoute /></MemoryRouter>);
    const input = screen.getByLabelText(/poll interval/i) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '5000');
    await userEvent.tab();
    await waitFor(() => expect(received).toEqual({ preferences: { pollIntervalMs: 5000 } }));
  });

  it('toggles refreshCatalogOnLaunch via checkbox', async () => {
    let received: unknown;
    setStarlightApi({
      getConfig: async () => baseConfig,
      updateConfig: async (req) => { received = req.patch; return baseConfig; },
      onEvent: () => () => {},
    } as never);
    render(<MemoryRouter><SettingsRoute /></MemoryRouter>);
    await userEvent.click(screen.getByLabelText(/refresh catalog on launch/i));
    await waitFor(() => expect(received).toEqual({ preferences: { catalogRefreshOnLaunch: false } }));
  });
});

describe('SettingsRoute agent settings', () => {
  const api = (patches: unknown[]) => setStarlightApi({
    getConfig: async () => baseConfig,
    updateConfig: async (req: { patch: unknown }) => { patches.push(req.patch); return baseConfig; },
    agentConnectInfo: async () => ({ enabled: true, url: 'u', port: 1, portIsFallback: false, token: 't', claudeCommand: 'cmd', codexConfig: 'cfg' }),
    onEvent: () => () => {},
  } as never);

  it('renders with a config that has no agent section (defaults)', async () => {
    api([]);
    render(<MemoryRouter><SettingsRoute /></MemoryRouter>);
    expect(screen.getByText('Connect an agent')).toBeTruthy();
    expect((screen.getByLabelText(/question timeout/i) as HTMLInputElement).value).toBe('300');
    expect(screen.getByText('Answer yes')).toBeTruthy();
    expect(screen.getByText('Stop the agent')).toBeTruthy();
    expect(await screen.findByText('cmd')).toBeTruthy();
  });

  it('commits the question timeout on blur within 10–3600', async () => {
    const patches: unknown[] = [];
    api(patches);
    render(<MemoryRouter><SettingsRoute /></MemoryRouter>);
    const input = screen.getByLabelText(/question timeout/i) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.tab();
    expect(patches).toEqual([]);
    expect(input.value).toBe('300');
    await userEvent.clear(input);
    await userEvent.type(input, '600');
    await userEvent.tab();
    await waitFor(() => expect(patches).toEqual([{ agent: { askTimeoutSec: 600 } }]));
  });
});
