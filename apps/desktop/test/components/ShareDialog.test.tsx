import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyCheatsSection } from '../../src/renderer/components/ce/MyCheatsSection.js';
import { useUserCheatsStore } from '../../src/renderer/stores/user-cheats-store.js';
import { useShareStore } from '../../src/renderer/stores/share-store.js';
import { setStarlightApi } from '../../src/renderer/ipc-client.js';
import type { StarlightApi } from '../../src/shared/ipc.js';

const list = vi.fn();
const preview = vi.fn();
const send = vi.fn();
const PROV = { createdAt: '2026-11-20T00:00:00.000Z', game: {} };
const mine = { id: 'gold', name: 'Gold', type: 'freeze', valueType: 'int32', address: {}, provenance: { kind: 'agent', ...PROV } };
const imported = { id: 'hp', name: 'HP', type: 'freeze', valueType: 'int32', address: {}, provenance: { kind: 'ct-import', ...PROV } };
const PREVIEW = { ok: true, json: '{\n  "schemaVersion": 1\n}', summary: '## Gold\n- **Game:** Test', flags: [], already: null };
const PR = 'https://github.com/darkharasho/starlight/pull/7';

beforeEach(() => {
  list.mockReset(); preview.mockReset(); send.mockReset();
  list.mockResolvedValue([{ cheat: mine, active: false, verify: null }, { cheat: imported, active: false, verify: null }]);
  preview.mockResolvedValue(PREVIEW);
  send.mockResolvedValue({ ok: true, url: PR, state: 'open', duplicate: false });
  setStarlightApi({ userCheatsList: list, shareCheatPreview: preview, shareCheatSend: send } as unknown as StarlightApi);
  useUserCheatsStore.setState({ key: null, pid: null, items: [], pending: new Set(), errors: {}, confirm: null });
  useShareStore.getState().close();
});

async function openShare() {
  render(<MyCheatsSection cacheKey="tools-game" pid={7} attached />);
  await userEvent.click(await screen.findByRole('button', { name: 'Share Gold' }));
  return await screen.findByRole('dialog', { name: 'Share Gold' });
}

describe('Share', () => {
  it('share_button_only_on_own_cheats', async () => {
    render(<MyCheatsSection cacheKey="tools-game" pid={7} attached />);
    expect(await screen.findByRole('button', { name: 'Share Gold' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share HP' })).toBeNull();
  });

  it('dialog_shows_summary_and_exact_json', async () => {
    const d = await openShare();
    expect(preview).toHaveBeenCalledWith({ key: 'game', id: 'gold', pid: 7 });
    expect(within(d).getByText(/Game:/)).toBeTruthy();
    expect(d.querySelector('pre')!.textContent).toBe(PREVIEW.json);
    expect(within(d).getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('send_shows_link', async () => {
    const d = await openShare();
    await userEvent.click(within(d).getByRole('button', { name: 'Send' }));
    expect(await within(d).findByText('Submitted for review')).toBeTruthy();
    expect(within(d).getByRole('link').getAttribute('href')).toBe(PR);
  });

  it('already submitted shows the link without Send', async () => {
    preview.mockResolvedValue({ ...PREVIEW, already: { url: PR } });
    const d = await openShare();
    expect(await within(d).findByText('Already submitted')).toBeTruthy();
    expect(within(d).getByRole('link').getAttribute('href')).toBe(PR);
    expect(within(d).queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('a declined duplicate says so', async () => {
    send.mockResolvedValue({ ok: true, url: PR, state: 'declined', duplicate: true });
    const d = await openShare();
    await userEvent.click(within(d).getByRole('button', { name: 'Send' }));
    expect(await within(d).findByText('This cheat was reviewed and not accepted.')).toBeTruthy();
  });

  it('preview_refusal_shown', async () => {
    preview.mockResolvedValue({ ok: false, reason: "Start the game once so Starlight can tell whether it's 32- or 64-bit." });
    const d = await openShare();
    expect(await within(d).findByText("Start the game once so Starlight can tell whether it's 32- or 64-bit.")).toBeTruthy();
    expect(within(d).queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('send failure shows the reason', async () => {
    send.mockResolvedValue({ ok: false, reason: 'Too many submissions today.' });
    const d = await openShare();
    await userEvent.click(within(d).getByRole('button', { name: 'Send' }));
    expect(await within(d).findByText('Too many submissions today.')).toBeTruthy();
  });

  it('credit_reaches_send', async () => {
    const d = await openShare();
    await userEvent.type(within(d).getByLabelText('Credit as'), 'Mika');
    await userEvent.click(within(d).getByRole('button', { name: 'Send' }));
    expect(send).toHaveBeenCalledWith({ key: 'game', id: 'gold', pid: 7, credit: 'Mika' });
    expect(preview).toHaveBeenLastCalledWith({ key: 'game', id: 'gold', pid: 7, credit: 'Mika' });
  });

  it('Cancel closes the dialog', async () => {
    const d = await openShare();
    await userEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
