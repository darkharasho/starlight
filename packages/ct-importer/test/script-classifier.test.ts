import { describe, it, expect } from 'vitest';
import { classifyScript } from '../src/script-classifier.js';

describe('classifyScript', () => {
  it('flags Lua scripts as unsupported', () => {
    const r = classifyScript({ luaScript: 'function blockLoop() end' });
    expect(r).toEqual({
      supported: false,
      reason: 'Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.',
    });
  });

  it('flags assembler scripts as unsupported in v1', () => {
    const r = classifyScript({ assemblerScript: '[ENABLE]\naobscanmodule(...)\n' });
    expect(r).toEqual({
      supported: false,
      reason: 'Cheat Engine assembler script. Open the original .CT in Cheat Engine.',
    });
  });

  it('returns supported=true when there is no script field', () => {
    expect(classifyScript({})).toEqual({ supported: true });
  });

  it('prefers the Lua message when both are present (rare but possible)', () => {
    const r = classifyScript({ luaScript: 'x', assemblerScript: 'y' });
    expect(r.supported).toBe(false);
    expect(r.reason).toContain('Lua');
  });
});
