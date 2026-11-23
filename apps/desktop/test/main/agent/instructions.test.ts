// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { INSTRUCTIONS, findACheatPrompt } from '../../../src/main/agent/instructions.js';

const PLAYBOOK = ['list_games', 'attach', 'scan_first', 'ask_player', 'scan_next', 'pointer_scan', 'watch_writes', 'make_signature', 'test_cheat', 'save_cheat'];

describe('agent instructions', () => {
  for (const [label, text] of [['INSTRUCTIONS', INSTRUCTIONS], ['findACheatPrompt', findACheatPrompt()]] as const) {
    it(`the playbook names the tools in order (${label})`, () => {
      let last = -1;
      for (const tool of PLAYBOOK) {
        const i = text.indexOf(tool, last + 1);
        expect(i, tool).toBeGreaterThan(last);
        last = i;
      }
    });

    it(`forbids absolute addresses and multiplayer (${label})`, () => {
      expect(text).toMatch(/never absolute/i);
      expect(text).toMatch(/single-player games only/i);
      expect(text).toMatch(/verify\.range/);
      expect(text).toMatch(/list_cheats/);
      expect(text).toMatch(/approve/i);
      expect(text).toMatch(/test.*before saving/i);
    });
  }

  it('the prompt carries the goal', () => {
    expect(findACheatPrompt('infinite gold')).toContain('infinite gold');
  });
});
