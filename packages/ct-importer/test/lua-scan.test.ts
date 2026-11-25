import { describe, it, expect } from 'vitest';
import { scanLua } from '../src/lua-scan.js';
import api from '../src/lua-api.json' with { type: 'json' };

describe('scanLua', () => {
  it('accepts the CE functions the runtime provides', () => {
    expect(scanLua('openProcess("game.exe")\nwriteInteger("pBase+10", 5)')).toEqual({ unsupported: [], registers: [] });
  });

  it('reports unknown globals, but not Lua std, local functions, strings or comments', () => {
    expect(scanLua('createThread(f)').unsupported).toEqual(['createthread']);
    expect(scanLua('function helper() end\nhelper()').unsupported).toEqual([]);
    expect(scanLua('local s = string.format("%d", math.floor(1.5))\nfor k, v in pairs({}) do print(k) end').unsupported).toEqual([]);
    expect(scanLua('print("createThread(x)") -- injectDLL(y)\n--[[ executeCode(z) ]]').unsupported).toEqual([]);
    expect(scanLua('local function go(cb) cb() end\nlocal f = function() end\nf()\ngo(f)').unsupported).toEqual([]);
    expect(scanLua('os.execute("rm -rf /")\nio.open("x")').unsupported).toEqual(['os.execute', 'io.open']);
    expect(scanLua('loadstring(blob)()\ncreateThread(a)\ncreateThread(b)').unsupported).toEqual(['loadstring', 'createthread']);
  });

  it('a function assigned to a UI event is ui-callback', () => {
    expect(scanLua('local m = createMenuItem(x); m.OnClick = function() writeInteger("a",1) end').unsupported).toEqual(['ui-callback']);
    expect(scanLua('local m = createMenuItem(x); m.Caption = "x"').unsupported).toEqual([]);
  });

  it('switching records or reading them through the address list is addresslist-write', () => {
    expect(scanLua('getAddressList().getMemoryRecordByDescription("God").Active = true').unsupported).toEqual(['addresslist-write']);
    expect(scanLua('local v = AddressList.getMemoryRecordByID(5).Value').unsupported).toEqual(['addresslist-write']);
    expect(scanLua('memrec.Active = false').unsupported).toEqual(['addresslist-write']);
    expect(scanLua('memrec.Color = 0xff').unsupported).toEqual([]);
  });

  it('collects literal registerSymbol names', () => {
    expect(scanLua('registerSymbol("pPlayer", 0x1000)\nregisterSymbol(n, 1)').registers).toEqual(['pplayer']);
  });

  it('the API list is lowercase with no duplicates', () => {
    const all = [...api.real, ...api.inert];
    expect(all.every((n) => n === n.toLowerCase())).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('scanLua: Lua std', () => {
  it('only library members the sandbox has pass; coroutine is not there', () => {
    expect(scanLua('local x = math.floor(1.5) + table.unpack({1})').unsupported).toEqual([]);
    expect(scanLua('local x = math.pow(2, 3)').unsupported).toEqual(['math.pow']);
    expect(scanLua('local n = table.getn(t)').unsupported).toEqual(['table.getn']);
    expect(scanLua('local co = coroutine.wrap(f)').unsupported).toEqual(['coroutine.wrap']);
    expect(scanLua('local a, b = unpack({1, 2})').unsupported).toEqual([]);
    expect(scanLua('load("return 1")()').unsupported).toEqual(['load']);
  });
});
