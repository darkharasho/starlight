export interface ControlScriptOpts {
  /** Base URL of the Electron main-process bridge, e.g. "http://127.0.0.1:47832". */
  bridgeUrl: string;
}

/**
 * Returns the Lua source that gets dropped into CE's `autorun/zzz-starlight.lua`.
 * On CE startup the script:
 *   1. Hides MainForm so CE never appears as a separate window.
 *   2. Loads the bundled `json` module (rxi's lua/json.lua) for safe JSON.
 *   3. Long-polls `<bridgeUrl>/poll` for commands and POSTs results to
 *      `<bridgeUrl>/result`.
 *
 * Supported commands (v1):
 *   - ping                 → { ok: true }
 *   - list_records         → { records: [{ id, name, isActive, isGroupHeader }, …] }
 *   - set_active(id, on)   → { ok: true } or { ok: false, error }
 */
export function generateControlScript(opts: ControlScriptOpts): string {
  // JSON.stringify gives us a valid Lua-compatible double-quoted string literal
  // (escapes \n, \", \\, etc.) for any URL the caller throws at us.
  const url = JSON.stringify(opts.bridgeUrl);
  return `\
-- Starlight CE control script. Auto-generated; do not edit by hand.
local BRIDGE_URL = ${url}
local TRACE_PATH = "/tmp/starlight-ce.log"

local json = require("json")

local function trace(msg)
  local f = io.open(TRACE_PATH, "a")
  if f then f:write(os.date("%H:%M:%S") .. " " .. tostring(msg) .. "\\n"); f:close() end
end

trace("autorun loaded")

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
    local r = findRecord(id)
    if not r then return { ok = false, error = "record not found" } end
    r.Active = active and true or false
    return { ok = true }
  end

  return { ok = false, error = "unknown method: " .. tostring(cmd.method) }
end

local boot = createTimer(nil, false)
boot.Interval = 200
boot.OnTimer = function()
  boot.Enabled = false
  trace("boot timer fired")

  pcall(function() getMainForm():hide() end)
  pcall(function() hideAllCEWindows() end)

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
