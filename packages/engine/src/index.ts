export { attach, type Session, type DetachReason } from './session.js';
export { connectEngine, startEngine, type EngineClient, type StartedEngine } from './client.js';
export { listModules, type ModuleInfo } from './modules.js';
export { read, write, type PrimitiveValue } from './memory.js';
export * from './types.js';
export {
  EngineError, AttachError, PermissionError,
  ReadError, WriteError, ScanError,
} from './errors.js';
export { resolvePointerChain } from './pointer-chain.js';
export { aobScan } from './aob-scan.js';
export { freeze, type FreezeSpec, type FreezeHandle } from './freeze.js';
