import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { AttachError, EngineError, PermissionError, ReadError, RpcCode, ScanError, WriteError } from './errors.js';

export const PROTOCOL_VERSION = 2;

export interface EngineClient {
  call<T>(method: string, params: object): Promise<T>;
  onNotification(cb: (method: string, params: any) => void): () => void;
  onClose(cb: () => void): void;
  close(): Promise<void>;
  readonly closed: boolean;
  /** What the daemon supports, as reported by `hello`. */
  readonly capabilities: readonly string[];
}

/** Maps a starlightd JSON-RPC error code to the engine's error classes. */
export function mapRpcError(code: number, message: string): EngineError {
  const err = ((): EngineError => {
    switch (code) {
      case RpcCode.PermissionDenied: return new PermissionError(message);
      case RpcCode.ProcessNotFound: return new AttachError(message);
      case RpcCode.ReadFailed: return new ReadError(message);
      case RpcCode.WriteFailed: return new WriteError(message);
      case RpcCode.ModuleNotFound:
      case RpcCode.InvalidPattern: return new ScanError(message);
      default: return new EngineError(message);
    }
  })();
  err.code = code;
  return err;
}

interface Pending { resolve(v: unknown): void; reject(e: unknown): void }

function wrapSocket(socket: Socket): { client: EngineClient; setCapabilities(c: readonly string[]): void } {
  let nextId = 1;
  let closed = false;
  let capabilities: readonly string[] = [];
  const pending = new Map<number, Pending>();
  const notifyCbs = new Set<(method: string, params: any) => void>();
  const closeCbs: Array<() => void> = [];
  let buf = '';

  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(mapRpcError(msg.error.code, String(msg.error.message ?? 'starlightd error')));
      else p.resolve(msg.result);
    } else if (typeof msg.method === 'string') {
      for (const cb of [...notifyCbs]) cb(msg.method, msg.params);
    }
  };

  const onClosed = (): void => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) p.reject(new EngineError('starlightd connection closed'));
    pending.clear();
    for (const cb of closeCbs) cb();
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  });
  socket.on('error', () => { /* followed by 'close' */ });
  socket.on('close', onClosed);

  const client: EngineClient = {
    get closed() { return closed; },
    get capabilities() { return capabilities; },
    call<T>(method: string, params: object): Promise<T> {
      if (closed) return Promise.reject(new EngineError('starlightd connection closed'));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    onNotification(cb) {
      notifyCbs.add(cb);
      return () => { notifyCbs.delete(cb); };
    },
    onClose(cb) {
      if (closed) cb(); else closeCbs.push(cb);
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        closeCbs.push(resolve);
        socket.end();
        socket.destroy();
      });
    },
  };
  return { client, setCapabilities: (c) => { capabilities = Object.freeze([...c]); } };
}

export async function connectEngine(opts: { socketPath: string }): Promise<EngineClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(opts.socketPath);
    s.once('connect', () => { s.off('error', reject); resolve(s); });
    s.once('error', reject);
  });
  const { client, setCapabilities } = wrapSocket(socket);
  try {
    const hello = await client.call<{ protocol: number; capabilities?: unknown }>('hello', {});
    if (hello.protocol !== PROTOCOL_VERSION) {
      throw new EngineError(`starlightd protocol ${hello.protocol}, expected ${PROTOCOL_VERSION}`);
    }
    if (Array.isArray(hello.capabilities)) {
      setCapabilities(hello.capabilities.filter((c): c is string => typeof c === 'string'));
    }
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
}

/** How long `stop()` waits for starlightd to exit before SIGKILL. */
export const STOP_KILL_MS = 15_000;

export interface StartedEngine {
  client: EngineClient;
  pid: number;
  stop(): Promise<void>;
}

/** Spawns starlightd, waits for `READY 1`, and connects. `stop()` closes the daemon's stdin, which makes it exit. */
export async function startEngine(opts: {
  binary: string;
  socketPath: string;
  readyTimeoutMs?: number;
}): Promise<StartedEngine> {
  const child = spawn(opts.binary, ['--socket', opts.socketPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const stop = async (): Promise<void> => {
    child.stdin?.end();
    // Longer than the daemon's own exit (teardown 8 s + final detach 4 s, see starlightd's
    // cleanup.rs): killed mid-teardown, it would leave debug registers armed in the game and
    // the kernel's implicit detach could deliver a trap of ours to it.
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_KILL_MS);
    await exited;
    clearTimeout(killer);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new EngineError(`starlightd did not become ready within ${opts.readyTimeoutMs ?? 5000} ms`)),
        opts.readyTimeoutMs ?? 5000,
      );
      let out = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        out += chunk;
        if (/^READY 1$/m.test(out)) { clearTimeout(timer); resolve(); }
      });
      child.once('error', (e) => { clearTimeout(timer); reject(new EngineError(`failed to start starlightd: ${e.message}`, e)); });
      child.once('exit', (code, sig) => {
        clearTimeout(timer);
        reject(new EngineError(`starlightd exited before ready (${sig ?? code})`));
      });
    });
    const client = await connectEngine({ socketPath: opts.socketPath });
    return {
      client,
      pid: child.pid!,
      stop: async () => { await client.close(); await stop(); },
    };
  } catch (err) {
    child.stdin?.destroy();
    child.kill('SIGKILL');
    throw err;
  }
}
