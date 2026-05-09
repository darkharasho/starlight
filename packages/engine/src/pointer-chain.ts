import type { Session } from './session.js';
import type { PointerChainSpec } from './types.js';
import { ReadError } from './errors.js';

/* Resolves a pointer chain to a final address (hex string).
 *
 * Semantics, matching Cheat Engine: read 8 bytes (assumed 64-bit) at the base
 * address to get a pointer P. Then for each offset, do P = *(P + offset),
 * EXCEPT for the LAST offset, which is added without dereferencing — the
 * caller wants the final address, not the value behind it.
 */
export async function resolvePointerChain(
  session: Session,
  spec: PointerChainSpec,
): Promise<string> {
  const offsets = spec.offsets;
  if (offsets.length === 0) return spec.baseAddress;

  const script = await session.fridaSession.createScript(`
    rpc.exports = {
      walk: function(baseHex, offsetHexes) {
        try {
          let p = ptr(baseHex).readPointer();
          for (let i = 0; i < offsetHexes.length - 1; i++) {
            p = p.add(ptr(offsetHexes[i])).readPointer();
          }
          const last = p.add(ptr(offsetHexes[offsetHexes.length - 1]));
          return last.toString();  // "0x..."
        } catch (e) {
          return { error: String(e) };
        }
      }
    };
  `);
  await script.load();
  try {
    const exp = script.exports as { walk: (b: string, o: string[]) => Promise<string | { error: string }> };
    const result = await exp.walk(spec.baseAddress, offsets);
    if (typeof result === 'object' && 'error' in result) {
      throw new ReadError(`pointer chain failed: ${result.error}`);
    }
    return result;
  } finally {
    await script.unload();
  }
}
