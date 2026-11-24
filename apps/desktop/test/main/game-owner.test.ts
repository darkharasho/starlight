// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createGameOwner } from '../../src/main/game-owner.js';

function setup(ce: { sessionId: string } | null = null) {
  const state = { ce };
  const order: string[] = [];
  const onChange = vi.fn();
  const owner = createGameOwner({
    ceSessionFor: (pid) => (pid === 10 ? state.ce : null),
    releaseCe: async (id) => { order.push(`release:${id}`); state.ce = null; },
    onChange,
  });
  return { owner, order, onChange };
}

describe('game-owner', () => {
  it('CE owns a pid with a live bridge', () => {
    const { owner } = setup({ sessionId: 's1' });
    expect(owner.ownerOf(10)).toEqual({ engine: 'ce', sessionId: 's1' });
    expect(owner.ownerOf(11)).toBeNull();
  });

  it('claim ends the CE session before holding', async () => {
    const { owner, order } = setup({ sessionId: 's1' });
    await owner.claim(10, 'agent');
    order.push(JSON.stringify(owner.ownerOf(10)));
    expect(order).toEqual(['release:s1', '{"engine":"starlightd","holders":["agent"]}']);
  });

  it('ownership lasts until the last holder releases', () => {
    const { owner, onChange } = setup();
    const a = owner.hold(10, 'agent');
    const u = owner.hold(10, 'user-cheats');
    expect(owner.ownerOf(10)).toEqual({ engine: 'starlightd', holders: ['agent', 'user-cheats'] });
    a();
    expect(owner.ownerOf(10)).toEqual({ engine: 'starlightd', holders: ['user-cheats'] });
    u();
    expect(owner.ownerOf(10)).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('release is idempotent', () => {
    const { owner } = setup();
    const a1 = owner.hold(10, 'agent');
    const a2 = owner.hold(10, 'agent');
    a1(); a1();
    expect(owner.holders(10)).toEqual(['agent']);
    a2();
    expect(owner.holders(10)).toEqual([]);
  });

  it('table is a starlightd holder; claims on a native game release nothing', async () => {
    // A native table session holds the game; no CE session exists for it.
    const { owner, order } = setup(null);
    const t = owner.hold(10, 'table');
    expect(owner.ownerOf(10)).toEqual({ engine: 'starlightd', holders: ['table'] });
    const a = await owner.claim(10, 'agent');
    const u = await owner.claim(10, 'user-cheats');
    expect(order).toEqual([]);
    expect(owner.holders(10)).toEqual(['table', 'agent', 'user-cheats']);
    a(); u();
    expect(owner.holders(10)).toEqual(['table']);
    t();
    expect(owner.ownerOf(10)).toBeNull();
  });
});
