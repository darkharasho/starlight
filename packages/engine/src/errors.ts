export class EngineError extends Error {
  /** The JSON-RPC error code, when the error came from starlightd. */
  code: number | undefined;
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EngineError';
  }
}

export class AttachError extends EngineError { name = 'AttachError'; }
export class PermissionError extends AttachError { name = 'PermissionError'; }
export class ReadError extends EngineError { name = 'ReadError'; }
export class WriteError extends EngineError { name = 'WriteError'; }
export class ScanError extends EngineError { name = 'ScanError'; }

/** starlightd's JSON-RPC error codes. Errors keep the code in `EngineError.code`. */
export const RpcCode = {
  PermissionDenied: -32001,
  ProcessNotFound: -32002,
  ReadFailed: -32003,
  WriteFailed: -32004,
  ModuleNotFound: -32005,
  InvalidPattern: -32006,
  UnknownHandle: -32007,
  SymbolNotFound: -32008,
  UnknownId: -32009,
  AssembleFailed: -32010,
  AllocFailed: -32011,
  PtraceFailed: -32012,
  Busy: -32013,
  PatchConflict: -32014,
} as const;

/** A cheat's checks failed: the game was probably updated and the cheat has to be re-found. */
export class NeedsUpdateError extends EngineError {
  name = 'NeedsUpdateError';
  constructor(public readonly reasons: string[]) {
    super(`this cheat needs updating: ${reasons.join('; ')}`);
  }
}
