import { describe, it, expect } from 'vitest';
import { clampCtVersion } from '../../src/main/ct-cache.js';

describe('clampCtVersion', () => {
  it('lowers a too-new table version to the bundled CE max', () => {
    expect(clampCtVersion('<CheatTable CheatEngineTableVersion="46">', 45))
      .toContain('CheatEngineTableVersion="45"');
  });

  it('leaves an already-supported version untouched', () => {
    const src = '<CheatTable CheatEngineTableVersion="45">';
    expect(clampCtVersion(src, 45)).toBe(src);
  });

  it('does not raise an older version', () => {
    expect(clampCtVersion('<CheatTable CheatEngineTableVersion="43">', 45))
      .toContain('CheatEngineTableVersion="43"');
  });

  it('preserves the rest of the table unchanged', () => {
    const src = '<?xml version="1.0"?><CheatTable CheatEngineTableVersion="46"><CheatEntries/></CheatTable>';
    const out = clampCtVersion(src, 45);
    expect(out).toBe('<?xml version="1.0"?><CheatTable CheatEngineTableVersion="45"><CheatEntries/></CheatTable>');
  });
});
