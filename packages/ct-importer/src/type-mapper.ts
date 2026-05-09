import type { StarlightValueType } from './starlight-format.js';

const TABLE: Record<string, StarlightValueType> = {
  'byte': 'uint8',
  '2 bytes': 'int16',
  '4 bytes': 'int32',
  '8 bytes': 'int64',
  'float': 'float',
  'double': 'double',
  'string': 'string',
};

export function mapCtType(ctType: string): StarlightValueType | undefined {
  return TABLE[ctType.toLowerCase()];
}
