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

export const INSTRUCTIONS = `Starlight is a game trainer. These tools let you find and build cheats for a single-player game the player is running, together with the player.

${PLAYBOOK}

${RULES}`;

export function findACheatPrompt(goal?: string): string {
  const want = goal?.trim();
  return `${want ? `Help me make a cheat in the game I'm playing: ${want}.` : 'Help me make a cheat in the game I\'m playing. Ask me what I want first.'}

${PLAYBOOK}

${RULES}`;
}
