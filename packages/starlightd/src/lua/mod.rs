//! Sandboxed Lua 5.3 states that run Cheat Engine table Lua against an attached game.
//!
//! One state per `lua_open`, kept until `lua_close` or the connection ends; a table's
//! script, its records' scripts and its `{$lua}` blocks all share it, as in CE. A run gets
//! the table's symbols (name → address) and returns what Lua asked the app to do (effects)
//! and what it wanted to show the player (notices).
//!
//! Sandbox: `base` (no `dofile`/`loadfile`; `load` text-only), `string`, `table`, `math`,
//! `utf8`, and `os.clock`/`time`/`date`. No `io`, `package`/`require` or `debug`. Every run
//! stops after [`RUN_LIMIT`]; a state can use at most [`MEMORY_LIMIT`].

mod addr;
mod api;

use crate::process::Target;
use crate::rpc::RpcError;
use mlua::{HookTriggers, Lua, LuaOptions, MultiValue, StdLib, Value as LuaValue, VmState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const RUN_LIMIT: Duration = Duration::from_secs(2);
pub const MEMORY_LIMIT: usize = 64 << 20;
const API_JSON: &str = include_str!("../../../ct-importer/src/lua-api.json");
const PRELUDE: &str = include_str!("prelude.lua");

/// What one run may touch and what it produced.
pub struct RunCtx {
    pub target: Option<Arc<Target>>,
    /// Lowercased name → address; registerSymbol in the run updates it too.
    pub symbols: HashMap<String, u64>,
    pub effects: Vec<Value>,
    pub notices: Vec<Value>,
    pub deadline: Instant,
    /// The game's executable name (CE's `process`).
    pub process: String,
}

impl RunCtx {
    fn idle(process: String) -> Self {
        RunCtx { target: None, symbols: HashMap::new(), effects: vec![], notices: vec![], deadline: Instant::now(), process }
    }
    pub fn time_left(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

pub type Ctx = Arc<Mutex<RunCtx>>;

pub struct LuaState {
    handle: u32,
    lua: Mutex<Lua>,
    ctx: Ctx,
}

#[derive(Default)]
pub struct Luas {
    inner: Mutex<(u32, HashMap<u32, Arc<LuaState>>)>,
}

fn lua_err(e: mlua::Error) -> RpcError {
    RpcError::internal_error(format!("lua: {e}"))
}

/// The names CE's API lists (lowercase), from the list the router shares.
fn api_names() -> (Vec<String>, Vec<String>) {
    let v: Value = serde_json::from_str(API_JSON).expect("lua-api.json is valid JSON");
    let list = |k: &str| v[k].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
    (list("real"), list("inert"))
}

fn new_state(ctx: Ctx) -> mlua::Result<Lua> {
    let lua = Lua::new_with(StdLib::STRING | StdLib::TABLE | StdLib::MATH | StdLib::UTF8 | StdLib::OS, LuaOptions::default())?;
    lua.set_memory_limit(MEMORY_LIMIT)?;
    let g = lua.globals();
    for name in ["dofile", "loadfile", "loadstring", "require", "module"] {
        g.raw_set(name, LuaValue::Nil)?;
    }
    // os: only the clock.
    let os = lua.create_table()?;
    let real_os: mlua::Table = g.get("os")?;
    for name in ["clock", "time", "date"] {
        os.raw_set(name, real_os.get::<LuaValue>(name)?)?;
    }
    g.raw_set("os", os)?;
    // load: text chunks only.
    let load: mlua::Function = g.get("load")?;
    g.raw_set(
        "load",
        lua.create_function(move |_, (chunk, name, _mode, env): (LuaValue, LuaValue, LuaValue, LuaValue)| {
            load.call::<MultiValue>((chunk, name, "t", env))
        })?,
    )?;

    let api = lua.create_table()?;
    api::register(&lua, &api, ctx.clone())?;
    let (_, inert) = api_names();
    api.raw_set("__inert_names", lua.create_sequence_from(inert)?)?;
    g.raw_set("__api", api)?;
    lua.load(PRELUDE).set_name("prelude").exec()?;

    let hook_ctx = ctx;
    lua.set_hook(HookTriggers::new().every_nth_instruction(1000), move |_, _| {
        if Instant::now() >= hook_ctx.lock().unwrap().deadline {
            Err(mlua::Error::runtime(format!("Lua time limit ({} s) exceeded", RUN_LIMIT.as_secs())))
        } else {
            Ok(VmState::Continue)
        }
    })?;
    Ok(lua)
}

/// `"[string \"name\"]:3: boom"` → (`"boom"`, Some(3)); the first line of mlua's message only.
fn split_error(e: &mlua::Error) -> (String, Option<u64>) {
    let text = e.to_string();
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let first = first.strip_prefix("runtime error: ").unwrap_or(first);
    let first = first.strip_prefix("syntax error: ").unwrap_or(first);
    if let Some(close) = first.find("]:") {
        let rest = &first[close + 2..];
        if let Some((n, msg)) = rest.split_once(':') {
            if let Ok(line) = n.trim().parse::<u64>() {
                return (msg.trim().to_string(), Some(line));
            }
        }
    }
    (first.to_string(), None)
}

impl Luas {
    pub fn open(&self, handle: u32, target: Arc<Target>, process: Option<String>) -> Result<u32, RpcError> {
        let process = process.unwrap_or_else(|| {
            std::fs::read_to_string(format!("/proc/{}/comm", target.pid)).map(|s| s.trim().to_string()).unwrap_or_default()
        });
        let ctx: Ctx = Arc::new(Mutex::new(RunCtx::idle(process)));
        let lua = new_state(ctx.clone()).map_err(lua_err)?;
        let mut g = self.inner.lock().unwrap();
        g.0 += 1;
        let id = g.0;
        g.1.insert(id, Arc::new(LuaState { handle, lua: Mutex::new(lua), ctx }));
        Ok(id)
    }

    pub fn close(&self, id: u32) -> Result<(), RpcError> {
        self.inner.lock().unwrap().1.remove(&id).map(|_| ()).ok_or_else(|| RpcError::unknown_id(format!("no Lua state {id}")))
    }

    /// The state's session handle, so the caller can look its target up.
    pub fn handle_of(&self, id: u32) -> Result<u32, RpcError> {
        self.get(id).map(|s| s.handle)
    }

    fn get(&self, id: u32) -> Result<Arc<LuaState>, RpcError> {
        self.inner.lock().unwrap().1.get(&id).cloned().ok_or_else(|| RpcError::unknown_id(format!("no Lua state {id}")))
    }

    pub fn run(&self, id: u32, target: Arc<Target>, req: &Value) -> Result<Value, RpcError> {
        let state = self.get(id)?;
        let chunk = req.get("chunk").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("chunk must be a string"))?;
        let name = req.get("name").and_then(Value::as_str).unwrap_or("chunk");
        let syntaxcheck = req.get("syntaxcheck").and_then(Value::as_bool).unwrap_or(false);
        let mut symbols = HashMap::new();
        if let Some(m) = req.get("symbols").and_then(Value::as_object) {
            for (k, v) in m {
                let a = v.as_str().and_then(|s| s.strip_prefix("0x")).and_then(|h| u64::from_str_radix(h, 16).ok());
                let a = a.ok_or_else(|| RpcError::invalid_params(format!("symbol {k} must be a 0x address")))?;
                symbols.insert(k.to_lowercase(), a);
            }
        }

        let lua = state.lua.lock().unwrap();
        let process = {
            let mut c = state.ctx.lock().unwrap();
            c.target = Some(target);
            c.symbols = symbols;
            c.effects.clear();
            c.notices.clear();
            c.deadline = Instant::now() + RUN_LIMIT;
            c.process.clone()
        };
        let result = (|| -> mlua::Result<MultiValue> {
            let g = lua.globals();
            g.raw_set("syntaxcheck", syntaxcheck)?;
            g.raw_set("process", process)?;
            g.raw_set("memrec", memrec(&lua, req.get("memrec"))?)?;
            lua.load(chunk).set_name(name).call::<MultiValue>(())
        })();
        let (effects, notices) = {
            let mut c = state.ctx.lock().unwrap();
            c.target = None;
            (std::mem::take(&mut c.effects), std::mem::take(&mut c.notices))
        };
        Ok(match result {
            Ok(values) => {
                let returned = match values.into_iter().next() {
                    Some(LuaValue::String(s)) => Value::String(s.to_string_lossy()),
                    _ => Value::Null,
                };
                json!({ "ok": true, "returned": returned, "effects": effects, "notices": notices })
            }
            Err(e) => {
                let (error, line) = split_error(&e);
                json!({ "ok": false, "error": error, "line": line, "effects": effects, "notices": notices })
            }
        })
    }
}

/// CE's `memrec` for a record's chunk: ID, Description and Value; anything else is inert.
fn memrec(lua: &Lua, m: Option<&Value>) -> mlua::Result<LuaValue> {
    let Some(m) = m.filter(|m| m.is_object()) else { return Ok(LuaValue::Nil) };
    let t = lua.create_table()?;
    t.raw_set("ID", m.get("id").and_then(Value::as_i64).unwrap_or(0))?;
    t.raw_set("Description", m.get("description").and_then(Value::as_str).unwrap_or(""))?;
    t.raw_set("Value", m.get("value").and_then(Value::as_str).unwrap_or(""))?;
    let inert: mlua::Function = lua.load("return getmetatable(_G).__index(nil, '__inert')").eval()?;
    let mt = lua.create_table()?;
    mt.raw_set("__index", lua.create_function(move |_, ()| inert.call::<LuaValue>(()))?)?;
    mt.raw_set("__newindex", lua.create_function(|_, ()| Ok(()))?)?;
    t.set_metatable(Some(mt))?;
    Ok(LuaValue::Table(t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_error_finds_the_line() {
        let lua = Lua::new();
        let e = lua.load("\n\nerror('boom')").set_name("t").exec().unwrap_err();
        assert_eq!(split_error(&e), ("boom".to_string(), Some(3)));
    }

    #[test]
    fn api_list_parses() {
        let (real, inert) = api_names();
        assert!(real.contains(&"readinteger".to_string()));
        assert!(inert.contains(&"getmainform".to_string()));
    }
}
