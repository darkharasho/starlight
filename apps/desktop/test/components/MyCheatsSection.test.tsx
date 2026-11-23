import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyCheatsSection } from '../../src/renderer/components/ce/MyCheatsSection.js';
import { useUserCheatsStore } from '../../src/renderer/stores/user-cheats-store.js';
import { setStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi } from '../../src/shared/ipc.js';

const list = vi.fn();
const setActive = vi.fn();
const setValue = vi.fn();
const remove = vi.fn();
const toggle = { id: 'god', name: 'God mode', type: 'toggle', valueType: 'int32', address: {} };
const gold = { id: 'gold', name: 'Gold', type: 'set', valueType: 'int32', default: 100, address: {} };

beforeEach(() => {
  list.mockReset(); setActive.mockReset(); setValue.mockReset(); remove.mockReset();
  list.mockResolvedValue([
    { cheat: toggle, active: false, verify: { status: 'needs-update', reasons: ['site moved', 'bytes differ'] } },
    { cheat: gold, active: true, value: 250, verify: null },
  ]);
  setActive.mockResolvedValue({ ok: true }); setValue.mockResolvedValue({ ok: true }); remove.mockResolvedValue({ ok: true });
  setStarlightApi({ userCheatsList: list, userCheatsSetActive: setActive, userCheatsSetValue: setValue, userCheatsRemove: remove } as unknown as StarlightApi);
  useUserCheatsStore.setState({ key: null, pid: null, items: [], pending: new Set(), errors: {}, confirm: null });
});

describe('MyCheatsSection', () => {
  it("shows the player's cheats as their own with a Needs updating badge", async () => {
    render(<MyCheatsSection cacheKey="tools-game" pid={7} attached />);
    expect(await screen.findByText('My cheats')).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ key: 'game', pid: 7 });
    expect(screen.getAllByText('Yours')).toHaveLength(2);
    const badge = screen.getByText('Needs updating');
    expect(badge.getAttribute('title')).toBe('site moved\nbytes differ');
    expect(screen.getAllByText('Needs updating')).toHaveLength(1);
  });

  it('toggling on a CE-owned game shows the close-table confirm; Continue retries with closeCe', async () => {
    setActive.mockResolvedValueOnce({ ok: false, error: 'ce', confirm: 'close-ce' });
    render(<MyCheatsSection cacheKey="game" pid={7} attached />);
    await userEvent.click(await screen.findByRole('button', { name: 'God mode: Off' }));
    expect(await screen.findByText(/This will close the current Cheat Engine table — continue\?/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(setActive).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'god', on: true, closeCe: true }));
  });

  it('Cancel leaves the CE table alone', async () => {
    setActive.mockResolvedValueOnce({ ok: false, error: 'ce', confirm: 'close-ce' });
    render(<MyCheatsSection cacheKey="game" pid={7} attached />);
    await userEvent.click(await screen.findByRole('button', { name: 'God mode: Off' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/This will close/)).toBeNull();
    expect(setActive).toHaveBeenCalledTimes(1);
  });

  it('a value cheat edits through setValue', async () => {
    render(<MyCheatsSection cacheKey="game" pid={7} attached />);
    const input = await screen.findByLabelText('Value of Gold');
    await userEvent.clear(input);
    await userEvent.type(input, '999{Enter}');
    expect(setValue).toHaveBeenCalledWith({ key: 'game', pid: 7, id: 'gold', value: 999 });
  });

  it('a value typed into an inactive set cheat is kept and sent when it is switched on', async () => {
    list.mockResolvedValue([{ cheat: gold, active: false, verify: null }]);
    render(<MyCheatsSection cacheKey="game" pid={7} attached />);
    const input = await screen.findByLabelText('Value of Gold');
    await userEvent.clear(input);
    await userEvent.type(input, '777');
    await userEvent.tab();
    expect((screen.getByLabelText('Value of Gold') as HTMLInputElement).value).toBe('777');
    await userEvent.click(screen.getByRole('button', { name: 'Gold: Off' }));
    expect(setActive).toHaveBeenCalledWith(expect.objectContaining({ id: 'gold', on: true, value: 777 }));
    expect(setValue).not.toHaveBeenCalled();
  });

  it('remove asks first', async () => {
    render(<MyCheatsSection cacheKey="game" pid={7} attached />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Gold' }));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(remove).toHaveBeenCalledWith({ key: 'game', id: 'gold' });
  });

  it('shows nothing when the game has no cheats', async () => {
    list.mockResolvedValue([]);
    const { container } = render(<MyCheatsSection cacheKey="game" pid={null} attached={false} />);
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });
});
