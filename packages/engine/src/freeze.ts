import type { Session } from './session.js';
import type { ValueType } from './types.js';
import { write } from './memory.js';

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

export async function freeze(session: Session, spec: FreezeSpec): Promise<FreezeHandle> {
  let active = true;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async () => {
    if (!active) return;
    try {
      await write(session, spec.address, spec.type, spec.value);
    } catch {
      // swallow individual write errors; the loop keeps trying
    }
  };

  const interval = setInterval(() => { inFlight = tick(); }, spec.intervalMs);
  await tick(); // prime immediately

  return {
    get active() { return active; },
    cancel: async () => {
      if (!active) return;
      active = false;
      clearInterval(interval);
      await inFlight; // let any in-flight write settle
    },
  };
}
