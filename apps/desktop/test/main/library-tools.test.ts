// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isSteamTool } from '../../src/main/library-host.js';

describe('isSteamTool', () => {
  it('flags Steam\'s own runtimes and compatibility tools', () => {
    for (const n of ['Proton 11.0', 'Proton - Experimental', 'Proton Hotfix', 'Steam Linux Runtime 1.0 (scout)', 'Steam Linux Runtime 3.0 (sniper)', 'Steamworks Common Redistributables']) {
      expect(isSteamTool(n)).toBe(true);
    }
  });
  it('keeps real games, including ones that merely start with similar letters', () => {
    for (const n of ['9 Kings', 'Protontown', 'Steamworld Dig', 'Palworld']) expect(isSteamTool(n)).toBe(false);
  });
});
