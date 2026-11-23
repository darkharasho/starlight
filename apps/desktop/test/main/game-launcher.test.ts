// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { launchUrl, launchGame } from '../../src/main/game-launcher.js';

describe('launchUrl', () => {
  it('builds each store\'s own launch link', () => {
    expect(launchUrl({ source: 'steam', appId: '2784470' })).toBe('steam://rungameid/2784470');
    expect(launchUrl({ source: 'heroic', appId: 'Fortnite' })).toBe('heroic://launch/Fortnite');
    expect(launchUrl({ source: 'lutris', appId: 'my-game' })).toBe('lutris:rungame/my-game');
    expect(launchUrl({ source: 'epic', appId: 'abc' })).toBe('com.epicgames.launcher://apps/abc?action=launch&silent=true');
  });
  it('has none for a hand-added game, or a Steam id that is not a number', () => {
    expect(launchUrl({ source: 'manual', appId: 'manual-x' })).toBeNull();
    expect(launchUrl({ source: 'steam', appId: '1; rm -rf' })).toBeNull();
  });
});

describe('launchGame', () => {
  const deps = () => ({ openExternal: vi.fn().mockResolvedValue(undefined), manualExePath: vi.fn().mockResolvedValue(null), spawnDetached: vi.fn() });

  it('starts a Steam game through Steam', async () => {
    const d = deps();
    expect(await launchGame({ source: 'steam', appId: '440', name: 'TF2' }, d)).toEqual({ ok: true });
    expect(d.openExternal).toHaveBeenCalledWith('steam://rungameid/440');
  });
  it('runs a hand-added native executable from its own folder', async () => {
    const d = deps();
    d.manualExePath.mockResolvedValue('/games/thing/thing.x86_64');
    expect(await launchGame({ source: 'manual', appId: 'm1', name: 'Thing' }, { ...d, platform: 'linux' })).toEqual({ ok: true });
    expect(d.spawnDetached).toHaveBeenCalledWith('/games/thing/thing.x86_64', '/games/thing');
  });
  it('explains why a hand-added Windows exe can\'t be started on Linux', async () => {
    const d = deps();
    d.manualExePath.mockResolvedValue('/games/thing/Thing.exe');
    const r = await launchGame({ source: 'manual', appId: 'm1', name: 'Thing' }, { ...d, platform: 'linux' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/start it from your launcher/) });
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });
  it('reports a launcher that refuses the link', async () => {
    const d = deps();
    d.openExternal.mockRejectedValue(new Error('no handler for steam://'));
    expect(await launchGame({ source: 'steam', appId: '440', name: 'TF2' }, d)).toEqual({ ok: false, error: 'no handler for steam://' });
  });
});
