export interface ControlScriptOpts {
  /** Base URL of the Electron main-process bridge, e.g. "http://127.0.0.1:47832". */
  bridgeUrl: string;
  /**
   * Windows/Linux process name (e.g. "9Kings.exe") to open on boot so cheats
   * have a target. When omitted, no process is opened automatically and the
   * host can send an `attach` command later.
   */
  openProcessName?: string | undefined;
  /** Process id to open instead of a name (native games through ceserver). */
  openProcessPid?: number | undefined;
  /**
   * ceserver to connect to before opening the process. Set for native Linux
   * games: Windows CE then reads and writes the game's memory through it.
   */
  ceServer?: { host: string; port: number } | undefined;
  /**
   * CE-openable path to the .CT to load (Linux path for native CE, `Z:\…` Wine
   * path for Windows CE). Loaded by the script AFTER dialogs are muted, so a
   * community table can't pop a window. When omitted, no table is loaded and
   * the session offers only the table-free tools (speed, memory scanner).
   */
  ctPath?: string | undefined;
}

/**
 * Returns the Lua source that gets dropped into CE's `autorun/zzz-starlight.lua`.
 * On CE startup the script:
 *   1. Hides MainForm so CE never appears as a separate window.
 *   2. Starts polling `<bridgeUrl>/poll` for commands (results go to `/result`)
 *      and a "form sweeper" that closes any window a table script pops.
 *   3. Opens the target process and loads the table. This happens AFTER the
 *      poll loop is running, so a table whose load-time script blocks in a
 *      modal form can no longer wedge the whole session.
 *
 * Commands:
 *   - ping                    → { ok, ready, attached }   (ready = table load finished)
 *   - status                  → { attached, pid, ready, tableError? }
 *   - attach(name)            → { ok, pid, error? }
 *   - list_records            → { records: [{ id, name, isActive, isGroupHeader, kind, depth, value?, options? }] }
 *   - refresh                 → { states: [{ id, a, v? }] }   (cheap re-read of active + values)
 *   - set_active(id, active)  → { ok, active, error? }   (error is the table's real message)
 *   - set_value(id, value)    → { ok, value, error? }
 *   - set_speed(speed)        → { ok, speed, error? }
 *   - scan_first / scan_next / scan_status / scan_results / scan_reset   (memory scanner)
 *   - mem_read / mem_write / freeze_set / freeze_clear                   (addresses found by a scan)
 *   - load_table(path)        → { ok }   (swap to another table in place; poll ping for ready)
 *   - check_script(id)        → { ok, error? }   (assemble-check a script without running it)
 *   - set_hotkeys(bindings, replace) → { ok, count }   (in-game hotkeys that toggle a record)
 *   - shutdown                → { ok }   (disable every cheat, reset speed, drop freezes)
 *
 * Hotkey presses are reported by POSTing `{ type: "hotkey", id, ok, active, error? }`
 * to `<bridgeUrl>/event`.
 */
export function generateControlScript(opts: ControlScriptOpts): string {
  // JSON.stringify gives us a valid Lua-compatible double-quoted string literal
  // (escapes \n, \", \\, etc.) for any string the caller throws at us.
  const url = JSON.stringify(opts.bridgeUrl);
  const openName = opts.openProcessName ? JSON.stringify(opts.openProcessName) : 'nil';
  const ctPath = opts.ctPath ? JSON.stringify(opts.ctPath) : 'nil';
  const openPid = Number.isInteger(opts.openProcessPid) ? String(opts.openProcessPid) : 'nil';
  const ceServer = opts.ceServer && Number.isInteger(opts.ceServer.port)
    ? `{ host = ${JSON.stringify(opts.ceServer.host)}, port = ${opts.ceServer.port} }`
    : 'nil';
  return `\
-- Starlight CE control script. Auto-generated; do not edit by hand.

-- Keep CE fully invisible. Hide the window as the very first thing we do —
-- before requiring modules — to minimise any flash of the CE main form.
local function hideCE()
  pcall(function() getMainForm():hide() end)
  pcall(function() hideAllCEWindows() end)
end
local function muteDialogs()
  -- messageDialog returns mrNone(0) so a table's \`== mrYes\` branch never fires.
  pcall(function() messageDialog = function() return 0 end end)
  pcall(function() showMessage = function() end end)
  pcall(function() shellExecute = function() end end)  -- never open a browser
end
hideCE()
muteDialogs()

-- CE creates and shows its main form during startup, which can flash on screen
-- before the autorun runs. Hammer hide() on a fast timer for the first few
-- seconds so the form is re-hidden the instant it appears (imperceptible).
local _hideTimer = createTimer(nil, false)
_hideTimer.Interval = 5
local _hideTicks = 0
_hideTimer.OnTimer = function()
  hideCE()
  _hideTicks = _hideTicks + 1
  if _hideTicks > 800 then _hideTimer.Enabled = false end  -- ~4s
end
_hideTimer.Enabled = true

local BRIDGE_URL = ${url}
local OPEN_PROCESS_NAME = ${openName}
local OPEN_PROCESS_PID = ${openPid}
local CESERVER = ${ceServer}
local CT_PATH = ${ctPath}
local TRACE_PATH = "/tmp/starlight-ce.log"

local json = require("json")

local function trace(msg)
  local f = io.open(TRACE_PATH, "a")
  if f then f:write(os.date("%H:%M:%S") .. " " .. tostring(msg) .. "\\n"); f:close() end
end

trace("autorun loaded")

local attachedPid = 0
local tableReady = false
local tableError = nil
local currentSpeed = 1
local internet = nil
local pendingTable = CT_PATH
local loadTimer = nil
local hotkeys = {}

local function postEvent(ev)
  if not internet then return end
  pcall(function() internet.postURL(BRIDGE_URL .. "/event", json.encode(ev)) end)
end

local function attachTo(name)
  if not name then return false, 0 end
  local ok = pcall(function() openProcess(name) end)
  local pid = getOpenedProcessID and getOpenedProcessID() or 0
  attachedPid = pid
  trace("attach '" .. tostring(name) .. "' ok=" .. tostring(ok) .. " pid=" .. tostring(pid))
  return ok and pid ~= 0, pid
end

-- Close anything a table's script pops up (trainer forms, modal prompts). A
-- modal form runs its own message loop, which would otherwise block whatever
-- opened it — setting ModalResult ends that loop.
local function sweepForms()
  local n = getFormCount()
  for i = 0, n - 1 do
    pcall(function()
      local f = getForm(i)
      if f and f.ClassName ~= "TMainForm" and f.Visible then
        pcall(function() f.ModalResult = 2 end)
        pcall(function() f.hide() end)
      end
    end)
  end
end

-- ── records ────────────────────────────────────────────────────────────────

local function findRecord(id)
  local al = getAddressList()
  if not al then return nil end
  for idx = 0, al.Count - 1 do
    local r = al:getMemoryRecord(idx)
    if r and (r.ID or idx) == id then return r end
  end
  return nil
end

local function recKind(r)
  if r.IsGroupHeader then return "header" end
  if r.Type == vtAutoAssembler then return "script" end
  return "value"
end

local function recDepth(r)
  local d = 0
  pcall(function()
    local p = r.Parent
    while p and d < 32 do d = d + 1; p = p.Parent end
  end)
  return d
end

local function recValue(r)
  local v = nil
  pcall(function() v = r.Value end)
  if v == nil then return "" end
  return tostring(v)
end

local function describe(r, idx)
  local kind = recKind(r)
  local item = {
    id = r.ID or idx,
    name = r.Description or "",
    isActive = r.Active or false,
    isGroupHeader = r.IsGroupHeader or false,
    kind = kind,
    depth = recDepth(r),
  }
  pcall(function()
    local o = r.Options
    if o and tostring(o) ~= "" and tostring(o) ~= "[]" then item.opts = tostring(o) end
  end)
  -- A hotkey the table author bound to switching this record on/off.
  pcall(function()
    for i = 0, (r.HotkeyCount or 0) - 1 do
      local h = r.Hotkey[i]
      if h and h.action <= 2 and not item.hotkey then item.hotkey = tostring(h.HotkeyString) end
    end
  end)
  if kind == "value" then
    item.value = recValue(r)
    pcall(function()
      local n = r.DropDownCount or 0
      if n > 0 then
        local options = {}
        for i = 0, math.min(n, 200) - 1 do
          options[#options + 1] = { value = tostring(r.DropDownValue[i]), label = tostring(r.DropDownDescription[i]) }
        end
        item.options = options
      end
    end)
  end
  return item
end

-- CE only reports "the enable failed" by flipping Active back. Re-running the
-- script directly gives us the author's actual error text ("AOB not found", …).
local function diagnose(r)
  local okD, a, b = pcall(autoAssemble, r.Script)
  if okD and a then
    -- It assembled this time: undo that raw run and retry through the record
    -- so CE tracks the enable properly.
    pcall(autoAssemble, r.Script, false, b)
    r.Active = true
    if r.Active then return nil end
    return "cheat did not enable"
  end
  local msg = tostring((okD and b) or a or "cheat did not enable")
  return msg
end

-- Switches a record on/off and reports what actually happened.
-- Returns ok, active, error, pending.
local function setRecordActive(r, want)
  r.Active = want
  sweepForms()
  -- Async scripts finish later; report them as pending and let refresh settle it.
  local async = false
  pcall(function() async = r.Async and r.AsyncProcessing end)
  if async then return true, want, nil, true end
  -- CE reverts Active to false when an enable fails (e.g. the AOB signature
  -- no longer matches the game version). Read it back so the UI reflects
  -- reality instead of an optimistic guess.
  local got = r.Active and true or false
  if got == want then return true, got, nil, false end
  local err = nil
  if want and recKind(r) == "script" then
    err = diagnose(r)
    sweepForms()
    if err == nil then return true, true, nil, false end
  end
  return false, (r.Active and true or false), err or ("cheat did not " .. (want and "enable" or "disable")), false
end

local function deactivateAll()
  local al = getAddressList()
  if not al then return end
  -- Reverse order so children go before the script that set them up.
  for idx = al.Count - 1, 0, -1 do
    pcall(function()
      local r = al:getMemoryRecord(idx)
      if r and r.Active then r.Active = false end
    end)
  end
end

local function clearHotkeys()
  for _, h in ipairs(hotkeys) do pcall(function() h.destroy() end) end
  hotkeys = {}
end

-- Judges whether a script still matches the running game WITHOUT running it
-- (a cheat can be a one-shot action): looks up the byte signatures its enable
-- section scans for. Cheat Engine's own autoAssembleCheck only checks syntax —
-- it passes a script whose signature is nowhere in the game.
-- Returns found, missing, firstProblem — or nil, reason when it can't tell.
local function checkScript(r)
  local script = tostring(r.Script or "")
  local cut = script:lower():find("[disable]", 1, true)
  local enable = cut and script:sub(1, cut - 1) or script
  local low = enable:lower()
  if low:find("{$lua}", 1, true) or low:find("luacall", 1, true) then return nil, "driven by Lua" end
  local found, missing, problem = 0, 0, nil
  for line in low:gmatch("[^\\r\\n]+") do
    local l = line:gsub("//.*$", "")
    local name, mod, bytes = l:match("^%s*aobscanmodule%s*%(%s*([^,]+),%s*([^,]+),%s*([^%)]+)%)")
    local okS, addr = true, nil
    if name then
      mod = mod:gsub('^%s*"?', ''):gsub('"?%s*$', '')
      if mod == "$process" then mod = tostring(process or "") end
      okS, addr = pcall(AOBScanModuleUnique, mod, bytes)
    else
      name, bytes = l:match("^%s*aobscan%s*%(%s*([^,]+),%s*([^%)]+)%)")
      if name then okS, addr = pcall(AOBScanUnique, bytes) end
    end
    if name then
      if not okS then return nil, "scan unavailable" end
      if addr then found = found + 1
      else
        missing = missing + 1
        problem = problem or ("signature '" .. name:gsub("%s+$", "") .. "' is not in the game")
      end
    end
  end
  if found + missing == 0 then return nil, "no signatures to look up" end
  return found, missing, problem
end

-- ── memory scanner ─────────────────────────────────────────────────────────

local VT = { i8 = vtByte, i16 = vtWord, i32 = vtDword, i64 = vtQword, f32 = vtSingle, f64 = vtDouble }
local ALIGN = { i8 = "1", i16 = "2", i32 = "4", i64 = "4", f32 = "4", f64 = "4" }
local FIRST_OPS = {
  exact = soExactValue, between = soValueBetween, bigger = soBiggerThan,
  smaller = soSmallerThan, unknown = soUnknownValue,
}
local NEXT_OPS = {
  exact = soExactValue, between = soValueBetween, bigger = soBiggerThan, smaller = soSmallerThan,
  increased = soIncreasedValue, decreased = soDecreasedValue, changed = soChanged, unchanged = soUnchanged,
}

local scan = { ms = nil, fl = nil, busy = false, started = false, count = 0, vt = "i32" }

local function scanRelease()
  pcall(function() if scan.fl then scan.fl.deinitialize(); scan.fl.destroy() end end)
  pcall(function() if scan.ms then scan.ms.destroy() end end)
  scan.ms = nil; scan.fl = nil; scan.busy = false; scan.started = false; scan.count = 0
end

local function scanFinished()
  pcall(function()
    if not scan.fl then scan.fl = createFoundList(scan.ms) end
    scan.fl.initialize()
    scan.count = scan.fl.Count
  end)
  scan.busy = false
  trace("scan done count=" .. tostring(scan.count))
end

local function toAddress(a)
  if type(a) == "number" then return a end
  return tonumber(tostring(a), 16)
end

local function memRead(addr, vt)
  local v = nil
  pcall(function()
    if vt == "i8" then local b = readBytes(addr, 1, true); v = b and b[1]
    elseif vt == "i16" then v = readSmallInteger(addr)
    elseif vt == "i32" then v = readInteger(addr)
    elseif vt == "i64" then v = readQword(addr)
    elseif vt == "f32" then v = readFloat(addr)
    elseif vt == "f64" then v = readDouble(addr)
    end
  end)
  return v
end

local function memWrite(addr, vt, value)
  local n = tonumber(value)
  if n == nil then return false end
  local ok = false
  pcall(function()
    if vt == "i8" then ok = writeBytes(addr, math.floor(n) & 0xff)
    elseif vt == "i16" then ok = writeSmallInteger(addr, math.floor(n))
    elseif vt == "i32" then ok = writeInteger(addr, math.floor(n))
    elseif vt == "i64" then ok = writeQword(addr, math.floor(n))
    elseif vt == "f32" then ok = writeFloat(addr, n)
    elseif vt == "f64" then ok = writeDouble(addr, n)
    end
  end)
  return ok and true or false
end

-- address (hex string) → { vt, value }: rewritten on a timer to hold a value.
local frozen = {}
local frozenCount = 0
local freezeTimer = createTimer(nil, false)
freezeTimer.Interval = 100
freezeTimer.OnTimer = function()
  for addr, f in pairs(frozen) do memWrite(toAddress(addr), f.vt, f.value) end
end

-- ── command dispatch ───────────────────────────────────────────────────────

local function dispatch(cmd)
  local p = cmd.params or {}

  if cmd.method == "ping" then
    return { ok = true, ready = tableReady, attached = attachedPid ~= 0 }
  end

  if cmd.method == "status" then
    return { attached = attachedPid ~= 0, pid = attachedPid, ready = tableReady, tableError = tableError }
  end

  if cmd.method == "attach" then
    if p.name == nil then return { ok = false, error = "missing name" } end
    local ok, pid = attachTo(p.name)
    if ok then return { ok = true, pid = pid } end
    return { ok = false, pid = pid, error = "could not open process '" .. tostring(p.name) .. "'" }
  end

  if cmd.method == "list_records" then
    local al = getAddressList()
    local out = {}
    if al then
      for idx = 0, al.Count - 1 do
        local r = al:getMemoryRecord(idx)
        if r then out[#out + 1] = describe(r, idx) end
      end
    end
    return { records = out }
  end

  if cmd.method == "refresh" then
    local al = getAddressList()
    local out = {}
    if al then
      for idx = 0, al.Count - 1 do
        local r = al:getMemoryRecord(idx)
        if r then
          local s = { id = r.ID or idx, a = r.Active or false }
          if recKind(r) == "value" then s.v = recValue(r) end
          out[#out + 1] = s
        end
      end
    end
    return { states = out }
  end

  if cmd.method == "set_active" then
    local id = p.id
    if id == nil then return { ok = false, error = "missing id" } end
    if p.active and attachedPid == 0 then
      return { ok = false, active = false, error = "not attached to a game process" }
    end
    local r = findRecord(id)
    if not r then return { ok = false, error = "record not found" } end
    local ok, active, err, pending = setRecordActive(r, p.active and true or false)
    return { ok = ok, active = active, error = err, pending = pending or nil }
  end

  if cmd.method == "check_script" then
    local r = p.id ~= nil and findRecord(p.id) or nil
    if not r then return { ok = false, error = "record not found" } end
    local found, missing, why = checkScript(r)
    if found == nil then return { unknown = true, reason = missing } end
    if missing > 0 then return { ok = false, found = found, missing = missing, error = why } end
    return { ok = true, found = found }
  end

  if cmd.method == "load_table" then
    if p.path == nil then return { ok = false, error = "missing path" } end
    if not loadTimer then return { ok = false, error = "not ready" } end
    -- Leave the game clean before the old table's records disappear.
    clearHotkeys()
    deactivateAll()
    tableReady = false; tableError = nil
    pendingTable = p.path
    loadTimer.Enabled = true
    return { ok = true }
  end

  if cmd.method == "set_hotkeys" then
    clearHotkeys()
    -- Records whose table-defined toggle hotkey the user replaced or removed.
    for _, id in ipairs(p.replace or {}) do
      pcall(function()
        local r = findRecord(id)
        if not r then return end
        for i = (r.HotkeyCount or 0) - 1, 0, -1 do
          local h = r.Hotkey[i]
          if h and h.action <= 2 then h.destroy() end
        end
      end)
    end
    local n = 0
    for _, b in ipairs(p.bindings or {}) do
      local id = b.id
      local ok = pcall(function()
        local hk = createHotkey(function()
          local r = findRecord(id)
          if not r then return end
          local okT, active, err, pending = setRecordActive(r, not (r.Active and true or false))
          postEvent({ type = "hotkey", id = id, ok = okT, active = active, error = err, pending = pending or nil })
        end, b.keys)
        hk.DelayBetweenActivate = 400
        hotkeys[#hotkeys + 1] = hk
      end)
      if ok then n = n + 1 end
    end
    return { ok = true, count = n }
  end

  if cmd.method == "set_value" then
    local r = p.id ~= nil and findRecord(p.id) or nil
    if not r then return { ok = false, error = "record not found" } end
    if attachedPid == 0 then return { ok = false, error = "not attached to a game process" } end
    local ok, err = pcall(function() r.Value = tostring(p.value) end)
    if not ok then return { ok = false, error = tostring(err) } end
    return { ok = true, value = recValue(r) }
  end

  if cmd.method == "set_speed" then
    local s = tonumber(p.speed)
    if s == nil or s <= 0 then return { ok = false, error = "invalid speed" } end
    if attachedPid == 0 then return { ok = false, error = "not attached to a game process" } end
    local ok, err = pcall(speedhack_setSpeed, s)
    if not ok then return { ok = false, error = tostring(err) } end
    currentSpeed = s
    return { ok = true, speed = s }
  end

  if cmd.method == "scan_first" then
    if attachedPid == 0 then return { ok = false, error = "not attached to a game process" } end
    if scan.busy then return { ok = false, error = "a scan is already running" } end
    local vt = VT[p.valueType]; local op = FIRST_OPS[p.op]
    if not vt or not op then return { ok = false, error = "unsupported scan" } end
    scanRelease()
    scan.ms = createMemScan()
    scan.ms.OnScanDone = function() scanFinished() end
    scan.vt = p.valueType; scan.busy = true; scan.started = true
    local ok, err = pcall(function()
      scan.ms.firstScan(op, vt, rtRounded, tostring(p.value or ""), tostring(p.value2 or ""),
        0, 0x7fffffffffff, "+W-C", fsmAligned, ALIGN[p.valueType], false, false, false, true)
    end)
    if not ok then scanRelease(); return { ok = false, error = tostring(err) } end
    return { ok = true }
  end

  if cmd.method == "scan_next" then
    if not scan.started or not scan.ms then return { ok = false, error = "start a new scan first" } end
    if scan.busy then return { ok = false, error = "a scan is already running" } end
    local op = NEXT_OPS[p.op]
    if not op then return { ok = false, error = "unsupported scan" } end
    pcall(function() if scan.fl then scan.fl.deinitialize() end end)
    scan.busy = true
    local ok, err = pcall(function()
      scan.ms.nextScan(op, rtRounded, tostring(p.value or ""), tostring(p.value2 or ""), false, false, false, true, false)
    end)
    if not ok then scan.busy = false; return { ok = false, error = tostring(err) } end
    return { ok = true }
  end

  if cmd.method == "scan_status" then
    return { busy = scan.busy, started = scan.started, count = scan.count, valueType = scan.vt }
  end

  if cmd.method == "scan_results" then
    local items = {}
    if scan.fl and not scan.busy then
      local limit = math.min(tonumber(p.limit) or 100, 500)
      for i = 0, math.min(scan.count, limit) - 1 do
        local addr = scan.fl.Address[i]
        local v = memRead(toAddress(addr), scan.vt)
        items[#items + 1] = { address = addr, value = v ~= nil and tostring(v) or "" }
      end
    end
    return { count = scan.count, items = items, valueType = scan.vt }
  end

  if cmd.method == "scan_reset" then
    if scan.busy then return { ok = false, error = "a scan is still running" } end
    scanRelease()
    return { ok = true }
  end

  if cmd.method == "mem_read" then
    local values = {}
    for i, it in ipairs(p.items or {}) do
      local v = memRead(toAddress(it.address), it.valueType)
      values[i] = v ~= nil and tostring(v) or ""
    end
    return { values = values }
  end

  if cmd.method == "mem_write" then
    local addr = toAddress(p.address)
    if not addr then return { ok = false, error = "bad address" } end
    if frozen[p.address] then frozen[p.address].value = p.value end
    if memWrite(addr, p.valueType, p.value) then return { ok = true } end
    return { ok = false, error = "could not write that address" }
  end

  if cmd.method == "freeze_set" then
    if not toAddress(p.address) then return { ok = false, error = "bad address" } end
    if not frozen[p.address] then frozenCount = frozenCount + 1 end
    frozen[p.address] = { vt = p.valueType, value = p.value }
    freezeTimer.Enabled = true
    return { ok = true }
  end

  if cmd.method == "freeze_clear" then
    if frozen[p.address] then frozen[p.address] = nil; frozenCount = frozenCount - 1 end
    if frozenCount <= 0 then frozenCount = 0; freezeTimer.Enabled = false end
    return { ok = true }
  end

  if cmd.method == "shutdown" then
    -- Leave the game as we found it: run every active cheat's [DISABLE] (in
    -- reverse so children go before the script that set them up), restore
    -- normal speed and stop holding values. Otherwise code patches outlive the
    -- session and the next attach finds bytes the table no longer recognises.
    freezeTimer.Enabled = false; frozen = {}; frozenCount = 0
    clearHotkeys()
    deactivateAll()
    if currentSpeed ~= 1 then pcall(speedhack_setSpeed, 1); currentSpeed = 1 end
    scanRelease()
    trace("shutdown done")
    return { ok = true }
  end

  return { ok = false, error = "unknown method: " .. tostring(cmd.method) }
end

-- ── boot ───────────────────────────────────────────────────────────────────

local boot = createTimer(nil, false)
boot.Interval = 50
boot.OnTimer = function()
  boot.Enabled = false
  trace("boot timer fired")

  hideCE()
  muteDialogs()

  internet = getInternet("starlight")
  if not internet then trace("no internet client"); return end

  -- The poll loop and the form sweeper start BEFORE the table loads: timers
  -- keep firing inside a modal form's message loop, so even a table that pops
  -- a blocking prompt at load time gets its prompt closed and the bridge stays
  -- reachable.
  local poll = createTimer(nil, false)
  poll.Interval = 100
  poll.OnTimer = function()
    local body = internet.getURL(BRIDGE_URL .. "/poll")
    if not body or body == "" then return end
    local ok, cmd = pcall(json.decode, body)
    if not ok or type(cmd) ~= "table" or cmd.method == nil then return end
    local okR, result = pcall(dispatch, cmd)
    local payload
    if okR then
      payload = json.encode({ id = cmd.id or 0, result = result })
    else
      payload = json.encode({ id = cmd.id or 0, error = tostring(result) })
    end
    pcall(function() internet.postURL(BRIDGE_URL .. "/result", payload) end)
  end
  poll.Enabled = true

  local sweeper = createTimer(nil, false)
  sweeper.Interval = 250
  sweeper.OnTimer = function() sweepForms() end
  sweeper.Enabled = true
  trace("poll loop running")

  -- Loads \`pendingTable\`. Runs on its own timer (never inside a command) so a
  -- table that blocks while loading can't take the poll loop down with it. Also
  -- re-armed by \`load_table\` to swap tables without restarting Cheat Engine.
  local firstLoad = true
  loadTimer = createTimer(nil, false)
  loadTimer.Interval = 50
  loadTimer.OnTimer = function()
    loadTimer.Enabled = false
    if firstLoad then
      if CESERVER then
        -- From here on CE lists, reads and writes processes through ceserver.
        local ok, err = pcall(function() connectToCEServer(CESERVER.host, CESERVER.port) end)
        trace("ceserver " .. CESERVER.host .. ":" .. tostring(CESERVER.port) .. " ok=" .. tostring(ok) .. " err=" .. tostring(err))
      end
      if OPEN_PROCESS_PID then attachTo(OPEN_PROCESS_PID)
      elseif OPEN_PROCESS_NAME then attachTo(OPEN_PROCESS_NAME) end
    end
    firstLoad = false
    local path = pendingTable
    pendingTable = nil
    -- Load the table ourselves (dialogs already muted) instead of via argv, so
    -- a table's embedded LuaScript can't pop a window before we suppress it.
    if path then
      local ok, err = pcall(function() loadTable(path, false) end)
      trace("loadTable ok=" .. tostring(ok) .. " err=" .. tostring(err))
      if not ok then tableError = tostring(err) end
      hideCE()  -- a table load can re-show the form; hide again
      muteDialogs()  -- and a table script may have re-bound these
    end
    tableReady = true
    trace("ready")
  end
  loadTimer.Enabled = true
end
boot.Enabled = true
`;
}
