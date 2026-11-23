// apps/desktop/src/main/agent/tools.ts
//
// The framework every agent tool plugs into: tiers, the refusal copy, engine
// error text and `registerTools`, which turns each `ToolDef` into an MCP tool
// that is gated by the agent session and logged as an activity entry.
import type { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EngineError, NeedsUpdateError, RpcCode } from '@starlight/engine';
import type { FreezeHandle, RunningCheat, Session, Watch } from '@starlight/engine';
import type { GameIdentity } from '../game-identity.js';

/** `open`: no game needed. `attached`: the player approved an attach. `modify`: also "Agent can modify the game". */
export type Tier = 'open' | 'attached' | 'modify';

/** A refusal or a rule the agent broke: returned to the agent as is. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

// Refusal copy (exact text; agents read it).
export const NOT_ATTACHED = 'Not attached to a game. Call list_games, then attach (the player has to approve it).';
export const MODIFY_OFF = 'The player has turned off "Agent can modify the game". Read-only tools still work; ask the player to turn it back on.';
export const OTHER_AGENT = (label: string, game: string): string =>
  `Another agent (${label}) is attached to ${game}. The player can stop it in Starlight.`;
export const DECLINED = "The player declined. Don't retry unless they ask you to.";
export const NO_ANSWER = (approvalTimeoutSec: number): string => {
  const mins = approvalTimeoutSec / 60;
  const span = Number.isInteger(mins) ? `${mins} minute${mins === 1 ? '' : 's'}` : `${approvalTimeoutSec} seconds`;
  return `No answer from the player within ${span}, so the attach was not allowed. Ask them in chat before trying again.`;
};
export const STOPPED_MIDWAY = 'Stopped by the player before this finished; nothing was left running.';
export const QUESTION_WAITING = 'A question is already waiting for the player.';

/** The engine's API; tools take `Partial<EngineApi>` overrides in tests. */
export type EngineApi = typeof import('@starlight/engine');

export interface AgentClient {
  mcpSessionId: string;
  name: string;
  version: string;
  /** "Claude", "Codex", the client's name, or "An agent" (D17). */
  label: string;
}

/**
 * Everything the agent starts that keeps running is tracked, so Stop and the
 * "Agent can modify the game" switch can revert it. A `track.*` call with a
 * stale `gen` (after Stop or the switch going off) reverts the item at once and
 * throws `ToolError(STOPPED_MIDWAY)`.
 */
export interface Tracker {
  freeze(gen: number, h: FreezeHandle, info: { address: string; type: string; value: string }): number;
  test(gen: number, c: RunningCheat, info: { name: string }): number;
  watch(gen: number, w: Watch, info: { address: string; kind: 'write' | 'access'; endsAt: number }): number;
  pointerScan(gen: number, id: number): void;
  speed(gen: number, v: number): void;
  untrackFreeze(id: number): FreezeHandle | null;
  untrackTest(id: number): RunningCheat | null;
  untrackWatch(id: number): void;
  /** How many test cheats are running (D13: at most 8). */
  liveTests(): number;
}

/** What attached- and modify-tier tools get: the approved game and its engine session. */
export interface AttachedContext {
  gen: number;
  session: Session;
  game: GameIdentity;
  client: AgentClient;
  /** `"<module>+0x<off>"` from a cached module list, or null. */
  describe(address: string): Promise<string | null>;
  track: Tracker;
  /** Aborted when this context's `gen` goes stale (Stop, the switch going off, detach). */
  signal: AbortSignal;
}

export interface ToolContext {
  mcpSessionId: string;
  client: AgentClient;
  /** What `access.require` returned: null for open-tier tools, set for attached and modify. */
  attached: AttachedContext | null;
  /** Aborted when the MCP request is cancelled or the client disconnects. */
  signal?: AbortSignal;
}

export interface ToolChange { address: string; old: string; new: string }

export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Static, or per call (test_cheat: apply is modify, revert is attached). */
  tier: Tier | ((args: z.infer<z.ZodObject<S>>) => Tier);
  /** MCP readOnlyHint: true only for tools that never change the game or Starlight's state. */
  readOnly: boolean;
  input: S;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>;
  summarize(args: z.infer<z.ZodObject<S>>, result: unknown): string;
  /** For tools that change a value: the activity log's old → new. */
  change?(args: z.infer<z.ZodObject<S>>, result: unknown): ToolChange | undefined;
}

export interface AgentAccess {
  /** Resolves when this MCP session may run a tool of this tier; throws `ToolError` otherwise. */
  require(mcpSessionId: string, tier: Tier): Promise<AttachedContext | null>;
}

export interface ActivitySink {
  start(tool: string, summary: string): number;
  finish(id: number, r: { status: 'ok' | 'error' | 'refused'; summary?: string; error?: string; change?: ToolChange }): void;
}

/** Plain text for an error, for the agent and the activity log. */
export function describeEngineError(err: unknown): string {
  if (err instanceof NeedsUpdateError) return `This cheat needs updating: ${err.reasons.join('; ')}`;
  if (err instanceof EngineError) {
    switch (err.code) {
      case RpcCode.ProcessNotFound: return 'The game has exited.';
      case RpcCode.Busy: return 'The engine is busy with this game; try again in a moment.';
      case RpcCode.PermissionDenied:
      case RpcCode.PtraceFailed:
        return `Starlight doesn't have permission to debug this game yet: ${err.message}. The player can click Allow on the game's page.`;
      case RpcCode.PatchConflict: return `That code is already patched: ${err.message}`;
      default: return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** D17: how the app names the connected agent. */
export function agentLabel(clientName: string): string {
  const name = clientName.trim();
  if (/claude/i.test(name)) return 'Claude';
  if (/codex/i.test(name)) return 'Codex';
  return name || 'An agent';
}

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function registerTools(
  server: McpServer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defs: ToolDef<any>[],
  o: { mcpSessionId: string; client(): AgentClient; access: AgentAccess; activity: ActivitySink },
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: { title: def.title, readOnlyHint: def.readOnly },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any, extra?: { signal?: AbortSignal }): Promise<CallToolResult> => {
        const id = o.activity.start(def.name, `${def.name} …`);
        let attached: AttachedContext | null;
        try {
          const tier = typeof def.tier === 'function' ? def.tier(args) : def.tier;
          attached = await o.access.require(o.mcpSessionId, tier);
        } catch (err) {
          const refused = err instanceof ToolError;
          const msg = describeEngineError(err);
          o.activity.finish(id, { status: refused ? 'refused' : 'error', error: msg });
          return textResult(msg, true);
        }
        let result: unknown;
        try {
          result = await def.run(args, { mcpSessionId: o.mcpSessionId, client: o.client(), attached, ...(extra?.signal ? { signal: extra.signal } : {}) });
        } catch (err) {
          const msg = describeEngineError(err);
          o.activity.finish(id, { status: 'error', error: msg });
          return textResult(msg, true);
        }
        const summary = safe(() => def.summarize(args, result), def.name);
        const change = def.change ? safe(() => def.change!(args, result), undefined) : undefined;
        o.activity.finish(id, change ? { status: 'ok', summary, change } : { status: 'ok', summary });
        return textResult(JSON.stringify(result ?? null));
      }) as never,
    );
  }
}
