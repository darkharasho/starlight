export interface ScriptInput {
  luaScript?: string;
  assemblerScript?: string;
}

export type ScriptClassification =
  | { supported: true }
  | { supported: false; reason: string };

export function classifyScript(input: ScriptInput): ScriptClassification {
  if (input.luaScript && input.luaScript.trim().length > 0) {
    return {
      supported: false,
      reason: 'Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.',
    };
  }
  if (input.assemblerScript && input.assemblerScript.trim().length > 0) {
    return {
      supported: false,
      reason: 'Cheat Engine assembler script. Open the original .CT in Cheat Engine.',
    };
  }
  return { supported: true };
}
