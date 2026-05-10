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
