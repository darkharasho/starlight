import { createServer, type Server } from 'node:http';

interface PendingCommand {
  id: number;
  method: string;
  params?: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface BridgeOpts {
  /** Long-poll timeout in milliseconds. Default 5000. */
  pollTimeoutMs?: number;
}

export interface Bridge {
  url: string;
  port: number;
  /** Queue a command; resolves with CE's reply (or rejects on error). */
  send: (cmd: { method: string; params?: unknown }) => Promise<unknown>;
  close: () => Promise<void>;
}

interface Waiter {
  res: import('http').ServerResponse;
  timer: NodeJS.Timeout;
}

export async function createBridge(opts: BridgeOpts = {}): Promise<Bridge> {
  const pollTimeoutMs = opts.pollTimeoutMs ?? 5000;
  const queue: PendingCommand[] = [];
  const pending = new Map<number, PendingCommand>();
  let nextId = 1;
  const waiters: Waiter[] = [];

  function sendCommand(res: import('http').ServerResponse, cmd: PendingCommand): void {
    const body = JSON.stringify({
      id: cmd.id,
      method: cmd.method,
      ...(cmd.params !== undefined ? { params: cmd.params } : {}),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  function deliverNext(): void {
    while (queue.length > 0 && waiters.length > 0) {
      const w = waiters.shift()!;
      clearTimeout(w.timer);
      const cmd = queue.shift()!;
      sendCommand(w.res, cmd);
    }
  }

  const handler = (req: import('http').IncomingMessage, res: import('http').ServerResponse): void => {
    if (req.url === '/poll' && req.method === 'GET') {
      const next = queue.shift();
      if (next) { sendCommand(res, next); return; }
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.res === res);
        if (idx >= 0) waiters.splice(idx, 1);
        res.writeHead(204);
        res.end();
      }, pollTimeoutMs);
      waiters.push({ res, timer });
      return;
    }
    if (req.url === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let obj: { id?: unknown; result?: unknown; error?: unknown };
        try {
          obj = JSON.parse(body) as { id?: unknown; result?: unknown; error?: unknown };
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        const id = typeof obj.id === 'number' ? obj.id : NaN;
        const p = Number.isFinite(id) ? pending.get(id) : undefined;
        if (p) {
          pending.delete(id);
          if (typeof obj.error === 'string' && obj.error.length > 0) {
            p.reject(new Error(obj.error));
          } else {
            p.resolve(obj.result ?? null);
          }
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    port: addr.port,
    send: (cmd) => {
      let outerResolve!: (v: unknown) => void;
      let outerReject!: (e: Error) => void;
      // Attach a no-op catch immediately so Node doesn't fire
      // UnhandledPromiseRejection before the caller can await the result.
      const promise = new Promise<unknown>((res, rej) => {
        outerResolve = res;
        outerReject = rej;
      });
      promise.catch(() => { /* handled by caller */ });
      const id = nextId++;
      const p: PendingCommand = {
        id,
        method: cmd.method,
        ...(cmd.params !== undefined ? { params: cmd.params } : {}),
        resolve: outerResolve,
        reject: outerReject,
      };
      pending.set(id, p);
      queue.push(p);
      deliverNext();
      return promise;
    },
    close: () => {
      // Reject all pending and close any waiters.
      for (const p of pending.values()) p.reject(new Error('bridge closed'));
      pending.clear();
      for (const w of waiters) {
        clearTimeout(w.timer);
        try { w.res.writeHead(503); w.res.end(); } catch { /* ignore */ }
      }
      waiters.length = 0;
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
