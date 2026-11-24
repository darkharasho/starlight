import { z } from 'zod';
import { StarlightValueCheatSchema, StarlightPatchCheatSchema } from './starlight-format.js';

const omitted = { id: true, provenance: true, unsupported: true } as const;

const Name = z.string().min(1).max(80).describe('What the player sees, e.g. "Infinite gold".');

const ValueCheatDraft = StarlightValueCheatSchema.omit(omitted).extend({
  name: Name,
  type: z.enum(['freeze', 'set', 'toggle']).describe(
    '"freeze" holds `value` at the address; "set" writes a value the player picks (default/step/min/max); ' +
    '"toggle" is an on/off freeze of `value`. Use "patch" (with site and enable) to change code.'),
  valueType: StarlightValueCheatSchema.shape.valueType.describe('The value\'s type in memory, e.g. "int32", "float". "string" can\'t be a cheat.'),
  value: StarlightValueCheatSchema.shape.value.describe('The value to hold (freeze/toggle).'),
  address: StarlightValueCheatSchema.shape.address.describe(
    'Where the value lives. { kind: "pointer", module, baseOffset, offsets } (from pointer_scan), ' +
    '{ kind: "aob", module, pattern, offset? } (from make_signature) or { kind: "module", module, offset }. ' +
    'Hex strings like "0x5260". Never { kind: "absolute" }.'),
  verify: StarlightValueCheatSchema.shape.verify.describe(
    'save_cheat needs { range: { min, max } }: the values that make sense, so Starlight can tell when an update broke the cheat.'),
});
const PatchCheatDraft = StarlightPatchCheatSchema.omit(omitted).extend({
  name: Name,
  type: z.literal('patch').describe('A code patch: changes the game\'s code at an AOB site.'),
  site: StarlightPatchCheatSchema.shape.site.describe(
    'The code to patch: make_signature\'s `aob` ({ kind: "aob", module, pattern, offset? }). It must match exactly once. ' +
    'Steps refer to its address as "site".'),
  enable: StarlightPatchCheatSchema.shape.enable.describe(
    'Steps run in order when the cheat turns on; Starlight reverts them itself (leave out disable). ' +
    '{ op: "writeBytes", at, bytes } writes hex bytes ("9090"); ' +
    '{ op: "alloc", name, size, near? } allocates a code cave; ' +
    '{ op: "assemble", at, source } assembles x86-64 at an address; ' +
    '{ op: "registerSymbol", name, at } names an address. ' +
    '`at` is "site", "site+0x10", "site-0xd", an alloc or symbol name (± hex), "module+0x1234" or "0x…". ' +
    'save_cheat fills in writeBytes `original` from the running game.'),
  verify: StarlightPatchCheatSchema.shape.verify.describe(
    'Optional extra checks ({ bytes: [{ at?, expect }] }); save_cheat always stores a verify block.'),
});

/** The draft an agent passes to test_cheat / save_cheat: a value or patch cheat without id or provenance. */
export const AgentCheatDraftSchema = z.discriminatedUnion('type', [ValueCheatDraft, PatchCheatDraft]).describe(
  'A cheat draft in Starlight format (no id). A value cheat (type freeze/set/toggle, valueType, value, address, verify.range) ' +
  'or a patch cheat (type "patch", site, enable).');

export type AgentCheatDraft = z.infer<typeof ValueCheatDraft> | z.infer<typeof PatchCheatDraft>;

export function validateAgentCheat(
  draft: unknown,
  o: { forTest?: boolean } = {},
): { ok: true; cheat: AgentCheatDraft } | { ok: false; errors: string[] } {
  const parsed = AgentCheatDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'cheat'}: ${i.message}`) };
  }
  const cheat = parsed.data;
  const errors: string[] = [];

  if (cheat.type === 'patch') {
    if (!cheat.site) errors.push('site: agent-made code cheats need an aob site');
    if (cheat.disable !== undefined) errors.push('disable: leave disable out; Starlight reverts the enable steps itself');
    if (cheat.enable.length > 32) errors.push('enable: at most 32 steps');
    cheat.enable.forEach((step, i) => {
      if (step.op === 'aobScan') errors.push(`enable[${i}].op: agent-made cheats can't use aobScan; use site`);
      if (step.op === 'unregisterSymbol') errors.push(`enable[${i}].op: unregisterSymbol only belongs in a table's disable steps`);
      if (step.op !== 'alloc' && step.op !== 'registerSymbol') return;
      if (step.name === 'site' || step.name === 'address') errors.push(`enable[${i}].name: "site" and "address" are reserved`);
    });
  } else {
    if (cheat.address.kind === 'symbol') {
      errors.push("address: agent-made cheats can't use table symbols; use an aob, pointer or module address");
    } else if (cheat.address.kind === 'absolute') {
      errors.push("address: agent-made cheats can't use absolute addresses; use an aob, pointer or module address");
    } else if (cheat.address.kind === 'pointer' && !cheat.address.module) {
      errors.push('address: a pointer needs a module base (module + offsets)');
    }
    if (cheat.valueType === 'string') errors.push("valueType: string values can't be cheats yet");
    const range = cheat.verify?.range;
    if (!range) {
      if (!o.forTest) errors.push('verify.range: value cheats need a value range, e.g. { "min": 0, "max": 10000000 }');
    } else if (range.min > range.max) {
      errors.push('verify.range: min must not be greater than max');
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, cheat };
}
