import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectEngine, mapRpcError, STOP_KILL_MS } from '../src/client.js';
import { attach } from '../src/session.js';
import { EngineError, PermissionError, RpcCode } from '../src/errors.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

type Handler = (method: string, id: number) => object;

async function fakeDaemon(handler: Handler): Promise<{ socketPath: string; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'starlight-fake-'));
  const socketPath = join(dir, 'sock');
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => {
    sockets.push(s);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const req = JSON.parse(buf.slice(0, nl)) as { id: number; method: string };
        buf = buf.slice(nl + 1);
        s.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...handler(req.method, req.id) }) + '\n');
      }
    });
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    close: async () => {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('EngineClient', () => {
  const cleanups: Array<() => Promise<void>> = [];
  let target: SpawnedTarget | undefined;
  afterEach(async () => {
    await target?.kill();
    target = undefined;
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it('rejects a daemon with the wrong protocol', async () => {
    const d = await fakeDaemon(() => ({ result: { protocol: 1, version: 'x', capabilities: [] } }));
    cleanups.push(d.close);
    await expect(connectEngine({ socketPath: d.socketPath })).rejects.toThrow(/protocol 1, expected 2/);
  });

  it('exposes capabilities from hello', async () => {
    const d = await fakeDaemon(() => ({ result: { protocol: 2, version: 'x', capabilities: ['read', 'scan'] } }));
    cleanups.push(d.close);
    const client = await connectEngine({ socketPath: d.socketPath });
    cleanups.push(() => client.close());
    expect(client.capabilities).toEqual(['read', 'scan']);
  });

  it('reports the real daemon\'s capabilities', async () => {
    const engine = await startTestEngine();
    cleanups.push(engine.stop);
    expect(engine.client.capabilities).toContain('freeze');
  });

  it('maps -32001 to PermissionError', async () => {
    const d = await fakeDaemon((method) =>
      method === 'hello'
        ? { result: { protocol: 2, version: 'x', capabilities: [] } }
        : { error: { code: -32001, message: 'ptrace denied' } });
    cleanups.push(d.close);
    const client = await connectEngine({ socketPath: d.socketPath });
    cleanups.push(() => client.close());
    await expect(attach(client, 1234)).rejects.toBeInstanceOf(PermissionError);
  });

  it('keeps protocol v2 codes on a plain EngineError', () => {
    const e = mapRpcError(RpcCode.Busy, 'site busy');
    expect(e.constructor).toBe(EngineError);
    expect(e.code).toBe(-32013);
    expect(RpcCode.PatchConflict).toBe(-32014);
  });

  it('rejects pending calls and fires onClose when the connection drops', async () => {
    const d = await fakeDaemon((method) =>
      method === 'hello' ? { result: { protocol: 2, version: 'x', capabilities: [] } } : { result: {} });
    cleanups.push(d.close);
    const client = await connectEngine({ socketPath: d.socketPath });
    let closed = false;
    client.onClose(() => { closed = true; });
    await d.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
    expect(client.closed).toBe(true);
    await expect(client.call('read', {})).rejects.toThrow(/connection closed/);
  });

  it('fires onDetached("process-exit") on process_exited', async () => {
    const engine = await startTestEngine();
    cleanups.push(engine.stop);
    target = await spawnTarget();
    const session = await attach(engine.client, target.pid);
    const reason = new Promise<string>((r) => session.onDetached(r));
    await target.kill();
    expect(await reason).toBe('process-exit');
    expect(session.attached).toBe(false);
  });

  it('detach() fires onDetached("manual") once', async () => {
    const engine = await startTestEngine();
    cleanups.push(engine.stop);
    target = await spawnTarget();
    const session = await attach(engine.client, target.pid);
    const reasons: string[] = [];
    session.onDetached((r) => reasons.push(r));
    await session.detach();
    await session.detach();
    await new Promise((r) => setTimeout(r, 50));
    expect(reasons).toEqual(['manual']);
    expect(session.attached).toBe(false);
  });
});

describe('startEngine stop timing', () => {
  it("waits longer than the daemon's own exit before SIGKILL", () => {
    // starlightd exits after its teardown deadline plus its final detach; killed earlier, it
    // would leave debug registers armed in the game.
    const src = readFileSync(new URL('../../starlightd/src/cleanup.rs', import.meta.url), 'utf8');
    const secs = (name: string): number => {
      const m = new RegExp(`const ${name}: Duration = Duration::from_secs\\((\\d+)\\)`).exec(src);
      expect(m, name).not.toBeNull();
      return Number(m![1]) * 1000;
    };
    expect(STOP_KILL_MS).toBeGreaterThan(secs('SHUTDOWN_DEADLINE') + secs('FINAL_DETACH'));
  });
});
