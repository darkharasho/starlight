import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read } from '../src/memory.js';
import { luaOpen } from '../src/lua.js';
import { EngineError } from '../src/errors.js';
import { startTestEngine } from './helpers/daemon.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('Lua states', () => {
  let engine: Awaited<ReturnType<typeof startTestEngine>>;
  let target: SpawnedTarget | undefined;
  let session: Session | undefined;

  beforeAll(async () => { engine = await startTestEngine(); });
  afterAll(async () => { await engine.stop(); });
  afterEach(async () => {
    await session?.detach();
    await target?.kill();
    session = undefined;
    target = undefined;
  });

  it('runs chunks with the registry, returns effects, and closes', async () => {
    target = await spawnTarget({ args: ['--writer'] });
    session = await attach(engine.client, target.pid);
    const lua = await luaOpen(session);
    const counter = target.addresses.g_counter!;

    const r1 = await lua.run(`registerSymbol("x", ${counter}) return "ok"`, { name: 't', symbols: new Map() });
    expect(r1).toMatchObject({ ok: true, returned: 'ok', notices: [] });
    expect(r1.effects).toEqual([{ op: 'registerSymbol', name: 'x', address: counter.toLowerCase() }]);

    const r2 = await lua.run('return tostring(readInteger("X"))', { name: 't', symbols: new Map([['x', counter]]) });
    const now = (await read(session, counter, 'int32')) as number;
    expect(r2.ok).toBe(true);
    expect(Math.abs(Number(r2.ok && r2.returned) - now)).toBeLessThan(1000);

    const r3 = await lua.run('showMessage("hi") error("boom")', { name: 't', symbols: new Map() });
    expect(r3).toEqual({ ok: false, error: 'boom', line: 1, effects: [], notices: [{ kind: 'message', text: 'hi' }] });

    await lua.close();
    await expect(lua.run('return 1', { name: 't', symbols: new Map() })).rejects.toBeInstanceOf(EngineError);
  });
});
