import { z } from 'zod';

const ValueType = z.enum([
  'int8','uint8','int16','uint16','int32','uint32','int64','uint64','float','double','string',
]);

const PointerAddress = z.object({
  kind: z.literal('pointer'),
  module: z.string().optional(),
  baseOffset: z.string(),         // hex literal "0x..."
  offsets: z.array(z.string()),   // hex literals
});

const AbsoluteAddress = z.object({
  kind: z.literal('absolute'),
  address: z.string(),            // hex literal "0x..."
});

const ModuleRelativeAddress = z.object({
  kind: z.literal('module'),
  module: z.string(),
  offset: z.string(),             // hex literal "0x..."
});

const AobAddress = z.object({
  kind: z.literal('aob'),
  module: z.string(),
  pattern: z.string(),
  offset: z.string().optional(),  // hex; bytes added to first match
});

const SymbolAddress = z.object({
  kind: z.literal('symbol'),
  expr: z.string(),                  // symbol expression, e.g. "player+10"
  offsets: z.array(z.string()).optional(),  // hex literals, application order
});

const AddressV1 = z.discriminatedUnion('kind', [
  AbsoluteAddress, ModuleRelativeAddress, PointerAddress, AobAddress,
]);
const Address = z.discriminatedUnion('kind', [
  AbsoluteAddress, ModuleRelativeAddress, PointerAddress, AobAddress, SymbolAddress,
]);

const Hotkeys = z.object({
  toggle: z.string().optional(),
  inc: z.string().optional(),
  dec: z.string().optional(),
}).optional();

const Ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const Hex = z.string().regex(/^([0-9a-fA-F]{2})+$/);

const Verify = z.object({
  bytes: z.array(z.object({
    at: z.string().optional(),
    expect: z.string(),            // AOB pattern, ?? allowed
  })).optional(),
  range: z.object({ min: z.number(), max: z.number() }).optional(),
});

const Provenance = z.object({
  kind: z.enum(['ct-import', 'agent', 'manual']),
  agent: z.string().optional(),
  createdAt: z.string().datetime(),
  game: z.object({
    steamAppId: z.number().int().optional(),
    buildId: z.string().optional(),
    exeHash: z.string().optional(),
  }),
  /** The game code's bitness when the cheat was saved. */
  bits: z.union([z.literal(32), z.literal(64)]).optional(),
  /** The hash12 of the community cheat this one was copied from. */
  derivedFrom: z.string().optional(),
});

const PatchStep = z.discriminatedUnion('op', [
  z.object({ op: z.literal('alloc'), name: Ident, size: z.number().int().min(1).max(65536), near: z.string().optional() }),
  z.object({ op: z.literal('assemble'), at: z.string(), source: z.string().max(16384) }),
  z.object({ op: z.literal('writeBytes'), at: z.string(), bytes: Hex, original: Hex.optional() }),
  z.object({ op: z.literal('registerSymbol'), name: Ident, at: z.string() }),
  z.object({ op: z.literal('aobScan'), name: Ident, module: z.string().optional(), pattern: z.string() }),
  z.object({ op: z.literal('unregisterSymbol'), name: Ident }),
  /** CE's assert(at, bytes): enabling stops, before any write, unless the bytes at `at` match. */
  z.object({ op: z.literal('assert'), at: z.string(), pattern: z.string() }),
]);

const SupportedCheat = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(['freeze', 'set', 'toggle']),
  valueType: ValueType,
  /* type === 'freeze': value is the frozen value */
  value: z.union([z.number(), z.string()]).optional(),
  /* type === 'set': default/step/min/max wired into the stepper UI */
  default: z.number().optional(),
  step: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  address: AddressV1,
  hotkeys: Hotkeys,
  unsupported: z.literal(false).optional(),
});

const ValueCheat = SupportedCheat.extend({
  address: Address,
  verify: Verify.optional(),
  provenance: Provenance.optional(),
});

const PatchCheat = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal('patch'),
  site: AobAddress.optional(),
  enable: z.array(PatchStep).min(1),
  disable: z.array(PatchStep).optional(),
  verify: Verify.optional(),
  provenance: Provenance.optional(),
  hotkeys: Hotkeys,
  unsupported: z.literal(false).optional(),
});

const UnsupportedCheat = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  unsupported: z.literal(true),
  unsupportedReason: z.string(),
  originalSource: z.string().optional(),
});

const CheatV1 = z.union([SupportedCheat, UnsupportedCheat]);
const Cheat = z.union([ValueCheat, PatchCheat, UnsupportedCheat]);

const CategoryV1 = z.object({ name: z.string(), cheats: z.array(CheatV1) });
const Category = z.object({ name: z.string(), cheats: z.array(Cheat) });

const trainerShape = {
  id: z.string(),
  game: z.object({
    name: z.string(),
    steamAppId: z.number().int().optional(),
    processName: z.array(z.string()),
    version: z.string().optional(),
    platform: z.array(z.enum(['windows', 'linux', 'linux-proton', 'macos'])).min(1),
  }),
};
const metadataShape = {
  author: z.string().optional(),
  convertedAt: z.string().datetime().optional(),
  warnings: z.array(z.string()).optional(),
};

export const StarlightTrainerSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  ...trainerShape,
  metadata: z.object({
    ...metadataShape,
    source: z.object({ url: z.string().url().optional(), convertedFrom: z.literal('.CT') }),
  }),
  categories: z.array(CategoryV1),
});

export const StarlightTrainerSchemaV2 = z.object({
  schemaVersion: z.literal(2),
  ...trainerShape,
  metadata: z.object({
    ...metadataShape,
    source: z.object({ url: z.string().url().optional(), convertedFrom: z.enum(['.CT', 'starlight']) }),
  }),
  categories: z.array(Category),
});

export type StarlightTrainerV1 = z.infer<typeof StarlightTrainerSchemaV1>;
export type StarlightTrainerV2 = z.infer<typeof StarlightTrainerSchemaV2>;

export function upgradeTrainer(t: StarlightTrainerV1 | StarlightTrainerV2): StarlightTrainerV2 {
  return { ...t, schemaVersion: 2 };
}

export const StarlightTrainerSchema = z
  .union([StarlightTrainerSchemaV2, StarlightTrainerSchemaV1])
  .transform(upgradeTrainer);

export { ValueCheat as StarlightValueCheatSchema, PatchCheat as StarlightPatchCheatSchema };

export type StarlightTrainer = z.output<typeof StarlightTrainerSchema>;
export type StarlightCheat = z.infer<typeof Cheat>;
export type StarlightSupportedCheat = z.infer<typeof ValueCheat>;
export type StarlightUnsupportedCheat = z.infer<typeof UnsupportedCheat>;
export type StarlightCategory = z.infer<typeof Category>;
export type StarlightAddress = z.infer<typeof Address>;
export type StarlightValueType = z.infer<typeof ValueType>;
export type StarlightValueCheat = StarlightSupportedCheat;
export type StarlightPatchCheat = z.infer<typeof PatchCheat>;
export type StarlightPatchStep = z.infer<typeof PatchStep>;
export type StarlightVerify = z.infer<typeof Verify>;
export type StarlightProvenance = z.infer<typeof Provenance>;
export type StarlightSymbolAddress = z.infer<typeof SymbolAddress>;
export type StarlightAobAddress = z.infer<typeof AobAddress>;

export function isValueCheat(c: StarlightCheat): c is StarlightValueCheat {
  return !('unsupported' in c && c.unsupported === true) && c.type !== 'patch';
}
export function isPatchCheat(c: StarlightCheat): c is StarlightPatchCheat {
  return !('unsupported' in c && c.unsupported === true) && c.type === 'patch';
}
