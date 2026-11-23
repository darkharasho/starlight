// apps/desktop/src/main/agent/connect-info.ts
//
// What Settings shows so the player can connect Claude Code or Codex.
import type { AgentConnectInfo } from '../../shared/ipc.js';

export function buildConnectInfo(o: { enabled: boolean; port: number; portIsFallback: boolean; token: string }): AgentConnectInfo {
  const url = `http://127.0.0.1:${o.port}/mcp`;
  return {
    enabled: o.enabled,
    url,
    port: o.port,
    portIsFallback: o.portIsFallback,
    token: o.token,
    claudeCommand: `claude mcp add --transport http starlight ${url} --header "Authorization: Bearer ${o.token}"`,
    // Codex's per-server tool timeout defaults to 60 s; approvals and
    // ask_player wait far longer (ask_player up to 3600 s).
    codexConfig: `[mcp_servers.starlight]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${o.token}" }\ntool_timeout_sec = 3700\n`,
  };
}
