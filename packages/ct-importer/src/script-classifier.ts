export interface ScriptInput {
  luaScript?: string;
  assemblerScript?: string;
}

export type ScriptClassification =
  | { supported: true }
  | { supported: false; reason: string };

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export function classifyScript(input: ScriptInput): ScriptClassification {
  if (asString(input.luaScript).trim().length > 0) {
    return {
      supported: false,
      reason: 'Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.',
    };
  }
  if (asString(input.assemblerScript).trim().length > 0) {
    return {
      supported: false,
      reason: 'Cheat Engine assembler script. Open the original .CT in Cheat Engine.',
    };
  }
  return { supported: true };
}
