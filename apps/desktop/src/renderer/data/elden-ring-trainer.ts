/* Hand-crafted Starlight Trainer JSON for Phase 3 demo purposes.
 * Phase 4 will replace this with real importer output via IPC.
 *
 * The shape mirrors what @starlight/ct-importer emits — keep the field
 * names in sync with packages/ct-importer/src/starlight-format.ts. */

export interface MockAddress {
  kind: 'absolute' | 'module' | 'pointer' | 'aob';
  address?: string;
  module?: string;
  offset?: string;
  baseOffset?: string;
  offsets?: string[];
  pattern?: string;
}

export interface MockSupportedCheat {
  id: string;
  name: string;
  description?: string;
  type: 'freeze' | 'set' | 'toggle';
  valueType: 'int8'|'uint8'|'int16'|'uint16'|'int32'|'uint32'|'int64'|'uint64'|'float'|'double'|'string';
  value?: number;
  default?: number;
  step?: number;
  min?: number;
  max?: number;
  address: MockAddress;
  hotkeys?: { toggle?: string; inc?: string; dec?: string };
  unsupported?: false;
}

export interface MockUnsupportedCheat {
  id: string;
  name: string;
  description?: string;
  unsupported: true;
  unsupportedReason: string;
  originalSource?: string;
}

export type MockCheat = MockSupportedCheat | MockUnsupportedCheat;

export interface MockCategory { name: string; cheats: MockCheat[] }

export interface MockTrainer {
  schemaVersion: 1;
  id: string;
  game: { name: string; processName: string[]; steamAppId?: number; platform: string[]; coverUrl: string };
  metadata: { author?: string; source: { url?: string; convertedFrom: '.CT' }; warnings?: string[] };
  categories: MockCategory[];
}

export const ELDEN_RING_TRAINER: MockTrainer = {
  schemaVersion: 1,
  id: 'starlight-elden-ring-frx-1',
  game: {
    name: 'Elden Ring',
    processName: ['eldenring.exe', 'start_protected_game.exe'],
    steamAppId: 1245620,
    platform: ['windows'],
    coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg',
  },
  metadata: {
    author: 'FLiNG (FRX)',
    source: { url: 'https://fearlessrevolution.com/...', convertedFrom: '.CT' },
    warnings: ['4 entries unsupported (Lua scripts)'],
  },
  categories: [
    {
      name: 'Player',
      cheats: [
        {
          id: 'infinite-hp',
          name: 'Infinite HP',
          description: 'Freezes current HP at maximum. Compatible with all weapons.',
          type: 'freeze',
          valueType: 'int32',
          value: 999999,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4a2b3c', offsets: ['0x10', '0x20'] },
          hotkeys: { toggle: 'F1' },
        },
        {
          id: 'infinite-stamina',
          name: 'Infinite Stamina',
          description: "Stamina won't decrease while active.",
          type: 'freeze',
          valueType: 'float',
          value: 100.0,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4a2b40', offsets: ['0x10', '0x24'] },
          hotkeys: { toggle: 'F2' },
        },
        {
          id: 'one-hit-kills',
          name: 'One-Hit Kills',
          description: 'Multiplies outgoing damage by 100×.',
          type: 'freeze',
          valueType: 'float',
          value: 100,
          address: { kind: 'aob', module: 'eldenring.exe', pattern: 'F3 0F 11 ?? ?? ?? ?? F3 0F 10', offset: '0x3' },
          hotkeys: { toggle: 'F3' },
        },
        {
          id: 'movement-speed',
          name: 'Movement Speed Multiplier',
          description: '1.0 = normal · step 0.1 · clamped to 0.1–10.0',
          type: 'set',
          valueType: 'float',
          default: 1.5,
          step: 0.1,
          min: 0.1,
          max: 10.0,
          address: { kind: 'aob', module: 'eldenring.exe', pattern: 'F3 0F 10 35 ?? ?? ?? ??', offset: '0x4' },
          hotkeys: { toggle: 'F4', inc: 'PageUp', dec: 'PageDown' },
        },
        {
          id: 'no-fall-damage',
          name: 'No Fall Damage',
          description: 'Disables fall damage calculation.',
          type: 'freeze',
          valueType: 'float',
          value: 0,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4a2b80', offsets: ['0x18'] },
          hotkeys: { toggle: 'F5' },
        },
        {
          id: 'auto-block-script',
          name: 'Auto-Block Script',
          description: 'Uses Cheat Engine Lua API — open the original .CT in CE to use this entry.',
          unsupported: true,
          unsupportedReason: 'Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.',
        },
      ],
    },
    {
      name: 'Stats',
      cheats: [
        {
          id: 'set-souls',
          name: 'Set Runes',
          description: 'Integer · step 1000.',
          type: 'set',
          valueType: 'int32',
          default: 50000,
          step: 1000,
          min: 0,
          max: 999999999,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4b1000', offsets: ['0x40'] },
          hotkeys: { toggle: 'F7', inc: 'F7+Up', dec: 'F7+Down' },
        },
      ],
    },
  ],
};
