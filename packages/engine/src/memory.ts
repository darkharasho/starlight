import type { Session } from './session.js';
import type { ReadSpec, ValueType, StringSpec } from './types.js';
import { ReadError } from './errors.js';

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
  // Frida exposes a Memory.readByteArray(ptr, len) inside the agent. We run
  // a tiny script per call to keep the API stateless. For hot paths, callers
  // can build their own batched script via session.fridaSession.createScript().
  const script = await session.fridaSession.createScript(`
    rpc.exports = {
      read: function(addrHex, len) {
        const p = ptr(addrHex);
        return Array.from(new Uint8Array(p.readByteArray(len)));
      }
    };
  `);
  await script.load();
  try {
    const exp = script.exports as { read: (a: string, l: number) => Promise<number[]> };
    const arr = await exp.read(address, length);
    return Buffer.from(arr);
  } finally {
    await script.unload();
  }
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
