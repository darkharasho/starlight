import type { Session } from './session.js';
import type { AobScanSpec } from './types.js';

export async function aobScan(session: Session, spec: AobScanSpec): Promise<string[]> {
  const { matches } = await session.client.call<{ matches: string[] }>('aob_scan', {
    handle: session.handle,
    ...(spec.module !== undefined ? { module: spec.module } : {}),
    pattern: spec.pattern,
  });
  if (spec.resultOffset === undefined) return matches;
  return matches.map((addr) => '0x' + (BigInt(addr) + BigInt(spec.resultOffset!)).toString(16));
}
