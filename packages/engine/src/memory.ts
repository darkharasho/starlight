import type { Session } from './session.js';
import type { ReadSpec, ValueType, StringSpec } from './types.js';
import { ReadError, WriteError } from './errors.js';

export type PrimitiveValue = number | bigint | string;

const SIZE_OF: Record<ValueType, number> = {
  int8: 1, uint8: 1,
  int16: 2, uint16: 2,
  int32: 4, uint32: 4,
  int64: 8, uint64: 8,
  float: 4, double: 8,
  string: 0, // unused
};

async function readBytes(session: Session, address: string, length: number): Promise<Buffer> {
  const res = await session.client.call<{ bytes: string }>('read', { handle: session.handle, address, length });
  return Buffer.from(res.bytes, 'hex');
}

export async function read(session: Session, address: string, spec: ReadSpec): Promise<PrimitiveValue> {
  if (typeof spec === 'object' && spec.type === 'string') {
    return readString(session, address, spec);
  }
  const type = spec as ValueType;
  const buf = await readBytes(session, address, SIZE_OF[type]);
  switch (type) {
    case 'int8':   return buf.readInt8(0);
    case 'uint8':  return buf.readUInt8(0);
    case 'int16':  return buf.readInt16LE(0);
    case 'uint16': return buf.readUInt16LE(0);
    case 'int32':  return buf.readInt32LE(0);
    case 'uint32': return buf.readUInt32LE(0);
    case 'int64':  return buf.readBigInt64LE(0);
    case 'uint64': return buf.readBigUInt64LE(0);
    case 'float':  return buf.readFloatLE(0);
    case 'double': return buf.readDoubleLE(0);
    default: throw new ReadError(`unsupported type ${String(type)}`);
  }
}

async function readString(session: Session, address: string, spec: StringSpec): Promise<string> {
  const buf = await readBytes(session, address, spec.maxLength);
  if (spec.encoding === 'utf-8') {
    const nul = buf.indexOf(0);
    return buf.subarray(0, nul === -1 ? buf.length : nul).toString('utf8');
  }
  // utf-16le: terminate at null code unit
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf.readUInt16LE(i) === 0) return buf.subarray(0, i).toString('utf16le');
  }
  return buf.toString('utf16le');
}

/** Encodes a value as little-endian bytes for the given primitive type. */
export function encodeValue(type: Exclude<ValueType, 'string'>, value: number | bigint): Buffer {
  const buf = Buffer.alloc(SIZE_OF[type]);
  switch (type) {
    case 'int8':   buf.writeInt8(value as number, 0); break;
    case 'uint8':  buf.writeUInt8(value as number, 0); break;
    case 'int16':  buf.writeInt16LE(value as number, 0); break;
    case 'uint16': buf.writeUInt16LE(value as number, 0); break;
    case 'int32':  buf.writeInt32LE(value as number, 0); break;
    case 'uint32': buf.writeUInt32LE(value as number, 0); break;
    case 'int64':  buf.writeBigInt64LE(typeof value === 'bigint' ? value : BigInt(value), 0); break;
    case 'uint64': buf.writeBigUInt64LE(typeof value === 'bigint' ? value : BigInt(value), 0); break;
    case 'float':  buf.writeFloatLE(value as number, 0); break;
    case 'double': buf.writeDoubleLE(value as number, 0); break;
    default: throw new WriteError(`unsupported type ${String(type)}`);
  }
  return buf;
}

export async function write(
  session: Session,
  address: string,
  type: Exclude<ValueType, 'string'>,
  value: number | bigint,
): Promise<void> {
  const bytes = encodeValue(type, value).toString('hex');
  await session.client.call('write', { handle: session.handle, address, bytes });
}

/** Reads many ranges in one round trip (at most 4096 items of at most 4096 bytes). `null` means unreadable. */
export async function readMany(
  session: Session,
  items: Array<{ address: string; length: number }>,
): Promise<Array<Buffer | null>> {
  const res = await session.client.call<{ values: Array<string | null> }>('read_many', {
    handle: session.handle,
    items,
  });
  return res.values.map((v) => (v === null ? null : Buffer.from(v, 'hex')));
}
