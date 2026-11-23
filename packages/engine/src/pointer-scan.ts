import type { Session } from './session.js';
import type { PointerChainSpec } from './types.js';

export async function pointerScan(
  s: Session,
  o: { address: string; maxDepth?: number; maxOffset?: string; maxResults?: number; modules?: string[] },
): Promise<{ id: number; count: number; truncated: boolean }> {
  return s.client.call('pointer_scan', {
    handle: s.handle,
    address: o.address,
    ...(o.maxDepth !== undefined ? { max_depth: o.maxDepth } : {}),
    ...(o.maxOffset !== undefined ? { max_offset: o.maxOffset } : {}),
    ...(o.maxResults !== undefined ? { max_results: o.maxResults } : {}),
    ...(o.modules !== undefined ? { modules: o.modules } : {}),
  });
}

/** Pages of paths, shaped for `resolvePointerChain`. */
export async function pointerResults(
  s: Session,
  id: number,
  o: { offset?: number; limit?: number } = {},
): Promise<{ count: number; paths: PointerChainSpec[] }> {
  const r = await s.client.call<{ count: number; results: Array<{ module: string; base: string; offsets: string[] }> }>(
    'pointer_results',
    {
      id,
      ...(o.offset !== undefined ? { offset: o.offset } : {}),
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
    },
  );
  return {
    count: r.count,
    paths: r.results.map((p) => ({ module: p.module, baseAddress: p.base, offsets: p.offsets })),
  };
}

/**
 * Re-checks every path against `s` (for example after a game restart) and drops the ones that no
 * longer reach the target. Without `address` the session's last good target address is reused; a
 * successful rescan with a new `address` becomes the new target.
 */
export async function pointerRescan(s: Session, id: number, address?: string): Promise<{ count: number }> {
  return s.client.call('pointer_rescan', { id, handle: s.handle, ...(address !== undefined ? { address } : {}) });
}

export async function pointerEnd(s: Session, id: number): Promise<void> {
  await s.client.call('pointer_end', { id });
}
