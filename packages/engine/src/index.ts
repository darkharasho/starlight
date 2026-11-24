export { attach, type Session, type DetachReason } from './session.js';
export { connectEngine, startEngine, type EngineClient, type StartedEngine } from './client.js';
export { listModules, type ModuleInfo } from './modules.js';
export { read, write, readMany, type PrimitiveValue } from './memory.js';
export * from './types.js';
export {
  EngineError, AttachError, PermissionError,
  ReadError, WriteError, ScanError, NeedsUpdateError, RpcCode,
} from './errors.js';
export { resolvePointerChain } from './pointer-chain.js';
export { aobScan } from './aob-scan.js';
export { freeze, type FreezeSpec, type FreezeHandle } from './freeze.js';
export { scanFirst, scanNext, scanResults, scanEnd, type FirstScanOptions, type NextScanOptions, type ScanResult } from './scan.js';
export { pointerScan, pointerResults, pointerRescan, pointerEnd } from './pointer-scan.js';
export { watchStart, type Watch } from './watch.js';
export { disassemble, makeSignature, assemble, alloc, free, patch } from './code.js';
export { setSpeed, getSpeed } from './speed.js';
export { moduleExports, resolveSymbol } from './symbols.js';
export {
  parseAddressExpr, resolveAddressExpr, resolveCheatAddress, verifyCheat, enableCheat, type RunningCheat,
  definedLabels, checkAssembles,
} from './cheats.js';
