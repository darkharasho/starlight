import type { Session } from './session.js';

export interface ModuleInfo {
  name: string;
  base: string;
  size: string;
  path: string;
  kind: 'elf' | 'pe';
}

export async function listModules(session: Session): Promise<ModuleInfo[]> {
  const res = await session.client.call<{ modules: ModuleInfo[] }>('modules', { handle: session.handle });
  return res.modules;
}
