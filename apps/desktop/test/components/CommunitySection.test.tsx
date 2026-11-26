import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommunitySection } from '../../src/renderer/components/ce/CommunitySection.js';
import { useCommunityCheatsStore } from '../../src/renderer/stores/user-cheats-store.js';
import { setStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi, UserCheatView } from '../../src/shared/ipc.js';

const list = vi.fn();
const setActive = vi.fn();
const save = vi.fn();
const cheat = (id: string, name: string) => ({ id, name, type: 'toggle', valueType: 'int32', address: {} });
const view = (id: string, name: string, community: Partial<NonNullable<UserCheatView['community']>>, over: Partial<UserCheatView> = {}): UserCheatView => ({
  cheat: cheat(id, name) as never, active: false, verify: null,
  community: { credit: 'Mika', buildId: '555', platform: 'windows', bits: 64, older: false, ...community },
  ...over,
});

beforeEach(() => {
  list.mockReset(); setActive.mockReset(); save.mockReset();
  list.mockResolvedValue([
    view('c-aaa', 'Infinite gold', {}),
    view('c-bbb', 'God mode', { credit: null, buildId: null }),
    view('c-ccc', 'Infinite gold', { buildId: '400', older: true }),
  ]);
  setActive.mockResolvedValue({ ok: true });
  save.mockResolvedValue({ ok: true });
  setStarlightApi({ userCheatsList: list, userCheatsSetActive: setActive, communityCheatsSave: save } as unknown as StarlightApi);
  useCommunityCheatsStore.setState({ key: null, pid: null, items: [], pending: new Set(), errors: {}, confirm: null });
});

describe('CommunitySection', () => {
  it('shows_current_with_credit_and_build', async () => {
    render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached />);
    const section = await screen.findByRole('region', { name: 'Community' });
    expect(list).toHaveBeenCalledWith({ key: 'community-1234', pid: 7 });
    expect(within(section).getByText('Community')).toBeTruthy();
    expect(within(section).getByText('by Mika')).toBeTruthy();
    expect(within(section).getByText('made on build 555')).toBeTruthy();
    expect(within(section).getByText('by Anonymous')).toBeTruthy();
  });

  it('shows whose cheat a repair is based on', async () => {
    list.mockResolvedValue([view('c-aaa', 'Infinite gold', { credit: 'Bob', basedOn: { credit: 'Alice' } }), view('c-bbb', 'Ammo', { basedOn: { credit: null } })]);
    render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached />);
    expect(await screen.findByText('based on a cheat by Alice')).toBeTruthy();
    expect(screen.getByText('based on a cheat by Anonymous')).toBeTruthy();
  });

  it('older_versions_toggle', async () => {
    render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached />);
    await screen.findByText('by Mika');
    expect(screen.getAllByText('Infinite gold')).toHaveLength(1);
    expect(screen.queryByText('made on build 400')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Older versions' }));
    expect(screen.getAllByText('Infinite gold')).toHaveLength(2);
    expect(screen.getByText('made on build 400')).toBeTruthy();
  });

  it('nothing_turns_on_by_itself', async () => {
    render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached />);
    await screen.findByText('by Mika');
    expect(setActive).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'God mode: Off' }));
    expect(setActive).toHaveBeenCalledWith({ key: 'community-1234', pid: 7, id: 'c-bbb', on: true });
  });

  it('needs_update_state', async () => {
    list.mockResolvedValue([view('c-aaa', 'Infinite gold', {}, { verify: { status: 'needs-update', reasons: ['site moved'] } })]);
    render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached />);
    expect(await screen.findByText('Needs updating')).toBeTruthy();
  });

  it('save_to_my_cheats', async () => {
    render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached exeName="NewGame.exe" />);
    await screen.findByText('by Mika');
    await userEvent.click(screen.getByRole('button', { name: 'Save Infinite gold to my cheats' }));
    expect(save).toHaveBeenCalledWith({ key: 'community-1234', id: 'c-aaa', userKey: 'newgame', exeName: 'NewGame.exe' });
    expect(await screen.findByText('Saved to My cheats')).toBeTruthy();
  });

  it('has no Remove button', async () => {
    render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached />);
    await screen.findByText('by Mika');
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('hidden_when_empty', async () => {
    list.mockResolvedValue([]);
    const { container } = render(<CommunitySection steamAppId={1234} userKey="newgame" pid={7} attached />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });
});
