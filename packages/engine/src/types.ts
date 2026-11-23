export type ValueType =
  | 'int8'  | 'uint8'
  | 'int16' | 'uint16'
  | 'int32' | 'uint32'
  | 'int64' | 'uint64'
  | 'float' | 'double'
  | 'string';

export interface StringSpec {
  type: 'string';
  encoding: 'utf-8' | 'utf-16le';
  maxLength: number;
}

export type ReadSpec = ValueType | StringSpec;

export interface PointerChainSpec {
  module?: string;
  baseAddress: string;     // hex literal "0x..."
  offsets: string[];       // hex literals
}

export interface AobScanSpec {
  module: string;
  pattern: string;         // e.g. "DE AD BE EF ?? ?? CA FE"
  resultOffset?: number;   // bytes added to every match
}

/** What a value scan can look for: every value type, plus raw `bytes` (an AOB pattern). */
export type ScanType = ValueType | 'bytes';

export type FirstScanMode = 'exact' | 'bigger' | 'smaller' | 'range' | 'unknown';

export type NextScanMode =
  | 'exact' | 'bigger' | 'smaller' | 'range'
  | 'changed' | 'unchanged'
  | 'increased' | 'decreased' | 'increased_by' | 'decreased_by';

/** One watchpoint hit: the instruction that touched the watched address. */
export interface Hit {
  /** Start of the instruction, or null when it could not be decoded. */
  address: string | null;
  /** Address right after the instruction (the trapped RIP). Always present. */
  next: string;
  module: string | null;
  text: string;
  count: number;
  /** The first register snapshot seen for this site; every value is a "0x…" string. */
  registers: Record<string, string>;
}

export interface WatchReport {
  active: boolean;
  reason: null | 'timeout' | 'max_hits' | 'stopped' | 'process_exited' | 'detached';
  hits: Hit[];
}

export interface Instruction {
  address: string;
  length: number;
  bytes: string;
  /** CE-style Intel text; `assemble` accepts it back. */
  text: string;
  symbol: string | null;
  target?: { address: string; symbol: string | null };
}

export interface SpeedHook {
  name: string;
  address: string;
  status: 'hooked' | 'skipped';
  reason?: string;
}

export interface SpeedStatus {
  speed: number;
  hooks: SpeedHook[];
}

export interface ModuleExport {
  name: string;
  address: string;
  kind: 'func' | 'ifunc' | 'object';
  forwarder?: string;
}

export interface VerifyResult {
  status: 'ok' | 'needs-update' | 'unverified';
  reasons: string[];
}
