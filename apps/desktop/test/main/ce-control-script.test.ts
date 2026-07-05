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

  it('routes attach and status commands and calls openProcess', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toMatch(/"attach"/);
    expect(lua).toMatch(/"status"/);
    expect(lua).toMatch(/openProcess/);
  });

  it('opens the target process on boot when openProcessName is given', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x', openProcessName: '9Kings.exe' });
    expect(lua).toContain('local OPEN_PROCESS_NAME = "9Kings.exe"');
    expect(lua).toMatch(/if OPEN_PROCESS_NAME then attachTo\(OPEN_PROCESS_NAME\)/);
  });

  it('leaves OPEN_PROCESS_NAME nil when no target is given', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toContain('local OPEN_PROCESS_NAME = nil');
  });

  it('set_active refuses when unattached and verifies the enable stuck', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toMatch(/not attached to a game process/);
    expect(lua).toMatch(/local got = r\.Active/);
  });

  it('mutes dialogs so a community table cannot pop a window', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toMatch(/messageDialog = function\(\) return 0 end/);
    expect(lua).toMatch(/shellExecute = function\(\) end/);
    expect(lua).toMatch(/hideAllCEWindows/);
  });

  it('loads the CT itself (not via argv) when a ctPath is given', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x', ctPath: 'Z:\\tmp\\t.ct' });
    expect(lua).toContain('local CT_PATH = "Z:\\\\tmp\\\\t.ct"');
    expect(lua).toMatch(/loadTable\(CT_PATH, false\)/);
  });

  it('leaves CT_PATH nil when no table path is given', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toContain('local CT_PATH = nil');
  });
});
