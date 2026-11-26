import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareFlags, shareSummary, type CommunityCheatFile } from '@starlight/ct-importer';
import { createShareHost, SHARE_RELAY_URL } from '../../src/main/share-host.js';
import { saveUserCheat, type UserCheatDraft } from '../../src/main/user-cheats.js';

let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); dirs = []; });

const GAME = { name: 'Test Game', exeName: 'game.exe', proton: true, steamAppId: 1234 };
const value = (prov: Record<string, unknown>, over: Record<string, unknown> = {}): UserCheatDraft => ({
  name: 'Infinite gold', type: 'freeze', valueType: 'int32', value: 999,
  address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x10', offsets: ['0x4'] },
  verify: { range: { min: 0, max: 9999 } },
  provenance: { kind: 'agent', agent: 'claude-code 2.1', createdAt: '2026-11-20T10:11:12.000Z', game: { steamAppId: 1234, buildId: '555' }, bits: 64, ...prov },
  ...over,
} as UserCheatDraft);

async function setup(o: { draft?: UserCheatDraft; game?: Partial<typeof GAME>; fetch?: typeof fetch; liveBits?: (pid: number) => Promise<32 | 64 | null>; username?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sh-'));
  const userData = await mkdtemp(join(tmpdir(), 'sh-ud-'));
  dirs.push(dir, userData);
  const { id } = await saveUserCheat(dir, 'testgame', { ...GAME, ...o.game } as never, o.draft ?? value({}));
  const calls: Array<{ url: string; body: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fetchFn = o.fetch ?? (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ url: 'https://github.com/darkharasho/starlight/pull/7', state: 'open', duplicate: false }), { status: 200 });
  }) as typeof fetch;
  const host = createShareHost({
    dir, userData, appVersion: '0.5.11', fetch: fetchFn, now: () => new Date('2026-11-25T08:00:00.000Z'),
    ...(o.liveBits ? { liveBits: o.liveBits } : {}),
    ...(o.username !== undefined ? { username: o.username } : {}),
  });
  return { dir, userData, id, host, calls };
}

describe('share host', () => {
  it('preview_builds_the_file', async () => {
    const s = await setup();
    const p = await s.host.preview({ key: 'testgame', id: s.id, pid: null });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const f = JSON.parse(p.json) as CommunityCheatFile;
    expect(f.game).toEqual({ steamAppId: 1234, name: 'Test Game', platform: 'windows', bits: 64, buildId: '555' });
    expect('id' in f.cheat).toBe(false);
    expect('provenance' in f.cheat).toBe(false);
    expect(f.submittedAt).toBe('2026-11-25');
    expect(f.agent).toBe('claude-code 2.1');
    expect(p.flags).toEqual(shareFlags(f));
    expect(p.summary).toBe(shareSummary(f, p.flags));
    expect(p.already).toBeNull();
  });

  it('ct_import_cheats_are_not_shareable', async () => {
    const s = await setup({ draft: value({ kind: 'ct-import' }) });
    const p = await s.host.preview({ key: 'testgame', id: s.id, pid: null });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('Cheat Engine table');
  });

  it('old_cheat_without_bits_needs_the_game_running', async () => {
    const s = await setup({ draft: value({ bits: undefined }), liveBits: async () => 32 });
    const p = await s.host.preview({ key: 'testgame', id: s.id, pid: null });
    expect(p).toEqual({ ok: false, reason: "Start the game once so Starlight can tell whether it's 32- or 64-bit." });
    const live = await s.host.preview({ key: 'testgame', id: s.id, pid: 42 });
    expect(live.ok).toBe(true);
    if (live.ok) expect((JSON.parse(live.json) as CommunityCheatFile).game.bits).toBe(32);
  });

  it('refuses_the_username', async () => {
    const draft = value({}, { description: 'found by MStephens' });
    const s = await setup({ draft, username: 'mstephens' });
    const p = await s.host.preview({ key: 'testgame', id: s.id, pid: null });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('your user name');
    const short = await setup({ draft: value({}, { description: 'ab' }), username: 'ab' });
    expect((await short.host.preview({ key: 'testgame', id: short.id, pid: null })).ok).toBe(true);
  });

  it('no_steam_id_not_shareable', async () => {
    const s = await setup({ game: { steamAppId: null as never } });
    const p = await s.host.preview({ key: 'testgame', id: s.id, pid: null });
    expect(p.ok).toBe(false);
  });

  it('refuses a cheat the rules refuse, with the rule', async () => {
    const s = await setup({ draft: value({}, { verify: {} }) });
    const p = await s.host.preview({ key: 'testgame', id: s.id, pid: null });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/range/);
  });

  it('send_posts_and_records', async () => {
    const s = await setup();
    const r = await s.host.send({ key: 'testgame', id: s.id, pid: null });
    expect(r).toEqual({ ok: true, url: 'https://github.com/darkharasho/starlight/pull/7', state: 'open', duplicate: false });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(SHARE_RELAY_URL);
    expect(Object.keys(s.calls[0]!.body).sort()).toEqual(['appVersion', 'file', 'installId']);
    expect(s.calls[0]!.body.appVersion).toBe('0.5.11');
    expect(s.calls[0]!.body.installId).toMatch(/^[0-9a-f-]{36}$/);
    const state = JSON.parse(await readFile(join(s.userData, 'share.json'), 'utf8'));
    expect(Object.values(state.shared)).toEqual(['https://github.com/darkharasho/starlight/pull/7']);
    expect(state.installId).toBe(s.calls[0]!.body.installId);
    const again = await s.host.preview({ key: 'testgame', id: s.id, pid: null });
    expect(again.ok && again.already).toEqual({ url: 'https://github.com/darkharasho/starlight/pull/7' });
  });

  it('send_shows_relay_errors', async () => {
    const limited = await setup({ fetch: (async () => new Response(JSON.stringify({ error: 'Too many submissions today.' }), { status: 429 })) as typeof fetch });
    expect(await limited.host.send({ key: 'testgame', id: limited.id, pid: null })).toEqual({ ok: false, reason: 'Too many submissions today.' });
    const down = await setup({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    expect(await down.host.send({ key: 'testgame', id: down.id, pid: null })).toEqual({ ok: false, reason: "Couldn't reach the sharing service." });
  });

  it('credit_is_trimmed_and_optional', async () => {
    const s = await setup();
    const p = await s.host.preview({ key: 'testgame', id: s.id, pid: null, credit: '  Mika  ' });
    expect(p.ok && (JSON.parse(p.json) as CommunityCheatFile).credit).toBe('Mika');
    const blank = await s.host.preview({ key: 'testgame', id: s.id, pid: null, credit: '   ' });
    expect(blank.ok && 'credit' in JSON.parse(blank.json)).toBe(false);
  });
});
