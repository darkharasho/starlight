// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildConnectInfo } from '../../../src/main/agent/connect-info.js';

describe('buildConnectInfo', () => {
  it('gives the exact Claude Code command and Codex config', () => {
    const info = buildConnectInfo({ enabled: true, port: 47771, portIsFallback: false, token: 'abc' });
    expect(info).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:47771/mcp',
      port: 47771,
      portIsFallback: false,
      token: 'abc',
      claudeCommand: 'claude mcp add --scope user --transport http starlight http://127.0.0.1:47771/mcp --header "Authorization: Bearer abc"',
      codexConfig: '[mcp_servers.starlight]\nurl = "http://127.0.0.1:47771/mcp"\nhttp_headers = { "Authorization" = "Bearer abc" }\ntool_timeout_sec = 3700\n',
    });
  });
});
