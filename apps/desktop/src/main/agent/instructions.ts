// apps/desktop/src/main/agent/instructions.ts
//
// What a connected agent is told about Starlight: the MCP server instructions
// and the `find-a-cheat` prompt. Both carry the same playbook and rules.

const PLAYBOOK = `How to find a cheat, in this order:
1. list_games: find the running game. Only games without anti-cheat can be attached.
2. attach: the player approves the attach in Starlight. Wait for it; if they decline, stop.
3. scan_first: scan for the value the player sees (gold, health, ammo …).
4. ask_player: ask the player to change the value in the game (spend gold, take damage) and what it is now.
5. scan_next: narrow the results with the new value. Repeat ask_player and scan_next until a few addresses are left.
6. pointer_scan or watch_writes: turn the address into something that survives a restart. pointer_scan finds a pointer path from a module; watch_writes finds the code that writes the value.
7. make_signature: make an AOB signature for that code, so the cheat survives game updates.
8. test_cheat: try the cheat on the running game and have the player confirm that it works.
9. save_cheat: save it to the player's library ("My cheats" on the game's page).`;

const RULES = `Rules:
- The player approves every attach in Starlight. Never try to get around a refusal.
- Ask the player instead of guessing: use ask_player (or ask in chat) whenever you need to know what the game shows or what they want.
- Prefer pointer or AOB addresses, never absolute addresses: absolute addresses change on every restart, and save_cheat refuses them.
- Give every value cheat a verify.range (the values that make sense, e.g. { "min": 0, "max": 10000000 }), so Starlight can tell when a game update broke it.
- Test before saving: test_cheat first, then save_cheat once the player confirms it works.
- Call list_cheats first: if the game already has a cheat for this that needs updating, repair it (save_cheat with replaces) instead of starting over.
- Single-player games only. Starlight refuses games with anti-cheat; never help with online or multiplayer games.
- Values are strings in tool inputs and results. Addresses look like "0x7ff6a1b2c3d4" or "module+0x4010".`;

/** Two complete drafts that pass save_cheat's validator (instructions.test.ts checks them). */
export const CHEAT_DRAFT_EXAMPLES = {
  value: {
    name: 'Infinite gold', type: 'freeze', valueType: 'int32', value: 9999,
    address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x5260', offsets: ['0x18', '0x0'] },
    verify: { range: { min: 0, max: 10000000 } },
  },
  patch: {
    name: 'No damage', type: 'patch',
    site: { kind: 'aob', module: 'game.exe', pattern: '29 87 B0 01 00 00 8B 47 ??' },
    enable: [{ op: 'writeBytes', at: 'site', bytes: '909090909090' }],
    verify: {},
  },
} as const;

/** Short help for test_cheat / save_cheat descriptions. */
export const CHEAT_DRAFT_HELP =
  'A value cheat looks like ' + JSON.stringify(CHEAT_DRAFT_EXAMPLES.value) +
  '; a code patch built from make_signature\'s aob looks like ' + JSON.stringify(CHEAT_DRAFT_EXAMPLES.patch) + '.';

const DRAFTS = `Cheat drafts (the cheat input of test_cheat and save_cheat):
- A value cheat: type "freeze" (hold value), "set" or "toggle"; valueType ("int32", "float" …); value; address; verify.range.
  address is { "kind": "pointer", "module", "baseOffset", "offsets" } from pointer_scan, { "kind": "aob", "module", "pattern", "offset"? } from make_signature, or { "kind": "module", "module", "offset" }. Offsets are hex strings.
  Example: ${JSON.stringify(CHEAT_DRAFT_EXAMPLES.value)}
- A code patch: type "patch"; site is make_signature's aob (it must match exactly once); enable is a list of steps.
  Steps: { "op": "writeBytes", "at", "bytes" } (hex, e.g. "9090"), { "op": "alloc", "name", "size", "near"? }, { "op": "assemble", "at", "source" }, { "op": "registerSymbol", "name", "at" }.
  "at" is "site", "site+0x10", "site-0xd", an alloc or symbol name (± hex), "module+0x1234" or "0x…". Leave out disable: Starlight reverts the steps itself. save_cheat records the original bytes.
  Example: ${JSON.stringify(CHEAT_DRAFT_EXAMPLES.patch)}`;

export const INSTRUCTIONS = `Starlight is a game trainer. These tools let you find and build cheats for a single-player game the player is running, together with the player.

${PLAYBOOK}

${RULES}

${DRAFTS}`;

export function findACheatPrompt(goal?: string): string {
  const want = goal?.trim();
  return `${want ? `Help me make a cheat in the game I'm playing: ${want}.` : 'Help me make a cheat in the game I\'m playing. Ask me what I want first.'}

${PLAYBOOK}

${RULES}

${DRAFTS}`;
}
