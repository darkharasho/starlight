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
