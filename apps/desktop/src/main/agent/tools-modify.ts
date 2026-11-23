// apps/desktop/src/main/agent/tools-modify.ts
//
// Tools that change the game: write, freeze/unfreeze, write/access watches,
// game speed and test cheats. They need "Agent can modify the game" (modify
// tier), except unfreeze and test_cheat revert, which only undo.
//
// Stop (or the switch going off) can land while a tool awaits a read or a
// verify, so every engine call that changes the game is preceded by `live(ctx)`.
// Anything left running is handed to `track.*`, which reverts it at once if
// the session was stopped while the engine call was in flight.
import { z } from 'zod';
import {
  EngineError, NeedsUpdateError, RpcCode,
  enableCheat, freeze, read, resolveAddressExpr, setSpeed, verifyCheat, watchStart, write,
} from '@starlight/engine';
import type { Hit, ValueType, VerifyResult } from '@starlight/engine';
import { AgentCheatDraftSchema, validateAgentCheat } from '@starlight/ct-importer';
import { CHEAT_DRAFT_HELP } from './instructions.js';
import type { StarlightCheat, StarlightPatchCheat, StarlightValueCheat } from '@starlight/ct-importer';
import {
  ToolError, describeEngineError, hex, live, need,
  type AttachedContext, type EngineApi, type ToolDef,
} from './tools.js';

type NumericType = Exclude<ValueType, 'string'>;
const NUMERIC_TYPES = ['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'float', 'double'] as const;

const INT_RANGE: Partial<Record<NumericType, [bigint, bigint]>> = {
  int8: [-(2n ** 7n), 2n ** 7n - 1n], uint8: [0n, 2n ** 8n - 1n],
  int16: [-(2n ** 15n), 2n ** 15n - 1n], uint16: [0n, 2n ** 16n - 1n],
  int32: [-(2n ** 31n), 2n ** 31n - 1n], uint32: [0n, 2n ** 32n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n], uint64: [0n, 2n ** 64n - 1n],
};

const MAX_TESTS = 8;
const SPEED_CONTROLLED = "Starlight's game page is controlling this game's speed; ask the player to change it there.";

const addressDoc = 'An address expression: "0x7ff6a1b2c3d4", "<module>+<hex>" (e.g. "target+0x4010"), or a quoted module name ("\\"My Game.exe\\"+10").';

/** R24: int64/uint64 → BigInt, other integers → integer Number, float/double → finite Number. */
export function parseValue(type: NumericType, value: string): number | bigint {
  const bad = (): never => { throw new ToolError(`value must be a ${type} number`); };
  const s = value.trim();
  const range = INT_RANGE[type];
  if (type === 'int64' || type === 'uint64') {
    if (!/^-?\d+$/.test(s)) bad();
    const n = BigInt(s);
    if (n < range![0] || n > range![1]) bad();
    return n;
  }
  const n = s === '' ? NaN : Number(s);
  if (!Number.isFinite(n)) bad();
  if (range) {
    if (!Number.isInteger(n) || BigInt(n) < range[0] || BigInt(n) > range[1]) bad();
  }
  return n;
}

interface Site { address: string; where: string | null; text: string; count: number; registers?: Record<string, string> }

export function modifyTools(engine: Partial<EngineApi> = {}): ToolDef<any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const eng = {
    resolveAddressExpr: engine.resolveAddressExpr ?? resolveAddressExpr,
    read: engine.read ?? read,
    write: engine.write ?? write,
    freeze: engine.freeze ?? freeze,
    watchStart: engine.watchStart ?? watchStart,
    setSpeed: engine.setSpeed ?? setSpeed,
    verifyCheat: engine.verifyCheat ?? verifyCheat,
    enableCheat: engine.enableCheat ?? enableCheat,
  };

  const resolve = async (a: AttachedContext, expr: string): Promise<string> => hex(await eng.resolveAddressExpr(a.session, expr));

  // ── write ──────────────────────────────────────────────────────────────
  const writeInput = {
    address: z.string().min(1).describe(addressDoc),
    type: z.enum(NUMERIC_TYPES),
    value: z.string().describe('The new value, as a string (e.g. "999", "1.5").'),
  };
  const writeTool: ToolDef<typeof writeInput> = {
    name: 'write',
    title: 'Write a value',
    description: 'Writes one value into the game once and returns the old and new value. It stays until the game changes it.',
    tier: 'modify', readOnly: false, input: writeInput,
    async run(args, ctx) {
      const v = parseValue(args.type, args.value);
      let a = live(ctx);
      const address = await resolve(a, args.address);
      const where = await a.describe(address);
      const old = String(await eng.read(a.session, address, args.type));
      a = live(ctx);
      await eng.write(a.session, address, args.type, v);
      return { address, where, old, new: String(v) };
    },
    summarize: (_args, result) => {
      const r = result as { address: string; where: string | null; old: string; new: string };
      return `write ${r.where ?? r.address} ${r.old} → ${r.new}`;
    },
    change: (_args, result) => {
      const r = result as { address: string; where: string | null; old: string; new: string };
      return { address: r.where ?? r.address, old: r.old, new: r.new };
    },
  };

  // ── freeze / unfreeze ──────────────────────────────────────────────────
  const freezeInput = {
    address: z.string().min(1).describe(addressDoc),
    type: z.enum(NUMERIC_TYPES),
    value: z.string().describe('The value to hold, as a string.'),
    interval_ms: z.number().int().min(20).max(1000).optional().describe('How often the value is rewritten; default 100.'),
  };
  const freezeTool: ToolDef<typeof freezeInput> = {
    name: 'freeze',
    title: 'Freeze a value',
    description: 'Keeps rewriting a value so the game cannot change it, until unfreeze, Stop, or the player turning modify off.',
    tier: 'modify', readOnly: false, input: freezeInput,
    async run(args, ctx) {
      const v = parseValue(args.type, args.value);
      let a = live(ctx);
      const address = await resolve(a, args.address);
      const where = await a.describe(address);
      a = live(ctx);
      const h = await eng.freeze(a.session, { address, type: args.type, value: v, intervalMs: args.interval_ms ?? 100 });
      const id = a.track.freeze(a.gen, h, { address, type: args.type, value: String(v) });
      return { freeze: id, address, where };
    },
    summarize: (args, result) => {
      const r = result as { address: string; where: string | null };
      return `freeze ${r.where ?? r.address} = ${args.value}`;
    },
  };

  const unfreezeInput = { freeze: z.number().int().describe('The id freeze returned.') };
  const unfreezeTool: ToolDef<typeof unfreezeInput> = {
    name: 'unfreeze',
    title: 'Unfreeze',
    description: 'Stops a freeze. The value stays as it is until the game changes it.',
    tier: 'attached', readOnly: false, input: unfreezeInput,
    async run(args, ctx) {
      const a = need(ctx);
      const h = a.track.untrackFreeze(args.freeze);
      if (!h) throw new ToolError(`Unknown freeze ${args.freeze}.`);
      await h.cancel();
      return { unfrozen: true };
    },
    summarize: (args) => `unfreeze #${args.freeze}`,
  };

  // ── watch_writes / watch_accesses ──────────────────────────────────────
  const watchInput = {
    address: z.string().min(1).describe(addressDoc),
    size: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional().describe('Bytes to watch; default 4.'),
    duration_ms: z.number().int().min(1000).max(60000).optional().describe('How long to watch; default 10000, at most 60000.'),
    include_registers: z.boolean().optional().describe('Include the first register snapshot for each site; default false.'),
  };
  function watchTool(kind: 'write' | 'access'): ToolDef<typeof watchInput> {
    const name = kind === 'write' ? 'watch_writes' : 'watch_accesses';
    return {
      name,
      title: kind === 'write' ? 'Watch writes' : 'Watch accesses',
      description:
        `Sets a hardware watchpoint and reports the code that ${kind === 'write' ? 'writes' : 'reads or writes'} the address, ` +
        'with a hit count per instruction (top 20 by count). Blocks until the watch ends; play the game meanwhile, ' +
        'or ask the player to do the thing that changes the value.',
      tier: 'modify', readOnly: false, input: watchInput,
      async run(args, ctx) {
        let a = live(ctx);
        const address = await resolve(a, args.address);
        const where = await a.describe(address);
        const durationMs = args.duration_ms ?? 10000;
        a = live(ctx);
        const w = await eng.watchStart(a.session, { address, size: args.size ?? 4, kind, durationMs });
        const id = a.track.watch(a.gen, w, { address, kind, endsAt: Date.now() + durationMs });
        const signal = a.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          await Promise.race([
            new Promise<void>((r) => w.onEnded(() => r())),
            new Promise<void>((r) => {
              onAbort = () => r();
              if (signal.aborted) r(); else signal.addEventListener('abort', onAbort, { once: true });
              ctx.signal?.addEventListener('abort', onAbort, { once: true });
            }),
            new Promise<void>((r) => { timer = setTimeout(r, durationMs + 5000); }),
          ]);
        } finally {
          clearTimeout(timer);
          if (onAbort) { signal.removeEventListener('abort', onAbort); ctx.signal?.removeEventListener('abort', onAbort); }
        }
        const report = await w.stop().catch(() => null);
        a.track.untrackWatch(id);
        const reason = signal.aborted || ctx.signal?.aborted ? 'stopped' : (report?.reason ?? 'timeout');
        const hits: Hit[] = report?.hits ?? [];
        const top = [...hits].sort((x, y) => y.count - x.count).slice(0, 20);
        const sites: Site[] = await Promise.all(top.map(async (h) => {
          const at = hex(h.address ?? h.next);
          const s: Site = { address: at, where: await a.describe(at), text: h.text, count: h.count };
          if (args.include_registers) s.registers = h.registers;
          return s;
        }));
        return { reason, total_sites: hits.length, sites, address, where };
      },
      summarize: (args, result) => {
        const r = result as { address: string; where: string | null; total_sites: number };
        return `${name} ${r.where ?? r.address} ${(args.duration_ms ?? 10000) / 1000}s → ${r.total_sites} sites`;
      },
    };
  }

  // ── set_speed ──────────────────────────────────────────────────────────
  const speedInput = { speed: z.number().min(0.1).max(10).describe('1 is normal; 0.5 is half speed, 2 is double.') };
  const setSpeedTool: ToolDef<typeof speedInput> = {
    name: 'set_speed',
    title: 'Set game speed',
    description: "Changes the game's clock speed (0.1–10). Stop and the player's switch put it back to 1.",
    tier: 'modify', readOnly: false, input: speedInput,
    async run(args, ctx) {
      const a = live(ctx);
      let r;
      try {
        r = await eng.setSpeed(a.session, args.speed);
      } catch (err) {
        if (err instanceof EngineError && err.code === RpcCode.PatchConflict && err.message.includes("controls this game's speed")) {
          throw new ToolError(SPEED_CONTROLLED);
        }
        throw err;
      }
      a.track.speed(a.gen, args.speed);
      return {
        speed: r.speed,
        hooks: r.hooks.map((h) => (h.reason !== undefined ? { name: h.name, status: h.status, reason: h.reason } : { name: h.name, status: h.status })),
      };
    },
    summarize: (args) => `set_speed ${args.speed}×`,
  };

  // ── test_cheat ─────────────────────────────────────────────────────────
  const testInput = {
    action: z.enum(['apply', 'revert']),
    cheat: AgentCheatDraftSchema.optional().describe('apply: a value or patch cheat draft (Starlight format without id; see the examples in the instructions).'),
    value: z.number().optional().describe('apply, value cheats: the value to hold instead of the draft\'s.'),
    test: z.number().int().optional().describe('revert: the id apply returned.'),
  };
  const testCheatTool: ToolDef<typeof testInput> = {
    name: 'test_cheat',
    title: 'Test a cheat',
    description:
      'apply turns a cheat draft on in the running game without saving it (at most 8 at once); revert turns one off. ' +
      'Check the effect with read, or ask the player, then save it with save_cheat. ' +
      CHEAT_DRAFT_HELP,
    tier: (args) => (args.action === 'apply' ? 'modify' : 'attached'),
    readOnly: false, input: testInput,
    async run(args, ctx) {
      if (args.action === 'revert') {
        const a = need(ctx);
        if (args.test === undefined) throw new ToolError('test is required for revert.');
        const c = a.track.untrackTest(args.test);
        if (!c) throw new ToolError(`Unknown test ${args.test}.`);
        await c.disable();
        return { reverted: true };
      }
      let a = live(ctx);
      if (!args.cheat) throw new ToolError('cheat is required for apply.');
      const checked = validateAgentCheat(args.cheat, { forTest: true });
      if (!checked.ok) throw new ToolError(checked.errors.join('\n'));
      if (a.track.liveTests() >= MAX_TESTS) throw new ToolError('At most 8 test cheats can be on at once; revert one first.');
      const cheat = { ...checked.cheat, id: 'agent-test' } as unknown as StarlightValueCheat | StarlightPatchCheat;
      const verify: VerifyResult = await eng.verifyCheat(a.session, cheat as StarlightCheat);
      if (verify.status === 'needs-update') throw new ToolError(describeEngineError(new NeedsUpdateError(verify.reasons)));
      a = live(ctx);
      if (a.track.liveTests() >= MAX_TESTS) throw new ToolError('At most 8 test cheats can be on at once; revert one first.');
      let running;
      try {
        running = await eng.enableCheat(a.session, cheat, args.value !== undefined ? { value: args.value } : {});
      } catch (err) {
        if (err instanceof NeedsUpdateError) throw new ToolError(describeEngineError(err));
        throw err;
      }
      const id = a.track.test(a.gen, running, { name: checked.cheat.name });
      const address = hex(running.address);
      return { test: id, verify, address, where: await a.describe(address) };
    },
    summarize: (args, result) => {
      if (args.action === 'revert') return `test_cheat revert #${args.test}`;
      const r = result as { verify: VerifyResult };
      return `test_cheat apply "${String((args.cheat as { name?: unknown } | undefined)?.name ?? '')}" (${r.verify.status})`;
    },
  };

  return [writeTool, freezeTool, unfreezeTool, watchTool('write'), watchTool('access'), setSpeedTool, testCheatTool];
}
