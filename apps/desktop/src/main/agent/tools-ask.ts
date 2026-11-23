// apps/desktop/src/main/agent/tools-ask.ts
//
// ask_player: the agent asks the player a question while they sit at the game.
// It is shown as a desktop notification and in the app; the player answers
// with the global yes/no hotkeys or in the app.
import { z } from 'zod';
import type { AgentPreferences } from '../../shared/ipc.js';
import type { AskRequest, AskResult } from './player-prompt.js';
import { ToolError, type ToolDef } from './tools.js';

const input = {
  question: z.string().min(1).max(500).describe('What to ask. Keep it short and answerable at the game, e.g. "Did your gold change?".'),
  answer: z.enum(['number', 'confirm', 'choice']).describe(
    '"confirm" is yes/no (the player can answer with a hotkey without leaving the game), "number" is a typed number, "choice" is one of `choices`.'),
  choices: z.array(z.string().min(1).max(100)).min(2).max(8).optional().describe('Required for answer "choice".'),
  timeout_s: z.number().int().min(10).max(3600).optional().describe("How long to wait. Defaults to the player's setting (5 minutes)."),
};

export function askPlayerTool(
  prompts: { ask(q: AskRequest): Promise<AskResult> },
  prefs: () => Promise<AgentPreferences>,
): ToolDef<typeof input> {
  return {
    name: 'ask_player',
    title: 'Ask the player',
    description:
      'Asks the player a question and waits for the answer. Use it when you need something only they can see in the game ' +
      '(a value on screen, whether something changed). The player gets a desktop notification; for "confirm" they answer ' +
      'with a hotkey. Returns { answered: true, answer } or { answered: false, reason: "timeout" | "stopped" }. ' +
      'Ask one question at a time.',
    tier: 'open',
    readOnly: true,
    input,
    async run(args, ctx) {
      if (args.answer === 'choice' && !args.choices?.length) {
        throw new ToolError('A "choice" question needs choices.');
      }
      const timeoutSec = args.timeout_s ?? (await prefs()).askTimeoutSec;
      return prompts.ask({
        question: args.question,
        answer: args.answer,
        ...(args.answer === 'choice' && args.choices ? { choices: args.choices } : {}),
        timeoutMs: timeoutSec * 1000,
        label: ctx.client.label,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
    summarize(args, result) {
      const r = result as AskResult | null;
      if (r?.answered) return `ask_player "${args.question}" → ${String(r.answer)}`;
      return `ask_player "${args.question}" → no answer (${r?.reason ?? 'timeout'})`;
    },
  };
}
