export class EngineError extends Error {
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
