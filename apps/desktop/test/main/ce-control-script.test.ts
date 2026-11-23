import { describe, it, expect } from 'vitest';
import { parse as parseLua } from 'luaparse';
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
    expect(lua).toMatch(/if firstLoad and OPEN_PROCESS_NAME then attachTo\(OPEN_PROCESS_NAME\)/);
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
    expect(lua).toContain('local pendingTable = CT_PATH');
    expect(lua).toMatch(/loadTable\(path, false\)/);
  });

  it('leaves CT_PATH nil when no table path is given', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toContain('local CT_PATH = nil');
  });

  it('starts the poll loop before loading the table so a blocking table cannot wedge the bridge', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://127.0.0.1:1', ctPath: '/tmp/x.ct' });
    expect(lua.indexOf('poll.Enabled = true')).toBeGreaterThan(-1);
    expect(lua.indexOf('poll.Enabled = true')).toBeLessThan(lua.lastIndexOf('loadTimer.Enabled = true'));
    expect(lua).toContain('ready = tableReady');
  });

  it('closes windows a table script pops up, including modal ones', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://127.0.0.1:1' });
    expect(lua).toContain('local function sweepForms()');
    expect(lua).toContain('f.ModalResult = 2');
    expect(lua).toContain('sweeper.Enabled = true');
  });

  it('reports record kind, depth and value, and diagnoses a failed enable', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://127.0.0.1:1' });
    for (const s of ['kind = kind', 'depth = recDepth(r)', 'item.value = recValue(r)', 'pcall(autoAssemble, r.Script)']) {
      expect(lua).toContain(s);
    }
  });

  it('routes the value, speed, scanner and memory commands', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://127.0.0.1:1' });
    for (const m of ['refresh', 'set_value', 'set_speed', 'scan_first', 'scan_next', 'scan_status', 'scan_results', 'scan_reset', 'mem_read', 'mem_write', 'freeze_set', 'freeze_clear', 'shutdown']) {
      expect(lua).toContain(`cmd.method == "${m}"`);
    }
    expect(lua).toContain('speedhack_setSpeed');
  });

  it('shutdown disables active cheats and restores normal speed', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://127.0.0.1:1' });
    const shutdown = lua.slice(lua.indexOf('cmd.method == "shutdown"'));
    expect(shutdown).toContain('deactivateAll()');
    expect(lua).toContain('if r and r.Active then r.Active = false end');
    expect(shutdown).toContain('pcall(speedhack_setSpeed, 1)');
  });

  it('is valid Lua whatever it is given (a syntax error would silently kill the whole session)', () => {
    for (const opts of [
      { bridgeUrl: 'http://127.0.0.1:1' },
      { bridgeUrl: 'http://127.0.0.1:1', openProcessName: '9Kings.exe', ctPath: 'Z:\\home\\me\\it\'s "a" table.ct' },
    ]) {
      expect(() => parseLua(generateControlScript(opts), { luaVersion: '5.3' })).not.toThrow();
    }
  });

  it('can swap tables in place, on the load timer rather than inside the command', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    const cmd = lua.slice(lua.indexOf('cmd.method == "load_table"'), lua.indexOf('cmd.method == "set_hotkeys"'));
    expect(cmd).toContain('deactivateAll()');           // leave the game clean first
    expect(cmd).toContain('pendingTable = p.path');
    expect(cmd).toContain('loadTimer.Enabled = true');
    expect(cmd).not.toContain('loadTable(');
  });

  it('judges a script by looking its signatures up, never by running it', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    const fn = lua.slice(lua.indexOf('local function checkScript(r)'), lua.indexOf('-- ── memory scanner'));
    expect(fn).toContain('AOBScanModuleUnique');
    expect(fn).toContain('AOBScanUnique');
    expect(fn).toContain('"driven by Lua"');            // can't tell → unknown, not a pass
    expect(fn).not.toMatch(/r\.Active\s*=/);
    expect(fn).not.toContain('autoAssemble(');
  });

  it('registers in-game hotkeys that toggle a record and report back', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    const cmd = lua.slice(lua.indexOf('cmd.method == "set_hotkeys"'), lua.indexOf('cmd.method == "set_value"'));
    expect(cmd).toContain('clearHotkeys()');
    expect(cmd).toMatch(/createHotkey\(function\(\)/);
    expect(cmd).toContain('postEvent({ type = "hotkey"');
    expect(lua).toContain('BRIDGE_URL .. "/event"');
  });

  it('reports each record\'s option flags and table-defined hotkey', () => {
    const lua = generateControlScript({ bridgeUrl: 'http://x' });
    expect(lua).toContain('item.opts = tostring(o)');
    expect(lua).toContain('item.hotkey = tostring(h.HotkeyString)');
  });
});
