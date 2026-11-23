// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EngineError, NeedsUpdateError, RpcCode } from '@starlight/engine';
import {
  registerTools, describeEngineError, agentLabel, ToolError,
  type ActivitySink, type AgentAccess, type ToolDef, type Tier,
} from '../../../src/main/agent/tools.js';

function sink(): ActivitySink & { log: unknown[] } {
  let n = 0;
  const log: unknown[] = [];
  return { log, start: (tool, summary) => { log.push(['start', tool, summary]); return ++n; }, finish: (id, r) => { log.push(['finish', id, r]); } };
}

async function connect(defs: ToolDef<any>[], access: AgentAccess, activity: ActivitySink): Promise<Client> {
  const server = new McpServer({ name: 't', version: '1' });
  registerTools(server, defs, { mcpSessionId: 's1', client: () => ({ mcpSessionId: 's1', name: 'codex', version: '1', label: 'Codex' }), access, activity });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '1' });
  await client.connect(b);
  return client;
}

const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]!.text);

describe('registerTools', () => {
  it('runs the tool with the context and logs ok with the summary', async () => {
    const tiers: Tier[] = [];
    const activity = sink();
    const def: ToolDef<{ n: z.ZodNumber }> = {
      name: 'double', title: 'Double', description: 'd', tier: 'attached', readOnly: true, input: { n: z.number() },
      run: async (args, ctx) => ({ out: args.n * 2, who: ctx.client.label, attached: ctx.attached }),
      summarize: (args, r) => `doubled ${args.n} to ${(r as { out: number }).out}`,
    };
    const client = await connect([def], { require: async (_s, t) => { tiers.push(t); return 'ctx'; } }, activity);
    const r = await client.callTool({ name: 'double', arguments: { n: 4 } });
    expect(JSON.parse(text(r))).toEqual({ out: 8, who: 'Codex', attached: 'ctx' });
    expect(tiers).toEqual(['attached']);
    expect(activity.log).toEqual([['start', 'double', 'double …'], ['finish', 1, { status: 'ok', summary: 'doubled 4 to 8' }]]);
  });

  it('resolves a per-call tier and marks modify tools not read-only', async () => {
    const tiers: Tier[] = [];
    const def: ToolDef<{ action: z.ZodEnum<['apply', 'revert']> }> = {
      name: 'test_cheat', title: 'Test', description: 'd', readOnly: false, input: { action: z.enum(['apply', 'revert']) },
      tier: (a) => (a.action === 'apply' ? 'modify' : 'attached'),
      run: async () => ({}), summarize: () => 's',
    };
    const client = await connect([def], { require: async (_s, t) => { tiers.push(t); return null; } }, sink());
    await client.callTool({ name: 'test_cheat', arguments: { action: 'apply' } });
    await client.callTool({ name: 'test_cheat', arguments: { action: 'revert' } });
    expect(tiers).toEqual(['modify', 'attached']);
    const listed = (await client.listTools()).tools[0]!;
    expect(listed.annotations?.readOnlyHint).toBe(false);
  });

  it('an engine error is an isError result logged as error, and records a change', async () => {
    const activity = sink();
    const fail: ToolDef<Record<string, never>> = {
      name: 'fail', title: 'F', description: 'd', tier: 'open', readOnly: true, input: {},
      run: async () => { const e = new EngineError('no such process'); e.code = RpcCode.ProcessNotFound; throw e; },
      summarize: () => 's',
    };
    const write: ToolDef<Record<string, never>> = {
      name: 'write', title: 'W', description: 'd', tier: 'open', readOnly: false, input: {},
      run: async () => ({ old: '1', new: '2' }),
      summarize: () => 'wrote',
      change: () => ({ address: 'game+0x10', old: '1', new: '2' }),
    };
    const client = await connect([fail, write], { require: async () => null }, activity);
    const r = await client.callTool({ name: 'fail', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('The game has exited.');
    await client.callTool({ name: 'write', arguments: {} });
    expect(activity.log).toEqual([
      ['start', 'fail', 'fail …'], ['finish', 1, { status: 'error', error: 'The game has exited.' }],
      ['start', 'write', 'write …'], ['finish', 2, { status: 'ok', summary: 'wrote', change: { address: 'game+0x10', old: '1', new: '2' } }],
    ]);
  });
});

describe('describeEngineError', () => {
  const coded = (code: number, msg = 'boom'): EngineError => { const e = new EngineError(msg); e.code = code; return e; };
  it('maps engine errors to plain text', () => {
    expect(describeEngineError(coded(RpcCode.ProcessNotFound))).toBe('The game has exited.');
    expect(describeEngineError(coded(RpcCode.Busy))).toBe('The engine is busy with this game; try again in a moment.');
    expect(describeEngineError(coded(RpcCode.PermissionDenied, 'EPERM'))).toBe("Starlight doesn't have permission to debug this game yet: EPERM. The player can click Allow on the game's page.");
    expect(describeEngineError(coded(RpcCode.PtraceFailed, 'nope'))).toContain('permission to debug');
    expect(describeEngineError(coded(RpcCode.PatchConflict, 'overlap'))).toBe('That code is already patched: overlap');
    expect(describeEngineError(new NeedsUpdateError(['a', 'b']))).toBe('This cheat needs updating: a; b');
    expect(describeEngineError(new ToolError('x'))).toBe('x');
    expect(describeEngineError(new Error('plain'))).toBe('plain');
    expect(describeEngineError('str')).toBe('str');
  });
});

describe('agentLabel', () => {
  it('names Claude and Codex, else the client name', () => {
    expect(agentLabel('claude-code')).toBe('Claude');
    expect(agentLabel('Codex CLI')).toBe('Codex');
    expect(agentLabel('cursor')).toBe('cursor');
    expect(agentLabel('')).toBe('An agent');
    expect(agentLabel('   ')).toBe('An agent');
  });
});
