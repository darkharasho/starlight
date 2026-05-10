// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { createBridge, type Bridge } from '../../src/main/ce-bridge.js';

let bridge: Bridge | undefined;
afterEach(async () => { await bridge?.close(); bridge = undefined; });

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ce-bridge', () => {
  it('roundtrips a command via /poll then /result', async () => {
    bridge = await createBridge();
    const promise = bridge.send({ method: 'ping' });
    const polled = await fetch(`${bridge.url}/poll`).then((r) => r.json()) as { id: number; method: string };
    expect(polled.method).toBe('ping');
    expect(typeof polled.id).toBe('number');
    await postJson(`${bridge.url}/result`, { id: polled.id, result: { ok: true } });
    const r = await promise;
    expect(r).toEqual({ ok: true });
  });

  it('long-polls /poll up to a timeout and returns 204 if no command', async () => {
    bridge = await createBridge({ pollTimeoutMs: 250 });
    const start = Date.now();
    const res = await fetch(`${bridge.url}/poll`);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(204);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it('delivers a queued command to a waiting /poll', async () => {
    bridge = await createBridge({ pollTimeoutMs: 2000 });
    // Start the poll first; no command in queue yet.
    const pollResPromise = fetch(`${bridge.url}/poll`);
    // Then queue a command — should release the waiter.
    const start = Date.now();
    const sendPromise = bridge.send({ method: 'ping' });
    const pollRes = await pollResPromise;
    expect(pollRes.status).toBe(200);
    const polled = await pollRes.json() as { id: number };
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    await postJson(`${bridge.url}/result`, { id: polled.id, result: { ok: true } });
    await sendPromise;
  });

  it('propagates errors via { id, error } body', async () => {
    bridge = await createBridge();
    const promise = bridge.send({ method: 'will-fail' });
    const polled = await fetch(`${bridge.url}/poll`).then((r) => r.json()) as { id: number };
    await postJson(`${bridge.url}/result`, { id: polled.id, error: 'something broke' });
    await expect(promise).rejects.toThrow('something broke');
  });

  it('returns 404 for unknown paths and 400 for malformed POST', async () => {
    bridge = await createBridge();
    const r1 = await fetch(`${bridge.url}/nope`);
    expect(r1.status).toBe(404);
    const r2 = await fetch(`${bridge.url}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(r2.status).toBe(400);
  });

  it('serializes commands FIFO across multiple polls', async () => {
    bridge = await createBridge();
    const p1 = bridge.send({ method: 'a' });
    const p2 = bridge.send({ method: 'b' });
    const first = await fetch(`${bridge.url}/poll`).then((r) => r.json()) as { id: number; method: string };
    const second = await fetch(`${bridge.url}/poll`).then((r) => r.json()) as { id: number; method: string };
    expect([first.method, second.method]).toEqual(['a', 'b']);
    await postJson(`${bridge.url}/result`, { id: first.id, result: 1 });
    await postJson(`${bridge.url}/result`, { id: second.id, result: 2 });
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
  });
});
