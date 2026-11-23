// apps/desktop/src/main/agent/mcp-host.ts
//
// The MCP Streamable HTTP server that Claude Code / Codex connect to. It is the
// boundary that lets a local agent drive a memory editor, so every request is
// checked before any MCP handling, in this order:
//   1. an `Origin` header (browsers send one; CLI agents don't)   → 403
//   2. a `Host` other than 127.0.0.1:<port> / localhost:<port>     → 403 (DNS rebinding)
//   3. a missing or wrong `Authorization: Bearer <token>`           → 401
//   4. a body over 1 MiB                                            → 413
// Then POST/GET/DELETE /mcp go to the MCP session's transport (a new session
// on `initialize`), and anything else is 404. It binds 127.0.0.1 only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export const MAX_BODY_BYTES = 1024 * 1024;
const BIND_HOST = '127.0.0.1';

export interface McpHost {
  /** The port actually bound. */
  port: number;
  /** True when the configured port was taken and the OS picked `port`. */
  portIsFallback: boolean;
  /** Ends every MCP session (token rotation); each is reported through `onSessionClosed`. */
  closeSessions(): Promise<void>;
  /** Ends every session and stops listening. */
  close(): Promise<void>;
}

export interface McpHostOptions {
  port: number;
  /** Read on every request, so a rotated token applies at once. */
  token(): string;
  createServer(mcpSessionId: string): McpServer;
  onSessionClosed(mcpSessionId: string): void;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/** Constant-time compare of the presented token with the expected one. */
export function tokenMatches(presented: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);  // spend the same time either way
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer +(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

function reply(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify({ error: message }));
}

function replyRpc(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

type Body = { ok: true; value: unknown } | { ok: false; status: 413 | 400 };

function readJsonBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (b: Body): void => { if (!done) { done = true; resolve(b); } };
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ ok: false, status: 400 });
      }
    });
    req.on('error', () => finish({ ok: false, status: 400 }));
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => { server.off('listening', onListening); reject(err); };
    const onListening = (): void => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND_HOST);
  });
}

export async function startMcpHost(o: McpHostOptions): Promise<McpHost> {
  const sessions = new Map<string, SessionEntry>();
  let boundPort = 0;

  /** Forgets a session and reports it, once. */
  const endSession = (id: string): void => {
    if (!sessions.delete(id)) return;
    try { o.onSessionClosed(id); } catch { /* the listener's problem */ }
  };

  const newSession = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const id = randomUUID();
    let entry: SessionEntry | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: (sid) => { if (entry) sessions.set(sid, entry); },
      // DELETE /mcp: the client ended the session.
      onsessionclosed: (sid) => {
        const e = sessions.get(sid);
        endSession(sid);
        if (e) setImmediate(() => { void e.server.close().catch(() => {}); });
      },
    });
    transport.onclose = () => endSession(id);
    const server = o.createServer(id);
    entry = { transport, server };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    // An initialize that failed never made a session; don't keep its server.
    if (!sessions.has(id)) void server.close().catch(() => {});
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1. Browsers always send Origin on cross-origin and on POST requests.
    if (req.headers.origin !== undefined) return reply(res, 403, 'Forbidden');
    // 2. DNS rebinding: the name the client used must be ours.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return reply(res, 403, 'Forbidden');
    // 3. The per-install token.
    const presented = bearerOf(req);
    if (presented === null || !tokenMatches(presented, o.token())) {
      return reply(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
    }
    // 4. Body size, declared up front.
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.on('finish', () => req.destroy());
      return reply(res, 413, 'Request body too large', { connection: 'close' });
    }

    const path = (req.url ?? '').split('?')[0];
    const method = req.method ?? '';
    if (path !== '/mcp' || (method !== 'POST' && method !== 'GET' && method !== 'DELETE')) {
      req.resume();
      return reply(res, 404, 'Not found');
    }

    let body: unknown;
    if (method === 'POST') {
      const b = await readJsonBody(req);
      if (!b.ok) {
        if (b.status === 413) {
          res.on('finish', () => req.destroy());
          return reply(res, 413, 'Request body too large', { connection: 'close' });
        }
        return replyRpc(res, 400, -32700, 'Parse error');
      }
      body = b.value;
    }

    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid) {
      const entry = sessions.get(sid);
      if (!entry) return replyRpc(res, 404, -32001, 'Session not found');
      return entry.transport.handleRequest(req, res, body);
    }
    if (method === 'POST' && isInitializeRequest(body)) return newSession(req, res, body);
    return replyRpc(res, 400, -32000, 'Bad Request: No valid session ID provided');
  };

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) replyRpc(res, 500, -32603, 'Internal server error');
      else res.end();
    });
  });

  let portIsFallback = false;
  try {
    boundPort = await listen(http, o.port);
  } catch (err) {
    if (o.port === 0 || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    boundPort = await listen(http, 0);
    portIsFallback = true;
  }

  const closeSessions = async (): Promise<void> => {
    const all = [...sessions.entries()];
    await Promise.all(all.map(async ([id, e]) => {
      await e.server.close().catch(() => {});
      endSession(id);  // in case close didn't reach onclose
    }));
  };

  return {
    port: boundPort,
    portIsFallback,
    closeSessions,
    close: async () => {
      await closeSessions();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}
