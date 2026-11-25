//! CE's Lua functions that do real work. Names are lowercase: the prelude looks API names up
//! case-insensitively.

use super::addr::Scope;
use super::Ctx;
use crate::{aob, mem};
use mlua::{Lua, MultiValue, Table, Value as LuaValue, Variadic};
use serde_json::json;
use std::time::{Duration, Instant};

/// At most this many matches from aobScan.
const MAX_AOB: usize = 1000;
/// Per run: notices kept, their length, and symbol changes (they live outside Lua's memory limit).
const MAX_NOTICES: usize = 20;
const MAX_NOTICE_CHARS: usize = 4096;
const MAX_EFFECTS: usize = 1000;

fn push_notice(ctx: &Ctx, kind: &str, text: String) {
    let mut c = ctx.lock().unwrap();
    if c.notices.len() > MAX_NOTICES {
        return;
    }
    if c.notices.len() == MAX_NOTICES {
        c.notices.push(json!({ "kind": "message", "text": "(more messages from this table were hidden)" }));
        return;
    }
    let text = if text.chars().count() > MAX_NOTICE_CHARS { text.chars().take(MAX_NOTICE_CHARS).collect::<String>() + "…" } else { text };
    c.notices.push(json!({ "kind": kind, "text": text }));
}

fn push_effect(c: &mut super::RunCtx, e: serde_json::Value) -> mlua::Result<()> {
    if c.effects.len() >= MAX_EFFECTS {
        return Err(mlua::Error::runtime("too many symbol changes in one run"));
    }
    c.effects.push(e);
    Ok(())
}
const MAX_STRING: usize = 4096;

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
            push_notice(&ctx, kind, text(&args));
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
            push_notice(&c, "message", msg);
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
                c.lock().unwrap().timed_out = true;
                return Err(super::guards::time_limit_error());
            }
            Ok(())
        })?,
    )?;
    let start = Instant::now();
    api.raw_set("gettickcount", lua.create_function(move |_, ()| Ok(start.elapsed().as_millis() as i64))?)?;
    memory(lua, api, &ctx)?;
    addresses(lua, api, &ctx)?;
    Ok(())
}

/// An address argument: a number, or text CE would resolve (`"game.exe+10"`, `"[pBase]+4"`).
fn address(ctx: &Ctx, v: &LuaValue) -> Result<u64, String> {
    match v {
        LuaValue::Integer(i) => Ok(*i as u64),
        LuaValue::Number(n) if n.fract() == 0.0 && *n >= 0.0 => Ok(*n as u64),
        LuaValue::String(s) => {
            let text = s.to_string_lossy();
            let c = ctx.lock().unwrap();
            let target = c.target.clone().ok_or("no process is opened")?;
            Scope { target: &target, symbols: &c.symbols, process: &c.process }.eval(&text)
        }
        other => Err(format!("{} isn't an address", other.type_name())),
    }
}

fn read_at(ctx: &Ctx, a: &LuaValue, n: usize) -> Option<Vec<u8>> {
    let addr = address(ctx, a).ok()?;
    let t = ctx.lock().unwrap().target.clone()?;
    mem::read_bytes(&t, addr, n).ok().filter(|b| b.len() == n)
}

fn write_at(ctx: &Ctx, a: &LuaValue, bytes: &[u8]) -> bool {
    let Ok(addr) = address(ctx, a) else { return false };
    let Some(t) = ctx.lock().unwrap().target.clone() else { return false };
    mem::write_bytes(&t, addr, bytes).is_ok()
}

fn int_of(v: &LuaValue) -> Option<i64> {
    match v {
        LuaValue::Integer(i) => Some(*i),
        LuaValue::Number(n) => Some(*n as i64),
        LuaValue::String(s) => s.to_str().ok().and_then(|t| t.trim().parse::<f64>().ok()).map(|f| f as i64),
        LuaValue::Boolean(b) => Some(*b as i64),
        _ => None,
    }
}

fn num_of(v: &LuaValue) -> Option<f64> {
    match v {
        LuaValue::Integer(i) => Some(*i as f64),
        LuaValue::Number(n) => Some(*n),
        LuaValue::String(s) => s.to_str().ok().and_then(|t| t.trim().parse::<f64>().ok()),
        _ => None,
    }
}

fn memory(lua: &Lua, api: &Table, ctx: &Ctx) -> mlua::Result<()> {
    // Integer reads: (name, size). `signed` as the second argument, CE-style.
    for (name, size) in [("readsmallinteger", 2usize), ("readinteger", 4), ("readqword", 8), ("readpointer", 8)] {
        let c = ctx.clone();
        api.raw_set(
            name,
            lua.create_function(move |_, (a, signed): (LuaValue, Option<bool>)| {
                let Some(b) = read_at(&c, &a, size) else { return Ok(None) };
                let mut buf = [0u8; 8];
                buf[..size].copy_from_slice(&b);
                let u = u64::from_le_bytes(buf);
                Ok(Some(match (size, signed.unwrap_or(false)) {
                    (2, true) => u as u16 as i16 as i64,
                    (4, true) => u as u32 as i32 as i64,
                    _ => u as i64,
                }))
            })?,
        )?;
    }
    for (name, size) in [("writesmallinteger", 2usize), ("writeinteger", 4), ("writeqword", 8), ("writepointer", 8)] {
        let c = ctx.clone();
        api.raw_set(
            name,
            lua.create_function(move |_, (a, v): (LuaValue, LuaValue)| {
                let Some(v) = int_of(&v) else { return Ok(false) };
                Ok(write_at(&c, &a, &v.to_le_bytes()[..size]))
            })?,
        )?;
    }
    let c = ctx.clone();
    api.raw_set(
        "readfloat",
        lua.create_function(move |_, a: LuaValue| Ok(read_at(&c, &a, 4).map(|b| f32::from_le_bytes(b.try_into().unwrap()) as f64)))?,
    )?;
    let c = ctx.clone();
    api.raw_set(
        "readdouble",
        lua.create_function(move |_, a: LuaValue| Ok(read_at(&c, &a, 8).map(|b| f64::from_le_bytes(b.try_into().unwrap()))))?,
    )?;
    let c = ctx.clone();
    api.raw_set(
        "writefloat",
        lua.create_function(move |_, (a, v): (LuaValue, LuaValue)| {
            Ok(num_of(&v).is_some_and(|v| write_at(&c, &a, &(v as f32).to_le_bytes())))
        })?,
    )?;
    let c = ctx.clone();
    api.raw_set(
        "writedouble",
        lua.create_function(move |_, (a, v): (LuaValue, LuaValue)| Ok(num_of(&v).is_some_and(|v| write_at(&c, &a, &v.to_le_bytes()))))?,
    )?;

    // readBytes(addr, count=1, asTable=false): the bytes as values, or one table.
    let c = ctx.clone();
    api.raw_set(
        "readbytes",
        lua.create_function(move |lua, (a, n, as_table): (LuaValue, Option<i64>, Option<bool>)| {
            let n = n.unwrap_or(1).clamp(0, MAX_STRING as i64) as usize;
            let Some(b) = read_at(&c, &a, n) else { return Ok(MultiValue::from_iter([LuaValue::Nil])) };
            if as_table.unwrap_or(false) {
                let t = lua.create_sequence_from(b.iter().map(|&x| x as i64))?;
                return Ok(MultiValue::from_iter([LuaValue::Table(t)]));
            }
            Ok(MultiValue::from_iter(b.iter().map(|&x| LuaValue::Integer(x as i64))))
        })?,
    )?;
    // writeBytes(addr, b1, b2, …) or writeBytes(addr, {b1, b2, …}).
    let c = ctx.clone();
    api.raw_set(
        "writebytes",
        lua.create_function(move |_, (a, rest): (LuaValue, Variadic<LuaValue>)| {
            let mut bytes = vec![];
            for v in rest.iter() {
                match v {
                    LuaValue::Table(t) => {
                        for x in t.clone().sequence_values::<LuaValue>() {
                            bytes.push(int_of(&x?).unwrap_or(0) as u8);
                        }
                    }
                    v => bytes.push(int_of(v).unwrap_or(0) as u8),
                }
            }
            Ok(!bytes.is_empty() && write_at(&c, &a, &bytes))
        })?,
    )?;
    // readString(addr, maxlen=4096, wide=false): up to the first NUL.
    let c = ctx.clone();
    api.raw_set(
        "readstring",
        lua.create_function(move |_, (a, max, wide): (LuaValue, Option<i64>, Option<bool>)| {
            let max = max.unwrap_or(MAX_STRING as i64).clamp(1, MAX_STRING as i64) as usize;
            let wide = wide.unwrap_or(false);
            let want = if wide { max * 2 } else { max };
            let Ok(addr) = address(&c, &a) else { return Ok(None) };
            let Some(t) = c.lock().unwrap().target.clone() else { return Ok(None) };
            // Read what is readable: a string near the end of a mapping is shorter than `want`.
            let mut b = None;
            let mut n = want;
            while n > 0 {
                if let Ok(x) = mem::read_bytes(&t, addr, n) {
                    b = Some(x);
                    break;
                }
                n /= 2;
            }
            let Some(b) = b else { return Ok(None) };
            Ok(Some(if wide {
                let u: Vec<u16> = b.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).take_while(|&c| c != 0).collect();
                String::from_utf16_lossy(&u)
            } else {
                let end = b.iter().position(|&x| x == 0).unwrap_or(b.len());
                String::from_utf8_lossy(&b[..end]).into_owned()
            }))
        })?,
    )?;
    let c = ctx.clone();
    api.raw_set(
        "writestring",
        lua.create_function(move |_, (a, s, wide): (LuaValue, mlua::LuaString, Option<bool>)| {
            let bytes: Vec<u8> = if wide.unwrap_or(false) {
                s.to_string_lossy().encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
            } else {
                s.as_bytes().to_vec()
            };
            Ok(!bytes.is_empty() && write_at(&c, &a, &bytes))
        })?,
    )?;
    Ok(())
}

/// CE patterns: spaced or not, with `?`, `??`, `*` or `x` wildcards.
fn pattern(text: &str) -> Result<aob::Pattern, String> {
    let t = text.trim().replace(['x', 'X', '*'], "?");
    let spaced = if t.contains(char::is_whitespace) {
        t.split_whitespace().map(|p| if p == "?" { "??".to_string() } else { p.to_string() }).collect::<Vec<_>>().join(" ")
    } else {
        t.as_bytes().chunks(2).map(|p| String::from_utf8_lossy(p).into_owned()).collect::<Vec<_>>().join(" ")
    };
    aob::Pattern::parse(&spaced).map_err(|e| e.message)
}

fn addresses(lua: &Lua, api: &Table, ctx: &Ctx) -> mlua::Result<()> {
    let c = ctx.clone();
    api.raw_set(
        "getaddress",
        lua.create_function(move |_, a: LuaValue| address(&c, &a).map(|v| v as i64).map_err(mlua::Error::runtime))?,
    )?;
    let c = ctx.clone();
    api.raw_set("getaddresssafe", lua.create_function(move |_, a: LuaValue| Ok(address(&c, &a).ok().map(|v| v as i64)))?)?;

    let c = ctx.clone();
    api.raw_set(
        "registersymbol",
        lua.create_function(move |_, (name, a): (String, LuaValue)| {
            let at = address(&c, &a).map_err(mlua::Error::runtime)?;
            let mut g = c.lock().unwrap();
            g.symbols.insert(name.to_lowercase(), at);
            push_effect(&mut g, json!({ "op": "registerSymbol", "name": name, "address": format!("{at:#x}") }))?;
            Ok(())
        })?,
    )?;
    let c = ctx.clone();
    api.raw_set(
        "unregistersymbol",
        lua.create_function(move |_, name: String| {
            let mut g = c.lock().unwrap();
            g.symbols.remove(&name.to_lowercase());
            push_effect(&mut g, json!({ "op": "unregisterSymbol", "name": name }))?;
            Ok(())
        })?,
    )?;
    let c = ctx.clone();
    api.raw_set(
        "getnamefromaddress",
        lua.create_function(move |_, a: LuaValue| {
            let at = address(&c, &a).map_err(mlua::Error::runtime)?;
            let g = c.lock().unwrap();
            let t = g.target.clone().ok_or_else(|| mlua::Error::runtime("no process is opened"))?;
            Ok(Scope { target: &t, symbols: &g.symbols, process: &g.process }.name_of(at))
        })?,
    )?;

    // openProcess(name or pid): the session is already attached; true when it is that game.
    let c = ctx.clone();
    api.raw_set(
        "openprocess",
        lua.create_function(move |_, p: LuaValue| {
            let g = c.lock().unwrap();
            let Some(t) = g.target.clone() else { return Ok(false) };
            Ok(match &p {
                LuaValue::Integer(pid) => *pid == t.pid as i64,
                LuaValue::String(s) => {
                    let want = s.to_string_lossy();
                    let comm = std::fs::read_to_string(format!("/proc/{}/comm", t.pid)).unwrap_or_default();
                    want.eq_ignore_ascii_case(&g.process) || want.eq_ignore_ascii_case(comm.trim())
                        // comm is cut to 15 characters
                        || (comm.trim().len() == 15 && want.to_lowercase().starts_with(&comm.trim().to_lowercase()))
                }
                _ => false,
            })
        })?,
    )?;
    let c = ctx.clone();
    api.raw_set(
        "getopenedprocessid",
        lua.create_function(move |_, ()| Ok(c.lock().unwrap().target.as_ref().map_or(0, |t| t.pid as i64)))?,
    )?;
    api.raw_set("targetis64bit", lua.create_function(|_, ()| Ok(true))?)?;

    // aobScan(pattern) / aobScanModule(module, pattern): a stringlist of hex addresses, or nil.
    let scan = |c: Ctx, module: bool| {
        move |lua: &Lua, args: Variadic<String>| -> mlua::Result<Vec<u64>> {
            let (m, p) = if module {
                (args.first().cloned(), args.get(1).cloned().unwrap_or_default())
            } else {
                (None, args.first().cloned().unwrap_or_default())
            };
            let _ = lua;
            let pat = pattern(&p).map_err(mlua::Error::runtime)?;
            let g = c.lock().unwrap();
            let t = g.target.clone().ok_or_else(|| mlua::Error::runtime("no process is opened"))?;
            let process = g.process.clone();
            drop(g);
            let found = match m {
                Some(m) => {
                    let m = if m.eq_ignore_ascii_case("$process") { process } else { m };
                    let range = aob::module_range(&t, &m).map_err(|e| mlua::Error::runtime(e.message))?;
                    aob::scan(&t, range, &pat, MAX_AOB)
                }
                None => aob::scan_exec(&t, &pat, MAX_AOB),
            };
            found.map_err(|e| mlua::Error::runtime(e.message))
        }
    };
    for (name, module) in [("aobscan", false), ("aobscanmodule", true)] {
        let f = scan(ctx.clone(), module);
        api.raw_set(
            name,
            lua.create_function(move |lua, args: Variadic<String>| {
                let found = f(lua, args)?;
                if found.is_empty() {
                    return Ok(LuaValue::Nil);
                }
                let list: mlua::Function = lua.globals().get("__stringlist")?;
                list.call::<LuaValue>(lua.create_sequence_from(found.iter().map(|a| format!("{a:X}")))?)
            })?,
        )?;
    }
    for (name, module) in [("aobscanunique", false), ("aobscanmoduleunique", true)] {
        let f = scan(ctx.clone(), module);
        api.raw_set(
            name,
            lua.create_function(move |lua, args: Variadic<String>| {
                let found = f(lua, args)?;
                Ok(if found.len() == 1 { Some(found[0] as i64) } else { None })
            })?,
        )?;
    }
    Ok(())
}
