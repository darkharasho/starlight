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

const Address = z.discriminatedUnion('kind', [
  AbsoluteAddress, ModuleRelativeAddress, PointerAddress, AobAddress,
]);

const Hotkeys = z.object({
  toggle: z.string().optional(),
  inc: z.string().optional(),
  dec: z.string().optional(),
}).optional();

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
  address: Address,
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

const Cheat = z.union([SupportedCheat, UnsupportedCheat]);

const Category = z.object({
  name: z.string(),
  cheats: z.array(Cheat),
});

export const StarlightTrainerSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  game: z.object({
    name: z.string(),
    steamAppId: z.number().int().optional(),
    processName: z.array(z.string()),
    version: z.string().optional(),
    platform: z.array(z.enum(['windows', 'linux', 'linux-proton', 'macos'])).min(1),
  }),
  metadata: z.object({
    author: z.string().optional(),
    source: z.object({
      url: z.string().url().optional(),
      convertedFrom: z.literal('.CT'),
    }),
    convertedAt: z.string().datetime().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  categories: z.array(Category),
});

export type StarlightTrainer = z.infer<typeof StarlightTrainerSchema>;
export type StarlightCheat = z.infer<typeof Cheat>;
export type StarlightSupportedCheat = z.infer<typeof SupportedCheat>;
export type StarlightUnsupportedCheat = z.infer<typeof UnsupportedCheat>;
export type StarlightCategory = z.infer<typeof Category>;
export type StarlightAddress = z.infer<typeof Address>;
export type StarlightValueType = z.infer<typeof ValueType>;
