export { attach, type Session } from './session.js';
export { read, write, type PrimitiveValue } from './memory.js';
export * from './types.js';
export {
  EngineError, AttachError, PermissionError,
  ReadError, WriteError, ScanError,
} from './errors.js';
export { resolvePointerChain } from './pointer-chain.js';
export { aobScan } from './aob-scan.js';
export { freeze, type FreezeSpec, type FreezeHandle } from './freeze.js';
