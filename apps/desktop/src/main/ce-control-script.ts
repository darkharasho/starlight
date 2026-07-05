export interface ControlScriptOpts {
  /** Base URL of the Electron main-process bridge, e.g. "http://127.0.0.1:47832". */
  bridgeUrl: string;
  /**
   * Windows/Linux process name (e.g. "9Kings.exe") to open on boot so cheats
   * have a target. When omitted, no process is opened automatically and the
   * host can send an `attach` command later.
   */
  openProcessName?: string | undefined;
  /**
   * CE-openable path to the .CT to load (Linux path for native CE, `Z:\…` Wine
   * path for Windows CE). Loaded by the script AFTER dialogs are muted, so a
   * community table can't pop a window. When omitted, no table is loaded here.
   */
  ctPath?: string | undefined;
}

/**
 * Returns the Lua source that gets dropped into CE's `autorun/zzz-starlight.lua`.
 * On CE startup the script:
 *   1. Hides MainForm so CE never appears as a separate window.
 *   2. Loads the bundled `json` module (rxi's lua/json.lua) for safe JSON.
 *   3. Optionally opens the target process so cheats have something to act on.
 *   4. Long-polls `<bridgeUrl>/poll` for commands and POSTs results to
 *      `<bridgeUrl>/result`.
 *
 * Supported commands (v1):
 *   - ping                 → { ok: true }
 *   - status               → { attached: bool, pid: number }
 *   - attach(name)         → { ok: bool, pid: number, error? }
 *   - list_records         → { records: [{ id, name, isActive, isGroupHeader }, …] }
 *   - set_active(id, on)   → { ok: bool, active: bool, error? }  (verifies the
 *                            enable actually stuck — CE reverts Active on failure)
 */
export function generateControlScript(opts: ControlScriptOpts): string {
  // JSON.stringify gives us a valid Lua-compatible double-quoted string literal
  // (escapes \n, \", \\, etc.) for any string the caller throws at us.
  const url = JSON.stringify(opts.bridgeUrl);
  const openName = opts.openProcessName ? JSON.stringify(opts.openProcessName) : 'nil';
  const ctPath = opts.ctPath ? JSON.stringify(opts.ctPath) : 'nil';
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
local CT_PATH = ${ctPath}
local TRACE_PATH = "/tmp/starlight-ce.log"

local json = require("json")

local function trace(msg)
  local f = io.open(TRACE_PATH, "a")
  if f then f:write(os.date("%H:%M:%S") .. " " .. tostring(msg) .. "\\n"); f:close() end
end

trace("autorun loaded")

local attachedPid = 0

local function attachTo(name)
  if not name then return false, 0 end
  local ok = pcall(function() openProcess(name) end)
  local pid = getOpenedProcessID and getOpenedProcessID() or 0
  attachedPid = pid
  trace("attach '" .. tostring(name) .. "' ok=" .. tostring(ok) .. " pid=" .. tostring(pid))
  return ok and pid ~= 0, pid
end

local function findRecord(id)
  local al = getAddressList()
  if not al then return nil end
  for idx = 0, al.Count - 1 do
    local r = al:getMemoryRecord(idx)
    if r and (r.ID or idx) == id then return r end
  end
  return nil
end

local function dispatch(cmd)
  if cmd.method == "ping" then
    return { ok = true }
  end

  if cmd.method == "status" then
    return { attached = attachedPid ~= 0, pid = attachedPid }
  end

  if cmd.method == "attach" then
    local name = cmd.params and cmd.params.name
    if name == nil then return { ok = false, error = "missing name" } end
    local ok, pid = attachTo(name)
    if ok then return { ok = true, pid = pid } end
    return { ok = false, pid = pid, error = "could not open process '" .. tostring(name) .. "'" }
  end

  if cmd.method == "list_records" then
    local al = getAddressList()
    local out = {}
    if al then
      for idx = 0, al.Count - 1 do
        local r = al:getMemoryRecord(idx)
        if r then
          out[#out + 1] = {
            id = r.ID or idx,
            name = r.Description or "",
            isActive = r.Active or false,
            isGroupHeader = r.IsGroupHeader or false,
          }
        end
      end
    end
    return { records = out }
  end

  if cmd.method == "set_active" then
    local id = cmd.params and cmd.params.id
    local active = cmd.params and cmd.params.active
    if id == nil then return { ok = false, error = "missing id" } end
    if active and attachedPid == 0 then
      return { ok = false, active = false, error = "not attached to a game process" }
    end
    local r = findRecord(id)
    if not r then return { ok = false, error = "record not found" } end
    local want = active and true or false
    r.Active = want
    -- CE reverts Active to false when an Auto Assembler enable fails (e.g. the
    -- AOB signature no longer matches the game version). Read it back so the UI
    -- reflects reality instead of an optimistic guess.
    local got = r.Active and true or false
    if got ~= want then
      return { ok = false, active = got, error = "cheat did not " .. (want and "enable" or "disable") .. " (AOB/version mismatch?)" }
    end
    return { ok = true, active = got }
  end

  return { ok = false, error = "unknown method: " .. tostring(cmd.method) }
end

local boot = createTimer(nil, false)
boot.Interval = 50
boot.OnTimer = function()
  boot.Enabled = false
  trace("boot timer fired")

  hideCE()
  muteDialogs()

  if OPEN_PROCESS_NAME then attachTo(OPEN_PROCESS_NAME) end

  -- Load the table ourselves (dialogs already muted) instead of via argv, so a
  -- table's embedded LuaScript can't pop a window before we suppress it.
  if CT_PATH then
    local ok, err = pcall(function() loadTable(CT_PATH, false) end)
    trace("loadTable ok=" .. tostring(ok) .. " err=" .. tostring(err))
    hideCE()  -- a table load can re-show the form; hide again
  end

  local internet = getInternet("starlight")
  if not internet then trace("no internet client"); return end

  local poll = createTimer(nil, false)
  poll.Interval = 250
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
  trace("poll loop running")
end
boot.Enabled = true
`;
}
