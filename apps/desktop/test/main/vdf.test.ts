import { describe, it, expect } from 'vitest';
import { parseVdf } from '../../src/main/vdf.js';

describe('parseVdf', () => {
  it('parses flat key-value pairs', () => {
    const input = `"name" "Counter-Strike 2"\n"appid" "730"\n`;
    expect(parseVdf(input)).toEqual({ name: 'Counter-Strike 2', appid: '730' });
  });

  it('parses nested objects', () => {
    const input = `
"libraryfolders"
{
  "0" {
    "path" "/home/user/.steam/steam"
    "label" ""
  }
  "1" {
    "path" "/mnt/games/SteamLibrary"
  }
}
`;
    expect(parseVdf(input)).toEqual({
      libraryfolders: {
        '0': { path: '/home/user/.steam/steam', label: '' },
        '1': { path: '/mnt/games/SteamLibrary' },
      },
    });
  });

  it('tolerates // comment lines', () => {
    const input = `// comment\n"a" "1"\n// another\n"b" "2"\n`;
    expect(parseVdf(input)).toEqual({ a: '1', b: '2' });
  });

  it('returns empty object for malformed input', () => {
    expect(parseVdf('"unterminated')).toEqual({});
    expect(parseVdf('{ no leading key }')).toEqual({});
  });
});
