//! Keeps a run inside its time budget where the instruction hook can't: `pcall`/`xpcall`
//! re-raise the time-limit error once a run is out of time, and the C library functions that
//! could otherwise loop for hours without running a Lua instruction get bounds (`string.rep`,
//! `table.move`, and the pattern functions on long subjects).

use super::{Ctx, RUN_LIMIT};
use mlua::{Function, Lua, MultiValue, Table, Value as LuaValue};

/// Largest string `string.rep` may build.
const MAX_REP_BYTES: i64 = 16 << 20;
/// Most repetitions, even of an empty string (Lua's loop runs once per repetition).
const MAX_REP_COUNT: i64 = 16 << 20;
/// Most elements one `table.move` may move.
const MAX_MOVE: i64 = 16 << 20;
/// ln of the most steps a pattern search may take in the worst case (about 1e10).
const MAX_PATTERN_LOG_COST: f64 = 23.03;

pub fn time_limit_error() -> mlua::Error {
    mlua::Error::runtime(format!("Lua time limit ({} s) exceeded", RUN_LIMIT.as_secs()))
}

/// Quantifiers (`*`, `+`, `-`) outside `%` escapes and `[...]` sets: each one can multiply the
/// backtracking work by the subject's length.
fn quantifiers(p: &[u8]) -> u32 {
    let (mut i, mut k) = (0, 0);
    while i < p.len() {
        match p[i] {
            b'%' => i += 1,
            b'[' => {
                i += 1;
                if p.get(i) == Some(&b'^') {
                    i += 1;
                }
                if p.get(i) == Some(&b']') {
                    i += 1;
                }
                while i < p.len() && p[i] != b']' {
                    if p[i] == b'%' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'*' | b'+' | b'-' => k += 1,
            _ => {}
        }
        i += 1;
    }
    k
}

/// True when searching `subject` for `pattern` could take far longer than a run may.
fn pattern_too_costly(subject_len: usize, pattern: &[u8]) -> bool {
    let k = quantifiers(pattern) as f64;
    (k + 1.0) * ((subject_len + 1) as f64).ln() > MAX_PATTERN_LOG_COST
}

fn bytes_of(v: Option<&LuaValue>) -> Option<Vec<u8>> {
    match v? {
        LuaValue::String(s) => Some(s.as_bytes().to_vec()),
        LuaValue::Integer(i) => Some(i.to_string().into_bytes()),
        LuaValue::Number(n) => Some(n.to_string().into_bytes()),
        _ => None,
    }
}

fn int_of(v: Option<&LuaValue>) -> Option<i64> {
    match v? {
        LuaValue::Integer(i) => Some(*i),
        LuaValue::Number(n) => Some(*n as i64),
        LuaValue::String(s) => s.to_str().ok()?.trim().parse::<f64>().ok().map(|f| f as i64),
        _ => None,
    }
}

pub fn install(lua: &Lua, ctx: Ctx) -> mlua::Result<()> {
    let g = lua.globals();
    for name in ["pcall", "xpcall"] {
        let orig: Function = g.get(name)?;
        let c = ctx.clone();
        g.raw_set(
            name,
            lua.create_function(move |_, args: MultiValue| {
                let r = orig.call::<MultiValue>(args)?;
                if c.lock().unwrap().timed_out {
                    return Err(time_limit_error());
                }
                Ok(r)
            })?,
        )?;
    }

    let string: Table = g.get("string")?;
    let rep: Function = string.get("rep")?;
    string.raw_set(
        "rep",
        lua.create_function(move |_, args: MultiValue| {
            let v: Vec<LuaValue> = args.iter().cloned().collect();
            let s = bytes_of(v.first()).map_or(0, |b| b.len() as i64);
            let n = int_of(v.get(1)).unwrap_or(0);
            let sep = bytes_of(v.get(2)).map_or(0, |b| b.len() as i64);
            if n > 0 {
                let total = (s.saturating_add(sep)).saturating_mul(n);
                if n > MAX_REP_COUNT || total > MAX_REP_BYTES {
                    return Err(mlua::Error::runtime("string.rep: result too large"));
                }
            }
            rep.call::<MultiValue>(args)
        })?,
    )?;
    for name in ["find", "match", "gmatch", "gsub"] {
        let orig: Function = string.get(name)?;
        let plain_at = if name == "find" { Some(3) } else { None };
        string.raw_set(
            name,
            lua.create_function(move |_, args: MultiValue| {
                let v: Vec<LuaValue> = args.iter().cloned().collect();
                let plain = plain_at.is_some_and(|i| matches!(v.get(i), Some(LuaValue::Boolean(true))));
                if let (false, Some(s), Some(p)) = (plain, bytes_of(v.first()), bytes_of(v.get(1))) {
                    if pattern_too_costly(s.len(), &p) {
                        return Err(mlua::Error::runtime(format!("string.{name}: pattern too complex for a {}-byte string", s.len())));
                    }
                }
                orig.call::<MultiValue>(args)
            })?,
        )?;
    }

    let table: Table = g.get("table")?;
    let mv: Function = table.get("move")?;
    table.raw_set(
        "move",
        lua.create_function(move |_, args: MultiValue| {
            let v: Vec<LuaValue> = args.iter().cloned().collect();
            if let (Some(f), Some(e)) = (int_of(v.get(1)), int_of(v.get(2))) {
                if e >= f && e.saturating_sub(f) > MAX_MOVE {
                    return Err(mlua::Error::runtime("table.move: too many elements"));
                }
            }
            mv.call::<MultiValue>(args)
        })?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_quantifiers_outside_sets() {
        assert_eq!(quantifiers(b"%d+"), 1);
        assert_eq!(quantifiers(b"[a-z]+"), 1);
        assert_eq!(quantifiers(b"%-%+"), 0);
        assert_eq!(quantifiers(b".-.-.-.-.-.-.-b"), 7);
        assert_eq!(quantifiers(b"[^]-]*x"), 1);
    }

    #[test]
    fn costs() {
        assert!(!pattern_too_costly(4096, b"[a-z]+"));
        assert!(!pattern_too_costly(100, b"(%w+)=(%w+)"));
        assert!(pattern_too_costly(20000, b".-.-.-.-.-.-.-b"));
    }
}
