import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCt } from '../src/ct-importer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(HERE, 'fixtures/synthetic', name), 'utf8');

describe('importCt', () => {
  it('imports basic-static.ct: 2 supported cheats in 1 default category', () => {
    const result = importCt(fixture('basic-static.ct'), {
      gameName: 'Test Target',
      processName: ['target'],
    });
    expect(result.stats).toEqual({ total: 2, supported: 2, unsupported: 0, categories: 1 });
    expect(result.trainer.categories).toHaveLength(1);
    expect(result.trainer.categories[0]!.cheats).toHaveLength(2);
    expect(result.trainer.game.name).toBe('Test Target');
  });

  it('imports grouped.ct: 2 categories with 1 cheat each', () => {
    const result = importCt(fixture('grouped.ct'), {
      gameName: 'Test Target',
      processName: ['target'],
    });
    expect(result.stats).toEqual({ total: 2, supported: 2, unsupported: 0, categories: 2 });
    expect(result.trainer.categories.map((c) => c.name)).toEqual(['Player', 'Stats']);
  });

  it('imports lua-script.ct as 1 unsupported entry', () => {
    const result = importCt(fixture('lua-script.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.stats).toEqual({ total: 1, supported: 0, unsupported: 1, categories: 1 });
    const cheat = result.trainer.categories[0]!.cheats[0]!;
    expect('unsupported' in cheat && cheat.unsupported).toBe(true);
  });

  it('imports mixed-real-shape.ct: counts stats correctly', () => {
    const result = importCt(fixture('mixed-real-shape.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.stats.total).toBe(4);
    expect(result.stats.supported).toBe(3);
    expect(result.stats.unsupported).toBe(1);
  });

  it('produced trainer validates against the schema', () => {
    const result = importCt(fixture('mixed-real-shape.ct'), {
      gameName: 'X', processName: ['x'],
    });
    return import('../src/starlight-format.js').then((m) => {
      expect(() => m.StarlightTrainerSchema.parse(result.trainer)).not.toThrow();
    });
  });

  it('puts top-level non-grouped cheats in a single "General" category', () => {
    const result = importCt(fixture('hotkeys.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.trainer.categories).toHaveLength(1);
    expect(result.trainer.categories[0]!.name).toBe('General');
  });
});
