// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { askPlayerTool } from '../../../src/main/agent/tools-ask.js';
import { DEFAULT_AGENT_PREFS } from '../../../src/shared/ipc.js';
import type { ToolContext } from '../../../src/main/agent/tools.js';

const ctx = (signal?: AbortSignal): ToolContext => ({
  mcpSessionId: 's', client: { mcpSessionId: 's', name: 'claude-code', version: '1', label: 'Claude' }, attached: null,
  ...(signal ? { signal } : {}),
});

describe('ask_player tool', () => {
  it('uses the configured timeout by default', async () => {
    const ask = vi.fn(async () => ({ answered: true as const, answer: true }));
    const tool = askPlayerTool({ ask }, async () => ({ ...DEFAULT_AGENT_PREFS, askTimeoutSec: 42 }));
    await tool.run({ question: 'Gold changed?', answer: 'confirm' }, ctx());
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ question: 'Gold changed?', answer: 'confirm', timeoutMs: 42_000, label: 'Claude' }));
    await tool.run({ question: 'q', answer: 'confirm', timeout_s: 20 }, ctx());
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 20_000 }));
  });

  it('passes the request signal through', async () => {
    const ask = vi.fn(async () => ({ answered: false as const, reason: 'stopped' as const }));
    const tool = askPlayerTool({ ask }, async () => ({ ...DEFAULT_AGENT_PREFS }));
    const ac = new AbortController();
    await tool.run({ question: 'q', answer: 'confirm' }, ctx(ac.signal));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ signal: ac.signal }));
  });

  it('summary includes the answer', () => {
    const tool = askPlayerTool({ ask: vi.fn() }, async () => ({ ...DEFAULT_AGENT_PREFS }));
    const args = { question: 'Gold?', answer: 'number' as const };
    expect(tool.summarize(args, { answered: true, answer: 120 })).toBe('ask_player "Gold?" → 120');
    expect(tool.summarize(args, { answered: false, reason: 'timeout' })).toBe('ask_player "Gold?" → no answer (timeout)');
    expect(tool.tier).toBe('open');
    expect(tool.readOnly).toBe(true);
  });
});
