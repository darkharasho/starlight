// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startMcpHost, type McpHost } from '../../../src/main/agent/mcp-host.js';
import { createAgentServer } from '../../../src/main/agent/server.js';
import { ToolError, NOT_ATTACHED, type ActivitySink, type AgentAccess, type AgentClient, type ToolDef } from '../../../src/main/agent/tools.js';
import { listGamesTool } from '../../../src/main/agent/tools-session.js';
import { createPlayerPrompts } from '../../../src/main/agent/player-prompt.js';
import { DEFAULT_AGENT_PREFS } from '../../../src/shared/ipc.js';

const TOKEN = 'test-token-0123456789';

interface Finish { id: number; r: Parameters<ActivitySink['finish']>[1] }

function fakeActivity(): ActivitySink & { started: Array<{ id: number; tool: string; summary: string }>; finished: Finish[] } {
  let next = 1;
  const started: Array<{ id: number; tool: string; summary: string }> = [];
  const finished: Finish[] = [];
  return {
    started, finished,
    start(tool, summary) { const id = next++; started.push({ id, tool, summary }); return id; },
    finish(id, r) { finished.push({ id, r }); },
  };
}

const access: AgentAccess = {
  async require(_id, tier) {
    if (tier === 'open') return null;
    throw new ToolError(NOT_ATTACHED);
  },
};

const readTool: ToolDef<{ address: z.ZodString }> = {
  name: 'read', title: 'Read memory', description: 'Reads a value.', tier: 'attached', readOnly: true,
  input: { address: z.string() },
  run: async () => ({ value: '1' }),
  summarize: () => 'read',
};

const hosts: McpHost[] = [];
const clients: Client[] = [];
const blockers: NetServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const h of hosts.splice(0)) await h.close();
  for (const b of blockers.splice(0)) await new Promise<void>((r) => b.close(() => r()));
});

async function start(o: {
  port?: number; onSessionClosed?: (id: string) => void; activity?: ActivitySink; clients?: AgentClient[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: ToolDef<any>[]; idleTimeoutMs?: number; reapIntervalMs?: number; streamGraceMs?: number;
} = {}): Promise<McpHost> {
  const activity = o.activity ?? fakeActivity();
  const host = await startMcpHost({
    port: o.port ?? 0,
    ...(o.streamGraceMs !== undefined ? { streamGraceMs: o.streamGraceMs } : {}),
    ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : {}),
    ...(o.reapIntervalMs !== undefined ? { reapIntervalMs: o.reapIntervalMs } : {}),
    token: () => TOKEN,
    createServer: (id) => createAgentServer(id, {
      version: '9.9.9',
      tools: [
        listGamesTool({
          listProcesses: async () => [], manualExePaths: async () => [], installDirs: () => [],
          exePath: async () => null, identify: async () => { throw new Error('unused'); },
          detectAntiCheatFn: async () => null, attachedPid: () => null,
        }),
        readTool,
        ...(o.tools ?? []),
      ],
      access, activity,
      onClientInfo: (c) => o.clients?.push(c),
    }),
    onSessionClosed: o.onSessionClosed ?? (() => {}),
  });
  hosts.push(host);
  return host;
}

async function connect(host: McpHost, token = TOKEN): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'claude-code', version: '2.0.0' });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

function raw(port: number, headers: Record<string, string>, body = '{}', method = 'POST', path = '/mcp'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** initialize + notifications/initialized over plain HTTP; returns the session id. */
async function rawSession(port: number): Promise<string> {
  const h = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  const id = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', ...h,
    } }, (res) => { res.resume(); const sid = res.headers['mcp-session-id']; if (typeof sid === 'string') resolve(sid); else reject(new Error('no session')); });
    req.on('error', reject);
    req.end(INIT);
  });
  expect(await raw(port, { ...h, 'mcp-session-id': id }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBe(202);
  return id;
}

/** Opens the session's GET SSE stream; `close()` drops the socket like a client that exited. */
function openStream(port: number, id: string): Promise<{ status: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/mcp', headers: {
      host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'mcp-session-id': id,
    } }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, close: () => req.destroy() }); });
    req.on('error', () => {});
    req.on('close', () => {});
    req.end();
    req.on('error', reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });

describe('MCP host', () => {
  it('binds 127.0.0.1 only', async () => {
    const host = await start();
    expect(host.port).toBeGreaterThan(0);
    await expect(raw(host.port, { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}` }, INIT)).resolves.toBe(200);
  });

  it('rejects a missing or wrong token (401)', async () => {
    const host = await start();
    const h = { host: `127.0.0.1:${host.port}` };
    expect(await raw(host.port, h, INIT)).toBe(401);
    expect(await raw(host.port, { ...h, authorization: 'Bearer nope' }, INIT)).toBe(401);
    expect(await raw(host.port, { ...h, authorization: `Bearer ${TOKEN}x` }, INIT)).toBe(401);
    expect(await raw(host.port, { ...h, authorization: TOKEN }, INIT)).toBe(401);
    await expect(connect(host, 'wrong')).rejects.toThrow();
  });

  it('rejects requests that carry an Origin header (403)', async () => {
    const host = await start();
    expect(await raw(host.port, { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' }, INIT)).toBe(403);
    expect(await raw(host.port, { host: `localhost:${host.port}`, origin: `http://127.0.0.1:${host.port}` }, INIT)).toBe(403);
  });

  it('rejects a foreign Host header (403)', async () => {
    const host = await start();
    expect(await raw(host.port, { host: `attacker.example:${host.port}`, authorization: `Bearer ${TOKEN}` }, INIT)).toBe(403);
    expect(await raw(host.port, { host: '127.0.0.1:1', authorization: `Bearer ${TOKEN}` }, INIT)).toBe(403);
    expect(await raw(host.port, { host: '127.0.0.1', authorization: `Bearer ${TOKEN}` }, INIT)).toBe(403);
    expect(await raw(host.port, { host: `localhost:${host.port}`, authorization: `Bearer ${TOKEN}` }, INIT)).toBe(200);
  });

  it('rejects a body over 1 MiB (413) and unknown paths (404)', async () => {
    const host = await start();
    const h = { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}` };
    expect(await raw(host.port, h, 'x'.repeat(1024 * 1024 + 1))).toBe(413);
    expect(await raw(host.port, h, INIT, 'POST', '/other')).toBe(404);
    expect(await raw(host.port, h, '', 'PUT')).toBe(404);
    // Auth comes first: an unknown path without a token is still 401.
    expect(await raw(host.port, { host: h.host }, INIT, 'POST', '/other')).toBe(401);
  });

  it('rejects a streamed body over 1 MiB without a Content-Length (413)', async () => {
    const host = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: host.port, method: 'POST', path: '/mcp', headers: {
        host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'transfer-encoding': 'chunked',
      } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 17; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
  });

  it('reads the token on every request, so a rotated token applies at once', async () => {
    let token = TOKEN;
    const host = await startMcpHost({ port: 0, token: () => token, createServer: () => { throw new Error('unused'); }, onSessionClosed: () => {} });
    hosts.push(host);
    token = 'rotated-token';
    expect(await raw(host.port, { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}` }, INIT)).toBe(401);
  });

  it('lists the tools and the find-a-cheat prompt, with instructions', async () => {
    const seen: AgentClient[] = [];
    const host = await start({ clients: seen });
    const { client } = await connect(host);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('list_games');
    expect(tools.tools.find((t) => t.name === 'list_games')?.annotations?.readOnlyHint).toBe(true);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain('find-a-cheat');
    const p = await client.getPrompt({ name: 'find-a-cheat', arguments: { goal: 'infinite gold' } });
    expect(JSON.stringify(p.messages)).toContain('infinite gold');
    expect(client.getInstructions()).toContain('ask_player');
    expect(client.getServerVersion()).toMatchObject({ name: 'starlight', version: '9.9.9' });
    expect(seen).toEqual([{ mcpSessionId: expect.any(String), name: 'claude-code', version: '2.0.0', label: 'Claude' }]);
    const r = await client.callTool({ name: 'list_games', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toEqual({ games: [] });
  });

  it('falls back to a free port when the configured one is taken', async () => {
    const blocker = createNetServer();
    blockers.push(blocker);
    const taken = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port)));
    const host = await start({ port: taken });
    expect(host.port).not.toBe(taken);
    expect(host.portIsFallback).toBe(true);
    const { client } = await connect(host);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('closing a client session reports it', async () => {
    const closed = vi.fn();
    const host = await start({ onSessionClosed: closed });
    const { transport } = await connect(host);
    const id = transport.sessionId;
    expect(id).toBeTruthy();
    await transport.terminateSession();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(id));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closeSessions ends every session and reports it', async () => {
    const closed = vi.fn();
    const host = await start({ onSessionClosed: closed });
    const a = await connect(host);
    const b = await connect(host);
    await host.closeSessions();
    expect(closed).toHaveBeenCalledWith(a.transport.sessionId);
    expect(closed).toHaveBeenCalledWith(b.transport.sessionId);
    // The old session id is gone.
    expect(await raw(host.port, { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}`, 'mcp-session-id': a.transport.sessionId! },
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toBe(404);
  });

  it('a refused tool call is an isError result and an activity entry', async () => {
    const activity = fakeActivity();
    const host = await start({ activity });
    const { client } = await connect(host);
    const r = await client.callTool({ name: 'read', arguments: { address: '0x10' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]!.text).toBe(NOT_ATTACHED);
    expect(activity.started).toEqual([{ id: 1, tool: 'read', summary: 'read …' }]);
    expect(activity.finished).toEqual([{ id: 1, r: { status: 'refused', error: NOT_ATTACHED } }]);
  });

  it('closes a session that never opened a GET stream after 20 idle minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const closed = vi.fn();
    const host = await start({ onSessionClosed: closed, idleTimeoutMs: 20 * 60_000, reapIntervalMs: 60_000 });
    const id = await rawSession(host.port);
    const h = { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}`, 'mcp-session-id': id };
    const list = (): Promise<number> => raw(host.port, h, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(await list()).toBe(200);
    vi.advanceTimersByTime(19 * 60_000);
    expect(closed).not.toHaveBeenCalled();
    expect(await list()).toBe(200);  // a request resets the clock
    vi.advanceTimersByTime(19 * 60_000);
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * 60_000);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(id));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(await list()).toBe(404);
  });

  it('never closes a session while a request is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ToolDef<Record<string, never>> = {
      name: 'slow', title: 'Slow', description: 'Waits.', tier: 'open', readOnly: true, input: {},
      run: async () => { entered(); await gate; return { done: true }; },
      summarize: () => 'slow',
    };
    const closed = vi.fn();
    const host = await start({ onSessionClosed: closed, tools: [slow], idleTimeoutMs: 20 * 60_000, reapIntervalMs: 60_000 });
    const id = await rawSession(host.port);
    const h = { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}`, 'mcp-session-id': id };
    const call = raw(host.port, h, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } }));
    await started;
    vi.advanceTimersByTime(60 * 60_000);
    expect(closed).not.toHaveBeenCalled();
    release();
    expect(await call).toBe(200);
    await vi.waitFor(() => {
      vi.advanceTimersByTime(19 * 60_000);
      expect(closed).not.toHaveBeenCalled();
    });
    vi.advanceTimersByTime(2 * 60_000);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it('closes the server of a session whose initialize fails', async () => {
    const close = vi.fn(async () => {});
    const failConnect = { connect: async () => { throw new Error('connect failed'); }, close } as unknown as McpServer;
    const h1 = await startMcpHost({ port: 0, token: () => TOKEN, createServer: () => failConnect, onSessionClosed: () => {} });
    hosts.push(h1);
    expect(await raw(h1.port, { host: `127.0.0.1:${h1.port}`, authorization: `Bearer ${TOKEN}` }, INIT)).toBe(500);
    expect(close).toHaveBeenCalledTimes(1);

    const close2 = vi.fn(async () => {});
    const failHandle = {
      connect: async (t: { handleRequest: unknown }) => { t.handleRequest = async () => { throw new Error('handle failed'); }; },
      close: close2,
    } as unknown as McpServer;
    const closed = vi.fn();
    const h2 = await startMcpHost({ port: 0, token: () => TOKEN, createServer: () => failHandle, onSessionClosed: closed });
    hosts.push(h2);
    expect(await raw(h2.port, { host: `127.0.0.1:${h2.port}`, authorization: `Bearer ${TOKEN}` }, INIT)).toBe(500);
    expect(close2).toHaveBeenCalledTimes(1);
  });

  describe('the agent exiting ends its session (I1, D4)', () => {
    it('closing the GET stream with nothing in flight ends the session after the grace period', async () => {
      const closed = vi.fn();
      const host = await start({ onSessionClosed: closed, streamGraceMs: 150 });
      const id = await rawSession(host.port);
      const stream = await openStream(host.port, id);
      expect(stream.status).toBe(200);
      await sleep(250);
      expect(closed).not.toHaveBeenCalled();  // an open stream: the client is alive
      stream.close();
      await sleep(60);
      expect(closed).not.toHaveBeenCalled();  // still inside the grace period
      await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(id), { timeout: 2000 });
      expect(closed).toHaveBeenCalledTimes(1);
      expect(await raw(host.port, { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}`, 'mcp-session-id': id },
        JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }))).toBe(404);
    });

    it('a GET reconnect inside the grace period keeps the session', async () => {
      const closed = vi.fn();
      const host = await start({ onSessionClosed: closed, streamGraceMs: 200 });
      const id = await rawSession(host.port);
      const first = await openStream(host.port, id);
      first.close();
      await sleep(80);
      let second = await openStream(host.port, id);
      // The SDK allows one stream per session; the old one may still be winding down.
      for (let i = 0; second.status === 409 && i < 20; i++) { await sleep(10); second = await openStream(host.port, id); }
      expect(second.status).toBe(200);
      await sleep(400);
      expect(closed).not.toHaveBeenCalled();
      second.close();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(id), { timeout: 2000 });
    });

    it('a POST in flight holds the session open after the stream closes', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let entered!: () => void;
      const started = new Promise<void>((r) => { entered = r; });
      const slow: ToolDef<Record<string, never>> = {
        name: 'slow', title: 'Slow', description: 'Waits.', tier: 'open', readOnly: true, input: {},
        run: async () => { entered(); await gate; return { done: true }; },
        summarize: () => 'slow',
      };
      const closed = vi.fn();
      const host = await start({ onSessionClosed: closed, tools: [slow], streamGraceMs: 100 });
      const id = await rawSession(host.port);
      const stream = await openStream(host.port, id);
      const h = { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${TOKEN}`, 'mcp-session-id': id };
      const call = raw(host.port, h, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'slow', arguments: {} } }));
      await started;
      stream.close();
      await sleep(300);
      expect(closed).not.toHaveBeenCalled();  // the tool call is still running
      release();
      await call;
      await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(id), { timeout: 2000 });
    });

    it("a pending question resolves 'stopped' when the agent's sockets close", async () => {
      const prompts = createPlayerPrompts({
        notifier: { show: () => ({ close: () => {} }) }, focusAgentView: () => {}, onChange: () => {},
        hotkeys: { set: () => ({ ok: true as const }) }, prefs: async () => ({ ...DEFAULT_AGENT_PREFS }),
      });
      let result: unknown = null;
      const asked = vi.fn();
      const ask: ToolDef<Record<string, never>> = {
        name: 'ask', title: 'Ask', description: 'Asks.', tier: 'open', readOnly: true, input: {},
        run: async (_a, ctx) => {
          const p = prompts.ask({ question: 'q', answer: 'confirm', timeoutMs: 3_600_000, label: 'Claude', ...(ctx.signal ? { signal: ctx.signal } : {}) });
          asked();
          result = await p;
          return result;
        },
        summarize: () => 'ask',
      };
      const closed = vi.fn();
      const host = await start({ onSessionClosed: closed, tools: [ask], streamGraceMs: 100 });
      const { client } = await connect(host);
      void client.callTool({ name: 'ask', arguments: {} }, undefined, { timeout: 3_700_000 }).catch(() => {});
      await vi.waitFor(() => expect(asked).toHaveBeenCalled());
      expect(prompts.pending()).toHaveLength(1);
      // The agent process exits: its GET stream and the POST go away, and no DELETE is sent.
      await client.close();
      await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: 2000 });
      await vi.waitFor(() => expect(result).toEqual({ answered: false, reason: 'stopped' }), { timeout: 2000 });
      expect(prompts.pending()).toEqual([]);
    });

    it('a session with an open GET stream is not reaped at 20 minutes', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      const closed = vi.fn();
      const host = await start({ onSessionClosed: closed, idleTimeoutMs: 20 * 60_000, reapIntervalMs: 60_000 });
      const id = await rawSession(host.port);
      const stream = await openStream(host.port, id);
      vi.advanceTimersByTime(60 * 60_000);
      await sleep(20);
      expect(closed).not.toHaveBeenCalled();
      stream.close();
    });
  });
});
