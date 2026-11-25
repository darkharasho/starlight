-- Runs once in every new Lua state, after the Rust functions are in `__api`.
-- CE's UI calls do nothing here: they return an "inert" object that accepts any
-- index, call or assignment. CE function names are looked up case-insensitively
-- (CE tables call both readInteger and ReadInteger); names a table defines
-- itself win, as globals.
local api = __api
__api = nil

local inert_mt = {}
local function inert() return setmetatable({}, inert_mt) end
inert_mt.__index = function() return inert() end
inert_mt.__newindex = function() end
inert_mt.__call = function() return inert() end
inert_mt.__tostring = function() return "" end
inert_mt.__len = function() return 0 end
inert_mt.__concat = function(a, b) return tostring(a) .. tostring(b) end
api.__inert = inert

-- A small stringlist (createStringlist, aobScan results).
local function stringlist(items)
  local list = { _items = items or {} }
  local mt = {}
  mt.__index = function(t, k)
    if type(k) == "number" then return t._items[k + 1] end
    local lk = type(k) == "string" and k:lower() or k
    if lk == "count" then return #t._items end
    if lk == "add" then return function(s, ...) local v = (s == t) and ... or s; t._items[#t._items + 1] = tostring(v); return #t._items - 1 end end
    if lk == "getstring" then return function(s, i) if s ~= t then i = s end; return t._items[i + 1] end end
    if lk == "clear" then return function() t._items = {} end end
    if lk == "destroy" then return function() end end
    if lk == "text" then return table.concat(t._items, "\n") end
    return inert()
  end
  mt.__newindex = function() end
  mt.__len = function(t) return #t._items end
  return setmetatable(list, mt)
end
api.__stringlist = stringlist

for _, name in ipairs(api.__inert_names) do
  if api[name] == nil then api[name] = function() return inert() end end
end
api.__inert_names = nil
api.getceversion = function() return 7.5 end
api.launchmonodatacollector = function() return 0 end
api.mono_initialize = function() return 0 end
api.synchronize = function(f, ...) if type(f) == "function" then return f(...) end end
api.createstringlist = function() return stringlist() end
api.stringlist_add = function(list, s) return list.add(s) end
api.beep = function() end

-- MessageDialog constants (Lazarus values).
api.mtwarning, api.mterror, api.mtinformation, api.mtconfirmation, api.mtcustom = 0, 1, 2, 3, 4
api.mbyes, api.mbno, api.mbok, api.mbcancel, api.mbabort, api.mbretry, api.mbignore = 0, 1, 2, 3, 4, 5, 6
api.mrnone, api.mrok, api.mrcancel, api.mrabort, api.mrretry, api.mrignore, api.mryes, api.mrno = 0, 1, 2, 3, 4, 5, 6, 7

setmetatable(_G, {
  __index = function(_, k)
    if type(k) == "string" then return api[k:lower()] end
  end,
})
