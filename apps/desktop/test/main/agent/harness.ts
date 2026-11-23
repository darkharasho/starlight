// Shared by the agent tool tests: an MCP server with `registerTools` and a real SDK client over an in-memory transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, type ActivitySink, type AgentAccess, type ToolDef } from '../../../src/main/agent/tools.js';

export async function connectTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defs: ToolDef<any>[],
  o: { access: AgentAccess; activity: ActivitySink },
): Promise<Client> {
  const server = new McpServer({ name: 't', version: '1' });
  registerTools(server, defs, {
    mcpSessionId: 's1',
    client: () => ({ mcpSessionId: 's1', name: 'codex', version: '1', label: 'Codex' }),
    access: o.access, activity: o.activity,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '1' });
  await client.connect(b);
  return client;
}
