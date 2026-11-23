import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectAgentCard } from '../../src/renderer/components/settings/ConnectAgentCard.js';
import { useConfigStore } from '../../src/renderer/stores/config-store.js';
import { setStarlightApi, clearStarlightApi } from '../../src/renderer/ipc-client.js';
import { DEFAULT_AGENT_PREFS, type AgentConnectInfo } from '../../src/shared/ipc.js';

const info: AgentConnectInfo = {
  enabled: true, url: 'http://127.0.0.1:47771/mcp', port: 47771, portIsFallback: false, token: 'tok-one',
  claudeCommand: 'claude mcp add starlight http://127.0.0.1:47771/mcp --header "Authorization: Bearer tok-one"',
  codexConfig: '[mcp_servers.starlight]\nurl = "http://127.0.0.1:47771/mcp"\nbearer = "tok-one"',
};
const config = {
  schemaVersion: 1, processNameOverrides: {}, recents: [], manualGames: [], hotkeyOverrides: {},
  preferences: { theme: 'dark', pollIntervalMs: 2000, catalogRefreshOnLaunch: true },
  agent: { ...DEFAULT_AGENT_PREFS },
};
let patches: unknown[];
let writeText: ReturnType<typeof vi.fn>;

function setup(over: Partial<AgentConnectInfo> = {}, rotated?: AgentConnectInfo): void {
  setStarlightApi({
    agentConnectInfo: async () => ({ ...info, ...over }),
    agentRotateToken: async () => rotated ?? info,
    updateConfig: async (req: { patch: unknown }) => { patches.push(req.patch); return config; },
    getConfig: async () => config,
    onEvent: () => () => {},
  } as never);
}

beforeEach(() => {
  clearStarlightApi();
  patches = [];
  useConfigStore.setState({ config: config as never, loading: false, error: null });
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('ConnectAgentCard', () => {
  it('shows the Claude Code command with the real port and token', async () => {
    setup();
    render(<ConnectAgentCard />);
    expect(await screen.findByText(info.claudeCommand)).toBeTruthy();
  });

  it('switches to the Codex snippet', async () => {
    setup();
    render(<ConnectAgentCard />);
    await screen.findByText(info.claudeCommand);
    await userEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(screen.getByText(/mcp_servers\.starlight/)).toBeTruthy();
    expect(screen.queryByText(info.claudeCommand)).toBeNull();
  });

  it('Copy puts the command on the clipboard and says Copied', async () => {
    setup();
    render(<ConnectAgentCard />);
    await screen.findByText(info.claudeCommand);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(info.claudeCommand));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says when the port is a fallback', async () => {
    setup({ portIsFallback: true, port: 50000 });
    render(<ConnectAgentCard />);
    expect(await screen.findByText(
      'Port 47771 was busy, so Starlight is using 50000 for now. Copy the command again if you set it up before.',
    )).toBeTruthy();
  });

  it('Regenerate token asks first, then shows the new token', async () => {
    setup({}, { ...info, token: 'tok-two', claudeCommand: 'claude ... tok-two' });
    render(<ConnectAgentCard />);
    await screen.findByText(info.claudeCommand);
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate token' }));
    expect(screen.getByText("Agents you've already connected will need the new command. Continue?")).toBeTruthy();
    expect(screen.getByText(info.claudeCommand)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('claude ... tok-two')).toBeTruthy();
  });

  it('turning agents off updates agent.enabled and hides the command', async () => {
    setup();
    const { rerender } = render(<ConnectAgentCard />);
    await screen.findByText(info.claudeCommand);
    await userEvent.click(screen.getByLabelText('Allow agents to connect'));
    await waitFor(() => expect(patches).toEqual([{ agent: { enabled: false } }]));
    useConfigStore.setState({ config: { ...config, agent: { ...config.agent, enabled: false } } as never });
    rerender(<ConnectAgentCard />);
    expect(await screen.findByText("Agents can't connect while this is off.")).toBeTruthy();
    expect(screen.queryByText(info.claudeCommand)).toBeNull();
  });
});
