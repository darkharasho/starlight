import type { Session } from './session.js';
import type { PointerChainSpec } from './types.js';

/* Resolves a pointer chain to a final address (hex string).
 *
 * Semantics, matching Cheat Engine: read a pointer (4 or 8 bytes: starlightd uses the
 * game's pointer size, 4 for 32-bit games) at the base
 * address to get a pointer P. Then for each offset, do P = *(P + offset),
 * EXCEPT for the LAST offset, which is added without dereferencing — the
 * caller wants the final address, not the value behind it. The walk runs in
 * starlightd.
 */
export async function resolvePointerChain(
  session: Session,
  spec: PointerChainSpec,
): Promise<string> {
  const { address } = await session.client.call<{ address: string }>('resolve_pointer', {
    handle: session.handle,
    ...(spec.module !== undefined ? { module: spec.module } : {}),
    base: spec.baseAddress,
    offsets: spec.offsets,
  });
  return address;
}
