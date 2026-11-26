import type { EngineClient } from './client.js';
import type { Bits } from './process-info.js';

export type DetachReason = 'process-exit' | 'manual';

export interface Session {
  readonly pid: number;
  readonly handle: number;
  readonly attached: boolean;
  readonly client: EngineClient;
  /** How starlightd calls into the process (ELF class of its executable). */
  readonly processBits: Bits;
  /** The game code's bitness (pointer size, assembler); null while its exe isn't mapped yet. */
  codeBits(): Promise<Bits | null>;
  detach(): Promise<void>;
  /** Returns a function that removes the listener. */
  onDetached(cb: (reason: DetachReason) => void): () => void;
}

/** `mainModule`: the game's exe; when given, only it decides `codeBits`. */
export async function attach(client: EngineClient, pid: number, o: { mainModule?: string } = {}): Promise<Session> {
  const r = await client.call<{ handle: number; process_bits?: Bits; code_bits?: Bits | null }>('attach', {
    pid,
    ...(o.mainModule !== undefined ? { main_module: o.mainModule } : {}),
  });
  const { handle } = r;
  // Daemons before bitness support only ran 64-bit games.
  const processBits: Bits = r.process_bits ?? 64;

  let attached = true;
  const cbs: Array<(reason: DetachReason) => void> = [];
  const markDetached = (reason: DetachReason): void => {
    if (!attached) return;
    attached = false;
    unsubscribe();
    for (const cb of cbs) cb(reason);
  };

  const unsubscribe = client.onNotification((method, params) => {
    if (method === 'process_exited' && params?.handle === handle) markDetached('process-exit');
  });
  client.onClose(() => markDetached('process-exit'));

  return {
    pid,
    handle,
    client,
    processBits,
    async codeBits() {
      const i = await client.call<{ code_bits: Bits | null }>('target_info', { handle });
      return i.code_bits;
    },
    get attached() { return attached; },
    async detach() {
      if (!attached) return;
      try {
        await client.call('detach', { handle });
      } finally {
        markDetached('manual');
      }
    },
    onDetached(cb) {
      cbs.push(cb);
      return () => {
        const i = cbs.indexOf(cb);
        if (i !== -1) cbs.splice(i, 1);
      };
    },
  };
}
