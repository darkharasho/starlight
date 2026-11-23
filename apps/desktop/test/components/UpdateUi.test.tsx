import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TitleBar } from '../../src/renderer/components/TitleBar.js';
import { SettingsRoute } from '../../src/renderer/routes/SettingsRoute.js';
import { useUpdateStore } from '../../src/renderer/stores/update-store.js';
import { useConfigStore } from '../../src/renderer/stores/config-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';

const initial = useUpdateStore.getState();

beforeEach(() => {
  clearStarlightApi();
  useUpdateStore.setState(initial, true);
  useConfigStore.setState({
    config: {
      schemaVersion: 1, processNameOverrides: {}, recents: [], manualGames: [], hotkeyOverrides: {},
      preferences: { theme: 'dark', pollIntervalMs: 2000, catalogRefreshOnLaunch: true, autoAttachOnDetect: false, cheatHotkeys: true },
    } as never,
    loading: false, error: null,
  });
});

describe('title bar update pill', () => {
  it('is hidden when there is no update', () => {
    render(<TitleBar />);
    expect(screen.queryByText(/downloading|restart to update/i)).toBeNull();
  });

  it('shows download progress', () => {
    useUpdateStore.setState({ state: { status: 'downloading', version: '0.2.0', percent: 30.2 } });
    render(<TitleBar />);
    expect(screen.getByText('Downloading 30%')).toBeInTheDocument();
  });

  it('restarts to install a downloaded update', async () => {
    let restarted = 0;
    setStarlightApi({ updateRestart: async () => { restarted++; } } as never);
    useUpdateStore.setState({ state: { status: 'downloaded', version: '0.2.0' } });
    render(<TitleBar />);
    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(restarted).toBe(1);
  });
});

describe('Settings updates section', () => {
  it('shows the version and the result of a manual check', async () => {
    setStarlightApi({
      updateCheck: async () => {
        useUpdateStore.setState({ state: { status: 'none' } });
        return { ok: true };
      },
    } as never);
    useUpdateStore.setState({ version: '0.1.0' });
    render(<MemoryRouter><SettingsRoute /></MemoryRouter>);
    expect(screen.getByText('Starlight v0.1.0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText("You're on the latest version.")).toBeInTheDocument();
  });

  it('says why a check outside the AppImage does nothing', async () => {
    setStarlightApi({ updateCheck: async () => ({ ok: false, error: 'Updates only work in the Starlight AppImage.' }) } as never);
    render(<MemoryRouter><SettingsRoute /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Updates only work in the Starlight AppImage.')).toBeInTheDocument();
  });
});
