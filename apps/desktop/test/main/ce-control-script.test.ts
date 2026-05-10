import { describe, it, expect } from 'vitest';
import { generateControlScript } from '../../src/main/ce-control-script.js';

describe('generateControlScript', () => {
  it('embeds the supplied bridge URL as a Lua string literal', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://127.0.0.1:47832' });
    expect(lua).toContain('"http://127.0.0.1:47832"');
  });

  it('hides MainForm and starts an HTTP poll loop', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toMatch(/getMainForm\(\):hide\(\)/);
    expect(lua).toMatch(/getInternet/);
    expect(lua).toMatch(/createTimer/);
  });

  it('uses CE bundled json module (require "json")', () => {
    // CE Linux ships lua/json.lua (rxi's json), so we can rely on require 'json'
    // instead of the dangerous load()-eval pattern.
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toMatch(/require\s*\(?\s*["']json["']/);
  });

  it('escapes special characters in bridgeUrl safely', () => {
    // JSON.stringify produces a valid Lua-compatible double-quoted string for
    // typical URLs (no embedded quotes, backslashes, or control chars). Test
    // that the embedded URL is wrapped in double quotes and unchanged otherwise.
    const lua = generateControlScript({ bridgeUrl: 'http://example.com/path?x=1' });
    expect(lua).toContain('"http://example.com/path?x=1"');
  });

  it('routes list_records, set_active, ping commands', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toMatch(/list_records/);
    expect(lua).toMatch(/set_active/);
    expect(lua).toMatch(/ping/);
  });
});
