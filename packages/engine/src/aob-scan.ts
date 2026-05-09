import type { Session } from './session.js';
import type { AobScanSpec } from './types.js';
import { ScanError } from './errors.js';

export async function aobScan(session: Session, spec: AobScanSpec): Promise<string[]> {
  const script = await session.fridaSession.createScript(`
    rpc.exports = {
      scan: function(moduleName, pattern) {
        const mod = Process.findModuleByName(moduleName);
        if (!mod) return { error: 'module not found: ' + moduleName };
        const matches = Memory.scanSync(mod.base, mod.size, pattern);
        return matches.map(m => m.address.toString());
      }
    };
  `);
  await script.load();
  try {
    const exp = script.exports as unknown as { scan: (m: string, p: string) => string[] | { error: string } };
    const result = await exp.scan(spec.module, spec.pattern);
    if (!Array.isArray(result)) throw new ScanError(result.error);
    if (spec.resultOffset !== undefined && result.length > 0) {
      return result.map(addr => '0x' + (BigInt(addr) + BigInt(spec.resultOffset!)).toString(16));
    }
    return result;
  } finally {
    await script.unload();
  }
}
