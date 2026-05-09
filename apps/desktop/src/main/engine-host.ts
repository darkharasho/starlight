import {
  attach as engineAttach,
  read,
  write,
  resolvePointerChain,
  aobScan,
  freeze,
  type Session,
  type FreezeHandle,
  type ValueType,
  AttachError,
  PermissionError,
  ScanError,
  ReadError,
  WriteError,
} from '@starlight/engine';
import type {
  StarlightTrainer,
  StarlightSupportedCheat,
  StarlightAddress,
} from '@starlight/ct-importer';
import type { AttachResult, IpcResult } from '../shared/ipc.js';

let session: Session | null = null;
let activeTrainer: StarlightTrainer | null = null;
const freezeHandles = new Map<string, FreezeHandle>();
/** Last value chosen by the user per value-cheat (for setValue without freeze). */
const lastValues = new Map<string, number>();

export function currentSession(): Session | null { return session; }
export function setActiveTrainer(t: StarlightTrainer): void { activeTrainer = t; }

export async function attach(pid: number): Promise<AttachResult> {
  if (session) await detach();
  try {
    session = await engineAttach(pid);
    return { ok: true };
  } catch (err) {
    if (err instanceof PermissionError) return { ok: false, code: 'permission', message: err.message };
    if (err instanceof AttachError)     return { ok: false, code: 'not-found', message: err.message };
    return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function detach(): Promise<void> {
  for (const [, h] of freezeHandles) { try { await h.cancel(); } catch { /* ignore */ } }
  freezeHandles.clear();
  if (!session) return;
  try { await session.detach(); }
  catch { /* swallow */ }
  session = null;
}

export function isAttached(): boolean { return session !== null && session.attached; }

function findCheat(cheatId: string): StarlightSupportedCheat | undefined {
  if (!activeTrainer) return undefined;
  for (const c of activeTrainer.categories) {
    for (const x of c.cheats) {
      if (x.id === cheatId && !('unsupported' in x && x.unsupported)) return x as StarlightSupportedCheat;
    }
  }
  return undefined;
}

async function resolveAddress(s: Session, addr: StarlightAddress): Promise<string> {
  switch (addr.kind) {
    case 'absolute':
      return addr.address;
    case 'module':
      // module + offset — frida resolves module base at runtime
      return await resolvePointerChain(s, {
        module: addr.module,
        baseAddress: addr.offset,
        offsets: [],
      }).catch(() => addr.offset); // fallback: caller treats as absolute
    case 'pointer': {
      const args: Parameters<typeof resolvePointerChain>[1] = {
        baseAddress: addr.baseOffset,
        offsets: addr.offsets,
        ...(addr.module !== undefined ? { module: addr.module } : {}),
      };
      return resolvePointerChain(s, args);
    }
    case 'aob': {
      const matches = await aobScan(s, {
        module: addr.module,
        pattern: addr.pattern,
        ...(addr.offset !== undefined ? { resultOffset: parseInt(addr.offset, 16) } : {}),
      });
      if (matches.length === 0) throw new ScanError(`AOB scan returned no matches`);
      return matches[0]!;
    }
  }
}

export async function toggleCheat(cheatId: string, on: boolean): Promise<IpcResult> {
  if (!session)          return { ok: false, error: 'not attached' };
  const cheat = findCheat(cheatId);
  if (!cheat)            return { ok: false, error: `unknown cheat ${cheatId}` };

  try {
    if (!on) {
      const handle = freezeHandles.get(cheatId);
      if (handle) {
        await handle.cancel();
        freezeHandles.delete(cheatId);
      }
      return { ok: true };
    }

    // Cancel any prior handle (defensive)
    const prior = freezeHandles.get(cheatId);
    if (prior) { try { await prior.cancel(); } catch { /* ignore */ } }

    const address = await resolveAddress(session, cheat.address);
    const rawValue = lastValues.get(cheatId) ?? cheat.value ?? cheat.default ?? 0;
    const value: number = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
    const valueType = cheat.valueType as Exclude<ValueType, 'string'>;

    const handle = await freeze(session, {
      address,
      type: valueType,
      value: valueType === 'int64' || valueType === 'uint64' ? BigInt(value) : value,
      intervalMs: 50,
    });
    freezeHandles.set(cheatId, handle);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setCheatValue(cheatId: string, value: number): Promise<IpcResult> {
  if (!session) return { ok: false, error: 'not attached' };
  const cheat = findCheat(cheatId);
  if (!cheat)   return { ok: false, error: `unknown cheat ${cheatId}` };
  lastValues.set(cheatId, value);

  try {
    const address = await resolveAddress(session, cheat.address);
    const valueType = cheat.valueType as Exclude<ValueType, 'string'>;

    // If currently frozen, replace the freeze with the new value.
    const handle = freezeHandles.get(cheatId);
    if (handle) {
      await handle.cancel();
      const next = await freeze(session, {
        address,
        type: valueType,
        value: valueType === 'int64' || valueType === 'uint64' ? BigInt(value) : value,
        intervalMs: 50,
      });
      freezeHandles.set(cheatId, next);
    } else {
      // One-shot write
      await write(session, address, valueType,
        valueType === 'int64' || valueType === 'uint64' ? BigInt(value) : value);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Re-export `read` for callers that want to inspect current memory (Phase 5+)
export { read, ReadError, WriteError };
