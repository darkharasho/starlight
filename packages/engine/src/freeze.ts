import type { Session } from './session.js';
import type { ValueType } from './types.js';
import { encodeValue } from './memory.js';

export interface FreezeSpec {
  address: string;
  type: Exclude<ValueType, 'string'>;
  value: number | bigint;
  intervalMs: number;
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
    bytes: encodeValue(spec.type, spec.value).toString('hex'),
    interval_ms: spec.intervalMs,
  });
  let active = true;
  session.onDetached(() => { active = false; });

  return {
    get active() { return active; },
    cancel: async () => {
      if (!active) return;
      active = false;
      // The daemon drops freezes when the process exits or the connection closes.
      if (!session.attached || session.client.closed) return;
      await session.client.call('unfreeze', { id });
    },
  };
}
