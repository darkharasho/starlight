import { describe, it, expect } from 'vitest';
import { AgentCheatDraftSchema, validateAgentCheat } from '../src/agent-cheat.js';
import * as index from '../src/index.js';

const value = (over: Record<string, unknown> = {}) => ({
  name: 'Gold', type: 'freeze', valueType: 'int32', value: 999,
  address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x10', offsets: ['0x4'] },
  verify: { range: { min: 0, max: 10000000 } },
  ...over,
});
const patch = (over: Record<string, unknown> = {}) => ({
  name: 'No recoil', type: 'patch',
  site: { kind: 'aob', module: 'game.exe', pattern: '48 8B ??' },
  enable: [{ op: 'writeBytes', at: 'site', bytes: '90' }],
  ...over,
});
const errs = (r: ReturnType<typeof validateAgentCheat>) => (r.ok ? [] : r.errors);

describe('validateAgentCheat', () => {
  it('labels issues on the cheat itself "cheat: …", not ": …"', () => {
    const r = validateAgentCheat('not a cheat');
    expect(errs(r).length).toBeGreaterThan(0);
    for (const e of errs(r)) expect(e).toMatch(/^cheat: /);
    expect(errs(validateAgentCheat({ name: 'x', type: 'nope' }))[0]).toMatch(/^type: /);
  });
  it('exports the draft schema, which parses both kinds of draft', () => {
    expect(index.AgentCheatDraftSchema).toBe(AgentCheatDraftSchema);
    expect(AgentCheatDraftSchema.safeParse(value()).success).toBe(true);
    expect(AgentCheatDraftSchema.safeParse(patch()).success).toBe(true);
    expect(AgentCheatDraftSchema.safeParse({ ...value(), type: 'nope' }).success).toBe(false);
  });
  it('accepts a pointer value cheat with a range', () => {
    expect(validateAgentCheat(value()).ok).toBe(true);
  });
  it('rejects an absolute address with the exact message', () => {
    const r = validateAgentCheat(value({ address: { kind: 'absolute', address: '0x1' } }));
    expect(errs(r)).toContain("address: agent-made cheats can't use absolute addresses; use an aob, pointer or module address");
  });
  it('rejects a pointer without a module', () => {
    const r = validateAgentCheat(value({ address: { kind: 'pointer', baseOffset: '0x1', offsets: [] } }));
    expect(errs(r)).toContain('address: a pointer needs a module base (module + offsets)');
  });
  it('requires verify.range for value cheats unless forTest', () => {
    const msg = 'verify.range: value cheats need a value range, e.g. { "min": 0, "max": 10000000 }';
    expect(errs(validateAgentCheat(value({ verify: undefined })))).toContain(msg);
    expect(validateAgentCheat(value({ verify: undefined }), { forTest: true }).ok).toBe(true);
  });
  it('rejects min > max', () => {
    const r = validateAgentCheat(value({ verify: { range: { min: 5, max: 1 } } }));
    expect(errs(r)).toContain('verify.range: min must not be greater than max');
  });
  it('rejects a patch cheat with disable steps', () => {
    const r = validateAgentCheat(patch({ disable: [{ op: 'writeBytes', at: 'site', bytes: '90' }] }));
    expect(errs(r)).toContain('disable: leave disable out; Starlight reverts the enable steps itself');
  });
  it('rejects reserved step names and more than 32 steps', () => {
    const r = validateAgentCheat(patch({ enable: [{ op: 'alloc', name: 'site', size: 8 }] }));
    expect(errs(r)).toContain('enable[0].name: "site" and "address" are reserved');
    const many = Array.from({ length: 33 }, () => ({ op: 'writeBytes', at: 'site', bytes: '90' }));
    expect(errs(validateAgentCheat(patch({ enable: many })))).toContain('enable: at most 32 steps');
  });
  it('rejects string value cheats', () => {
    expect(errs(validateAgentCheat(value({ valueType: 'string' })))).toContain("valueType: string values can't be cheats yet");
  });
  it('reports zod issues as "path: message"', () => {
    const r = validateAgentCheat(value({ name: '' }));
    expect(errs(r).some((e) => e.startsWith('name: '))).toBe(true);
  });
});
