//! CE address expressions for Lua's `getAddress` and every address argument given as text.
//!
//! Terms joined by `+`/`-`: hex numbers (`10`, `0x10`), `#decimal`, `[expr]` (reads an
//! 8-byte pointer), quoted or bare module names, `$process` (the main module) and table
//! symbols. A bare name is a symbol first, then a module, then a hex number; all
//! case-insensitive, as in the engine's `resolveExpr`.

use crate::mem;
use crate::modules::{self, Module};
use crate::process::Target;
use std::collections::HashMap;

pub struct Scope<'a> {
    pub target: &'a Target,
    pub symbols: &'a HashMap<String, u64>,
    pub process: &'a str,
}

/// Splits on top-level `+`/`-` (outside brackets and quotes). The first term may be negative.
fn terms(expr: &str) -> Result<Vec<(bool, &str)>, String> {
    let bad = || format!("can't read the address {expr}");
    let mut out = vec![];
    let (mut depth, mut quote, mut start, mut neg) = (0i32, false, 0usize, false);
    let b = expr.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'"' => quote = !quote,
            b'[' if !quote => depth += 1,
            b']' if !quote => depth -= 1,
            b'+' | b'-' if !quote && depth == 0 => {
                let t = expr[start..i].trim();
                if t.is_empty() {
                    if !out.is_empty() || i != 0 && !expr[..i].trim().is_empty() {
                        return Err(bad());
                    }
                } else {
                    out.push((neg, t));
                }
                neg = c == b'-';
                start = i + 1;
            }
            _ => {}
        }
        if depth < 0 {
            return Err(bad());
        }
    }
    let t = expr[start..].trim();
    if t.is_empty() || depth != 0 || quote {
        return Err(bad());
    }
    out.push((neg, t));
    Ok(out)
}

fn hex(t: &str) -> Option<u64> {
    let d = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    if d.is_empty() || d.len() > 16 || !d.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(d, 16).ok()
}

impl Scope<'_> {
    fn modules(&self, cache: &mut Option<Vec<Module>>) -> Result<(), String> {
        if cache.is_none() {
            *cache = Some(modules::list(self.target).map_err(|e| e.message)?);
        }
        Ok(())
    }

    fn module_base(&self, name: &str, cache: &mut Option<Vec<Module>>) -> Result<Option<u64>, String> {
        self.modules(cache)?;
        let list = cache.as_ref().unwrap();
        let name = if name.eq_ignore_ascii_case("$process") { self.process } else { name };
        Ok(modules::find(list, name).map(|m| m.base))
    }

    fn term(&self, t: &str, cache: &mut Option<Vec<Module>>, depth: u32) -> Result<u64, String> {
        if depth > 16 {
            return Err("address nests too deeply".into());
        }
        if let Some(inner) = t.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
            let a = self.eval_in(inner, cache, depth + 1)?;
            let b = mem::read_bytes(self.target, a, 8).map_err(|_| format!("can't read the pointer at {a:#x}"))?;
            return Ok(u64::from_le_bytes(b.try_into().unwrap()));
        }
        if let Some(q) = t.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
            return self.module_base(q, cache)?.ok_or_else(|| format!("module {q} isn't loaded"));
        }
        if let Some(d) = t.strip_prefix('#') {
            return d.parse::<u64>().map_err(|_| format!("bad number {t}"));
        }
        if t.starts_with("0x") || t.starts_with("0X") || t.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            if let Some(v) = hex(t) {
                return Ok(v);
            }
        }
        if let Some(&v) = self.symbols.get(&t.to_lowercase()) {
            return Ok(v);
        }
        if let Some(base) = self.module_base(t, cache)? {
            return Ok(base);
        }
        hex(t).ok_or_else(|| format!("symbol {t} isn't registered"))
    }

    fn eval_in(&self, expr: &str, cache: &mut Option<Vec<Module>>, depth: u32) -> Result<u64, String> {
        let mut total: u64 = 0;
        for (neg, t) in terms(expr)? {
            let v = self.term(t, cache, depth)?;
            total = if neg { total.wrapping_sub(v) } else { total.wrapping_add(v) };
        }
        Ok(total)
    }

    pub fn eval(&self, expr: &str) -> Result<u64, String> {
        self.eval_in(expr, &mut None, 0)
    }

    /// `module+offset` for an address inside a module (CE's getNameFromAddress), a symbol at
    /// exactly that address, or plain hex.
    pub fn name_of(&self, a: u64) -> String {
        if let Some((k, _)) = self.symbols.iter().find(|(_, &v)| v == a) {
            return k.clone();
        }
        if let Ok(list) = modules::list(self.target) {
            if let Some(m) = list.iter().find(|m| a >= m.base && a < m.base + m.size) {
                return format!("{}+{:X}", m.name, a - m.base);
            }
        }
        format!("{a:X}")
    }
}

#[cfg(test)]
mod tests {
    use super::terms;

    #[test]
    fn splits_terms() {
        assert_eq!(terms("a+10-0x4").unwrap(), vec![(false, "a"), (false, "10"), (true, "0x4")]);
        assert_eq!(terms("[[pBase]+18]+4").unwrap(), vec![(false, "[[pBase]+18]"), (false, "4")]);
        assert_eq!(terms("\"My-Game.exe\"+10").unwrap(), vec![(false, "\"My-Game.exe\""), (false, "10")]);
        assert_eq!(terms("-8").unwrap(), vec![(true, "8")]);
        assert!(terms("a+").is_err());
        assert!(terms("[a").is_err());
        assert!(terms("a++b").is_err());
    }
}
