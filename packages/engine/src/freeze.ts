import type { Session } from './session.js';
import type { ValueType } from './types.js';
import { encodeValue } from './memory.js';
import { EngineError } from './errors.js';

const INVALID_PARAMS = -32602;

/** A typed value, or raw bytes (a Buffer or hex text) for String and Array of byte records. */
export type FreezeSpec =
  | { address: string; type: Exclude<ValueType, 'string'>; value: number | bigint; intervalMs: number }
  | { address: string; bytes: Buffer | string; intervalMs: number };

function freezeBytes(spec: FreezeSpec): string {
  if (!('bytes' in spec)) return encodeValue(spec.type, spec.value).toString('hex');
  const hex = typeof spec.bytes === 'string' ? spec.bytes.replace(/\s+/g, '').toLowerCase() : spec.bytes.toString('hex');
  if (hex.length === 0) throw new EngineError("can't freeze empty bytes");
  if (!/^([0-9a-f]{2})+$/.test(hex)) throw new EngineError(`freeze bytes must be hex, got ${String(spec.bytes)}`);
  return hex;
}

export interface FreezeHandle {
  readonly active: boolean;
  cancel(): Promise<void>;
}

/** Starts a freeze loop in starlightd. The daemon rewrites the value every `intervalMs`. */
export async function freeze(session: Session, spec: FreezeSpec): Promise<FreezeHandle> {
  const { id } = await session.client.call<{ id: number }>('freeze', {
    handle: session.handle,
    address: spec.address,
    bytes: freezeBytes(spec),
    interval_ms: spec.intervalMs,
  });
  let active = true;
  const unsubscribe = session.onDetached(() => { active = false; });

  return {
    get active() { return active; },
    cancel: async () => {
      if (!active) return;
      active = false;
      unsubscribe();
      // The daemon drops freezes when the process exits or the connection closes.
      if (!session.attached || session.client.closed) return;
      try {
        await session.client.call('unfreeze', { id });
      } catch (err) {
        // The game exited and the daemon already dropped this freeze, before
        // its process_exited notification reached us: it's cancelled either way.
        if (err instanceof EngineError && err.code === INVALID_PARAMS && /unknown freeze id/.test(err.message)) return;
        throw err;
      }
    },
  };
}
