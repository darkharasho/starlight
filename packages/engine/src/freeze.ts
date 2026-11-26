import type { Session } from './session.js';
import type { ValueType } from './types.js';
import { encodeValue } from './memory.js';
import { EngineError } from './errors.js';

const INVALID_PARAMS = -32602;

/**
 * A typed value, or raw bytes (a Buffer or hex text) for String and Array of byte records. With
 * `mask` (as long as the bytes) only its set bits are frozen, for bit fields (Binary records).
 */
export type FreezeSpec =
  | { address: string; type: Exclude<ValueType, 'string'>; value: number | bigint; intervalMs: number }
  | { address: string; bytes: Buffer | string; mask?: Buffer; intervalMs: number };

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
  const bytes = freezeBytes(spec);
  const mask = 'mask' in spec && spec.mask ? spec.mask.toString('hex') : undefined;
  if (mask !== undefined) {
    if (mask.length !== bytes.length) throw new EngineError('a freeze mask must be as long as its bytes');
    // An older daemon would ignore the mask and freeze the whole bytes, other bits included.
    if (!session.client.capabilities.includes('freeze_mask')) throw new EngineError("this engine can't freeze single bits; update Starlight");
  }
  const { id } = await session.client.call<{ id: number }>('freeze', {
    handle: session.handle,
    address: spec.address,
    bytes,
    ...(mask !== undefined ? { mask } : {}),
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
