import { describe, it, expect } from 'vitest';
import { freeze } from '../src/freeze.js';
import { mapRpcError } from '../src/client.js';
import type { Session } from '../src/session.js';
import type { EngineClient } from '../src/client.js';

/** A session over a fake client: `unfreeze` answers with `unfreezeError` if set. */
function fakeSession(unfreezeError?: { code: number; message: string }, capabilities: string[] = ['freeze', 'freeze_mask']) {
  const listeners = new Set<(r: 'process-exit' | 'manual') => void>();
  let nextId = 1;
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    closed: false,
    capabilities,
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, ...params });
      if (method === 'freeze') return { id: nextId++ };
      if (method === 'unfreeze' && unfreezeError) throw mapRpcError(unfreezeError.code, unfreezeError.message);
      return {};
    },
  } as unknown as EngineClient;
  const session: Session = {
    pid: 1, handle: 1, attached: true, client,
    async detach() {},
    onDetached(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return { session, listeners, calls };
}

const spec = { address: '0x1000', type: 'int32' as const, value: 1, intervalMs: 50 };

describe('freeze handle', () => {
  it('a mask freezes only its bits, and needs a daemon with freeze_mask', async () => {
    const { session, calls } = fakeSession();
    await freeze(session, { address: '0x1000', bytes: Buffer.from([0xa0]), mask: Buffer.from([0xf0]), intervalMs: 50 });
    expect(calls.at(-1)).toMatchObject({ method: 'freeze', bytes: 'a0', mask: 'f0' });
    await expect(freeze(session, { address: '0x1000', bytes: 'a0', mask: Buffer.from([0xf0, 0xff]), intervalMs: 50 })).rejects.toThrow(/mask/);
    const old = fakeSession(undefined, ['freeze']);
    await expect(freeze(old.session, { address: '0x1000', bytes: 'a0', mask: Buffer.from([0xf0]), intervalMs: 50 })).rejects.toThrow(/bit/);
  });

  it('treats "unknown freeze id" as already cancelled (the daemon dropped it when the game exited)', async () => {
    const { session } = fakeSession({ code: -32602, message: 'unknown freeze id: 1' });
    const h = await freeze(session, spec);
    await expect(h.cancel()).resolves.toBeUndefined();
    expect(h.active).toBe(false);
  });

  it('still reports other unfreeze errors', async () => {
    const { session } = fakeSession({ code: -32603, message: 'boom' });
    const h = await freeze(session, spec);
    await expect(h.cancel()).rejects.toThrow('boom');
  });

  it('does not pile up detach listeners across freezes', async () => {
    const { session, listeners } = fakeSession();
    for (let i = 0; i < 5; i++) {
      const h = await freeze(session, spec);
      await h.cancel();
    }
    expect(listeners.size).toBe(0);
  });
});
