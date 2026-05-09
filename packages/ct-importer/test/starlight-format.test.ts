import { describe, it, expect } from 'vitest';
import { StarlightTrainerSchema, type StarlightTrainer } from '../src/starlight-format.js';

describe('StarlightTrainerSchema', () => {
  it('accepts a minimal valid trainer', () => {
    const t: StarlightTrainer = {
      schemaVersion: 1,
      id: 'starlight-elden-ring-frx-1',
      game: {
        name: 'Elden Ring',
        steamAppId: 1245620,
        processName: ['eldenring.exe'],
        platform: ['windows'],
      },
      metadata: { author: 'FLiNG', source: { convertedFrom: '.CT' } },
      categories: [
        {
          name: 'Player',
          cheats: [
            {
              id: 'infinite-hp',
              name: 'Infinite HP',
              type: 'freeze',
              valueType: 'int32',
              value: 999999,
              address: { kind: 'absolute', address: '0x12345678' },
            },
          ],
        },
      ],
    };
    expect(StarlightTrainerSchema.parse(t)).toEqual(t);
  });

  it('rejects unknown valueType', () => {
    const t = {
      schemaVersion: 1, id: 'x',
      game: { name: 'X', processName: ['x.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [{ name: 'C', cheats: [{
        id: 'c', name: 'c', type: 'freeze',
        valueType: 'banana', value: 0,
        address: { kind: 'absolute', address: '0x0' },
      }] }],
    };
    expect(() => StarlightTrainerSchema.parse(t)).toThrow();
  });

  it('accepts an unsupported entry without address', () => {
    const t = {
      schemaVersion: 1, id: 'x',
      game: { name: 'X', processName: ['x.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [{ name: 'C', cheats: [{
        id: 'lua-cheat',
        name: 'Lua Cheat',
        unsupported: true,
        unsupportedReason: 'Uses Cheat Engine Lua API.',
        originalSource: '<lua>...</lua>',
      }] }],
    };
    expect(() => StarlightTrainerSchema.parse(t)).not.toThrow();
  });

  it('accepts a value cheat with stepper config', () => {
    const t = {
      schemaVersion: 1, id: 'x',
      game: { name: 'X', processName: ['x.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [{ name: 'C', cheats: [{
        id: 'speed',
        name: 'Speed',
        type: 'set',
        valueType: 'float',
        default: 1.0,
        step: 0.1,
        min: 0.1,
        max: 10.0,
        address: { kind: 'absolute', address: '0x0' },
        hotkeys: { toggle: 'F4', inc: 'F4+Up', dec: 'F4+Down' },
      }] }],
    };
    expect(() => StarlightTrainerSchema.parse(t)).not.toThrow();
  });
});
