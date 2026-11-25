//! CE's Lua functions that do real work. Names are lowercase: the prelude looks API names up
//! case-insensitively.

use super::Ctx;
use mlua::{Lua, MultiValue, Table, Value as LuaValue, Variadic};
use serde_json::json;
use std::time::{Duration, Instant};

fn text(args: &MultiValue) -> String {
    args.iter()
        .map(|v| match v {
            LuaValue::String(s) => s.to_string_lossy(),
            LuaValue::Nil => "nil".into(),
            LuaValue::Boolean(b) => b.to_string(),
            LuaValue::Integer(i) => i.to_string(),
            LuaValue::Number(n) => n.to_string(),
            other => format!("{}", other.type_name()),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn register(lua: &Lua, api: &Table, ctx: Ctx) -> mlua::Result<()> {
    let notice = |kind: &'static str| {
        let ctx = ctx.clone();
        move |_: &Lua, args: MultiValue| {
            ctx.lock().unwrap().notices.push(json!({ "kind": kind, "text": text(&args) }));
            Ok(())
        }
    };
    api.raw_set("showmessage", lua.create_function(notice("message"))?)?;
    api.raw_set("shellexecute", lua.create_function(notice("link"))?)?;
    // print is Lua's own name: replace the global, so a table may still redefine it.
    lua.globals().raw_set("print", lua.create_function(notice("message"))?)?;

    // messageDialog(text, type, buttons…): a notice; answers yes when yes is offered, else OK.
    let c = ctx.clone();
    api.raw_set(
        "messagedialog",
        lua.create_function(move |_, args: Variadic<LuaValue>| {
            let msg = args.first().map(|v| text(&MultiValue::from_iter([v.clone()]))).unwrap_or_default();
            c.lock().unwrap().notices.push(json!({ "kind": "message", "text": msg }));
            // mbYes = 0 among the button arguments (after text and type).
            let yes = args.iter().skip(2).any(|v| matches!(v, LuaValue::Integer(0)) || matches!(v, LuaValue::Number(n) if *n == 0.0));
            Ok(if yes { 6 } else { 1 })
        })?,
    )?;

    // sleep(ms) counts against the run's time limit.
    let c = ctx.clone();
    api.raw_set(
        "sleep",
        lua.create_function(move |_, ms: f64| {
            let left = c.lock().unwrap().time_left();
            let want = Duration::from_millis(ms.max(0.0) as u64);
            std::thread::sleep(want.min(left));
            if want > left {
                return Err(mlua::Error::runtime(format!("Lua time limit ({} s) exceeded", super::RUN_LIMIT.as_secs())));
            }
            Ok(())
        })?,
    )?;
    let start = Instant::now();
    api.raw_set("gettickcount", lua.create_function(move |_, ()| Ok(start.elapsed().as_millis() as i64))?)?;
    Ok(())
}
