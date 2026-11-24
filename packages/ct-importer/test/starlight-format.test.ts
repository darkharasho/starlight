import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASON_CODES, reasonCopy } from '../src/reasons.js';
import { StarlightTrainerSchema, isValueCheat, isPatchCheat, type StarlightTrainer, type StarlightCheat } from '../src/starlight-format.js';

describe('StarlightTrainerSchema', () => {
  it('accepts a minimal valid trainer', () => {
    const t: StarlightTrainer = {
      schemaVersion: 2,
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

  const base = (cheats: unknown[], over: Record<string, unknown> = {}) => ({
    schemaVersion: 2, id: 'x',
    game: { name: 'X', processName: ['x.exe'], platform: ['windows'] },
    metadata: { source: { convertedFrom: '.CT' } },
    categories: [{ name: 'C', cheats }],
    ...over,
  });
  const site = { kind: 'aob', module: 'x.exe', pattern: '48 8B ?? 89' };
  const patch = (extra: Record<string, unknown> = {}) => ({
    id: 'p', name: 'P', type: 'patch', site,
    enable: [
      { op: 'alloc', name: 'cave', size: 64 },
      { op: 'assemble', at: 'cave', source: 'ret' },
      { op: 'writeBytes', at: 'site', bytes: '90ab', original: '4889' },
      { op: 'registerSymbol', name: 'hook', at: 'cave' },
    ],
    ...extra,
  });

  it('loads a v1 file and upgrades it to schemaVersion 2 unchanged otherwise', () => {
    const cats = [{ name: 'C', cheats: [{
      id: 'a', name: 'A', type: 'freeze', valueType: 'int32', value: 1,
      address: { kind: 'absolute', address: '0x1' },
    }] }];
    const v1 = base([], { schemaVersion: 1, categories: cats });
    const out = StarlightTrainerSchema.parse(v1);
    expect(out.schemaVersion).toBe(2);
    expect(out.categories).toEqual(cats);
  });

  it('accepts a v2 patch cheat with alloc/assemble/writeBytes/registerSymbol steps', () => {
    expect(() => StarlightTrainerSchema.parse(base([patch()]))).not.toThrow();
  });

  it('accepts convertedFrom "starlight"', () => {
    expect(() => StarlightTrainerSchema.parse(
      base([], { metadata: { source: { convertedFrom: 'starlight' } } }))).not.toThrow();
  });

  it('rejects a patch site that is not an aob address', () => {
    expect(() => StarlightTrainerSchema.parse(
      base([patch({ site: { kind: 'module', module: 'x.exe', offset: '0x10' } })]))).toThrow();
  });

  it('rejects writeBytes with odd-length hex', () => {
    expect(() => StarlightTrainerSchema.parse(base([patch({
      enable: [{ op: 'writeBytes', at: 'site', bytes: '9' }],
    })]))).toThrow();
  });

  it('isValueCheat/isPatchCheat tell the three cheat kinds apart', () => {
    const t = StarlightTrainerSchema.parse(base([
      { id: 'a', name: 'A', type: 'freeze', valueType: 'int32', address: { kind: 'absolute', address: '0x1' } },
      patch(),
      { id: 'u', name: 'U', unsupported: true, unsupportedReason: 'no' },
    ]));
    const [v, p, u] = t.categories[0].cheats as StarlightCheat[];
    expect([isValueCheat(v), isValueCheat(p), isValueCheat(u)]).toEqual([true, false, false]);
    expect([isPatchCheat(v), isPatchCheat(p), isPatchCheat(u)]).toEqual([false, true, false]);
  });

  it('accepts a v2 value cheat with a symbol address and offsets', () => {
    const c = { id: 's', name: 'S', type: 'freeze', valueType: 'int32', value: 1,
      address: { kind: 'symbol', expr: 'player+10', offsets: ['0x4', '0x8'] } };
    expect(() => StarlightTrainerSchema.parse(base([c]))).not.toThrow();
  });

  it('rejects a symbol address in a v1 file', () => {
    const cats = [{ name: 'C', cheats: [{
      id: 'a', name: 'A', type: 'freeze', valueType: 'int32', value: 1,
      address: { kind: 'symbol', expr: 'player' },
    }] }];
    expect(() => StarlightTrainerSchema.parse(base([], { schemaVersion: 1, categories: cats }))).toThrow();
  });

  it('accepts a patch cheat without a site and with aobScan/unregisterSymbol steps', () => {
    const c = { id: 'p', name: 'P', type: 'patch',
      enable: [
        { op: 'aobScan', name: 'hook', module: 'x.exe', pattern: '48 8B ??' },
        { op: 'aobScan', name: 'hook2', pattern: '90 90' },
      ],
      disable: [{ op: 'unregisterSymbol', name: 'hook' }] };
    expect(() => StarlightTrainerSchema.parse(base([c]))).not.toThrow();
  });

  it('every reason code has player copy', () => {
    for (const c of REASON_CODES) expect(reasonCopy(c), c).not.toBe('This table needs Cheat Engine.');
    expect(reasonCopy('lua:table-script')).toBe('This table runs Lua code when it loads.');
    expect(reasonCopy('lua:block')).toBe('A script in this table runs Lua code.');
    expect(reasonCopy('aa:createthread')).toBe('A script starts its own thread in the game.');
    expect(reasonCopy('asm:error')).toBe("A script uses an instruction Starlight can't assemble yet.");
    expect(reasonCopy('sym:mono')).toBe("A script uses Mono/IL2CPP names (needs Cheat Engine's Mono features).");
    expect(reasonCopy('table:empty')).toBe('This table has no cheats to run.');
    expect(reasonCopy('nope')).toBe('This table needs Cheat Engine.');
  });

  it('every catalog trainer in packages/catalog/trainers still parses', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../catalog/trainers');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      expect(() => StarlightTrainerSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))), f).not.toThrow();
    }
  });
});
