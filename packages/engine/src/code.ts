import type { EngineClient } from './client.js';
import type { Session } from './session.js';
import type { Instruction } from './types.js';

export async function disassemble(s: Session, address: string, count?: number): Promise<Instruction[]> {
  const r = await s.client.call<{ instructions: Instruction[] }>('disassemble', {
    handle: s.handle,
    address,
    ...(count !== undefined ? { count } : {}),
  });
  return r.instructions;
}

/** Builds a byte pattern for the code at `address` that `aobScan` finds again (wildcards `??`). */
export async function makeSignature(
  s: Session,
  address: string,
  maxLength?: number,
): Promise<{ pattern: string; module: string; length: number; unique: boolean; matches: number }> {
  const r = await s.client.call<{ pattern: string; module: string; length: number; unique: boolean; matches: number }>(
    'make_signature',
    { handle: s.handle, address, ...(maxLength !== undefined ? { max_length: maxLength } : {}) },
  );
  return { pattern: r.pattern, module: r.module, length: r.length, unique: r.unique, matches: r.matches };
}

/**
 * Assembles CE-style Intel syntax as if placed at `address`. Needs no game: pass an engine client,
 * or a session to resolve `module+offset` names against its modules.
 */
export async function assemble(
  s: Session | EngineClient,
  o: { address: string; source: string; symbols?: Record<string, string>; bits?: 32 | 64 },
): Promise<{ bytes: Buffer; labels: Record<string, string> }> {
  const client = 'client' in s ? s.client : s;
  const r = await client.call<{ bytes: string; labels: Record<string, string> }>('assemble', {
    ...('client' in s ? { handle: s.handle } : {}),
    address: o.address,
    source: o.source,
    ...(o.symbols !== undefined ? { symbols: o.symbols } : {}),
    ...(o.bits !== undefined ? { bits: o.bits } : {}),
  });
  return { bytes: Buffer.from(r.bytes, 'hex'), labels: r.labels };
}

/** Allocates memory in the game. Allocations are never freed automatically, not even on detach. */
export async function alloc(
  s: Session,
  o: { size: number; near?: string; prot?: 'rwx' | 'rw' | 'rx' },
): Promise<string> {
  const r = await s.client.call<{ address: string }>('alloc', {
    handle: s.handle,
    size: o.size,
    ...(o.near !== undefined ? { near: o.near } : {}),
    ...(o.prot !== undefined ? { prot: o.prot } : {}),
  });
  return r.address;
}

export async function free(s: Session, address: string): Promise<void> {
  await s.client.call('free', { handle: s.handle, address });
}

/** Writes code bytes with every thread stopped and records the originals. Reverts on `revert()` and on session end. */
export async function patch(
  s: Session,
  address: string,
  bytes: Buffer,
): Promise<{ id: number; original: Buffer; revert(force?: boolean): Promise<void> }> {
  const r = await s.client.call<{ id: number; original: string }>('patch', {
    handle: s.handle,
    address,
    bytes: bytes.toString('hex'),
  });
  return {
    id: r.id,
    original: Buffer.from(r.original, 'hex'),
    async revert(force = false) {
      await s.client.call('unpatch', { id: r.id, force });
    },
  };
}
