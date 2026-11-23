import type { Session } from './session.js';
import type { ModuleExport } from './types.js';

export async function moduleExports(s: Session, module: string): Promise<ModuleExport[]> {
  const r = await s.client.call<{ exports: ModuleExport[] }>('module_exports', { handle: s.handle, module });
  return r.exports;
}

/** Resolves an exported symbol to its address; export forwarders are followed. */
export async function resolveSymbol(s: Session, module: string, name: string): Promise<string> {
  const r = await s.client.call<{ address: string }>('resolve_symbol', { handle: s.handle, module, name });
  return r.address;
}
