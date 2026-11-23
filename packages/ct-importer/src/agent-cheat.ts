import { z } from 'zod';
import { StarlightValueCheatSchema, StarlightPatchCheatSchema } from './starlight-format.js';

const omitted = { id: true, provenance: true, unsupported: true } as const;

const ValueCheatDraft = StarlightValueCheatSchema.omit(omitted).extend({
  name: z.string().min(1).max(80),
  type: z.enum(['freeze', 'set', 'toggle']),
});
const PatchCheatDraft = StarlightPatchCheatSchema.omit(omitted).extend({
  name: z.string().min(1).max(80),
  type: z.literal('patch'),
});

const AgentCheatDraftSchema = z.discriminatedUnion('type', [ValueCheatDraft, PatchCheatDraft]);

export type AgentCheatDraft = z.infer<typeof ValueCheatDraft> | z.infer<typeof PatchCheatDraft>;

export function validateAgentCheat(
  draft: unknown,
  o: { forTest?: boolean } = {},
): { ok: true; cheat: AgentCheatDraft } | { ok: false; errors: string[] } {
  const parsed = AgentCheatDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const cheat = parsed.data;
  const errors: string[] = [];

  if (cheat.type === 'patch') {
    if (cheat.disable !== undefined) errors.push('disable: leave disable out; Starlight reverts the enable steps itself');
    if (cheat.enable.length > 32) errors.push('enable: at most 32 steps');
    cheat.enable.forEach((step, i) => {
      if (step.op !== 'alloc' && step.op !== 'registerSymbol') return;
      if (step.name === 'site' || step.name === 'address') errors.push(`enable[${i}].name: "site" and "address" are reserved`);
    });
  } else {
    if (cheat.address.kind === 'absolute') {
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
