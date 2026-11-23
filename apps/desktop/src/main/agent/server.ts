// apps/desktop/src/main/agent/server.ts
//
// One McpServer per MCP session (D1): Starlight's instructions, the
// `find-a-cheat` prompt and every tool.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INSTRUCTIONS, findACheatPrompt } from './instructions.js';
import { agentLabel, registerTools, type ActivitySink, type AgentAccess, type AgentClient, type ToolDef } from './tools.js';

export interface AgentServerDeps {
  version: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ToolDef<any>[];
  access: AgentAccess;
  activity: ActivitySink;
  /** Called once the client has said who it is (MCP initialize). */
  onClientInfo(c: AgentClient): void;
}

export function createAgentServer(mcpSessionId: string, deps: AgentServerDeps): McpServer {
  const server = new McpServer({ name: 'starlight', version: deps.version }, { instructions: INSTRUCTIONS });

  let client: AgentClient = { mcpSessionId, name: '', version: '', label: agentLabel('') };
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    const name = typeof info?.name === 'string' ? info.name.slice(0, 100) : '';
    const version = typeof info?.version === 'string' ? info.version.slice(0, 50) : '';
    client = { mcpSessionId, name, version, label: agentLabel(name) };
    deps.onClientInfo(client);
  };

  server.registerPrompt(
    'find-a-cheat',
    {
      title: 'Find a cheat',
      description: 'Find and save a cheat for the game you are playing, with Starlight.',
      argsSchema: { goal: z.string().max(200).optional().describe('What the cheat should do, e.g. "infinite gold"') },
    },
    ({ goal }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: findACheatPrompt(goal) } }],
    }),
  );

  registerTools(server, deps.tools, { mcpSessionId, client: () => client, access: deps.access, activity: deps.activity });
  return server;
}
