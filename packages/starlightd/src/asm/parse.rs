//! CE-style assembly text → statements (see the module doc in `asm` for the accepted syntax).
use crate::arch::Bits;
use super::AsmError;
use iced_x86::Register;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// A value: a number, or a symbol/label plus an offset, resolved at encode time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    Num(i128),
    Sym { name: String, addend: i64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemSize {
    Byte,
    Word,
    Dword,
    Qword,
    /// 80-bit x87 extended precision.
    Tword,
    Xmmword,
}

impl MemSize {
    pub fn bytes(self) -> usize {
        match self {
            MemSize::Byte => 1,
            MemSize::Word => 2,
            MemSize::Dword => 4,
            MemSize::Qword => 8,
            MemSize::Tword => 10,
            MemSize::Xmmword => 16,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operand {
    Reg(Register),
    /// An immediate, or a branch target.
    Imm(Expr),
    Mem {
        size: Option<MemSize>,
        seg: Option<Register>,
        base: Option<Register>,
        index: Option<Register>,
        /// 1, 2, 4 or 8 (1 when there's no index).
        scale: u8,
        disp: Expr,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prefix {
    Lock,
    Rep,
    Repe,
    Repne,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataItem {
    Value(Expr),
    /// Literal bytes: a string, or a `(float)`/`(double)` value.
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    Label(String),
    /// `mnemonic` is lowercase with aliases already mapped to iced's names (`jz` → `je`).
    Insn { prefixes: Vec<Prefix>, mnemonic: String, operands: Vec<Operand> },
    /// `width` is 1, 2, 4 or 8.
    Data { width: u8, items: Vec<DataItem> },
    /// `align N [fill]`: `fill` bytes up to the next multiple of `n`.
    Align { n: u64, fill: u8 },
}

/// One statement and the 1-based source line it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stmt {
    pub line: usize,
    pub kind: Line,
}

/// Parse `source`. `is_symbol` tells whether a name is a supplied symbol, which decides whether a
/// hex-looking identifier like `ab` is a number or a symbol (D2).
pub fn parse(source: &str, is_symbol: &dyn Fn(&str) -> bool, bits: Bits) -> Result<Vec<Stmt>, AsmError> {
    let lines = anonymous_labels(strip_comments(source)?)?;
    let labels = defined_labels(&lines);
    let p = Parser { labels: &labels, is_symbol, bits };
    let mut out = vec![];
    for (i, text) in lines.iter().enumerate() {
        let line = i + 1;
        p.statement(text.trim(), line, &mut out).map_err(|m| AsmError::new(line, m))?;
    }
    Ok(out)
}

/// Blank out `//`, `;` and `{ … }` comments, keeping line numbers. Quotes protect their content.
fn strip_comments(source: &str) -> Result<Vec<String>, AsmError> {
    let mut lines = vec![String::new()];
    let mut block_start = None;
    let mut chars = source.chars().peekable();
    let mut quote = None;
    let mut line_comment = false;
    while let Some(c) = chars.next() {
        if c == '\n' {
            if quote.is_some() {
                return Err(AsmError::new(lines.len(), "unterminated string"));
            }
            line_comment = false;
            lines.push(String::new());
            continue;
        }
        let cur = lines.last_mut().unwrap();
        if line_comment {
            continue;
        }
        if block_start.is_some() {
            if c == '}' {
                block_start = None;
                cur.push(' ');
            }
            continue;
        }
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                cur.push(c);
            }
            ';' => line_comment = true,
            '/' if chars.peek() == Some(&'/') => line_comment = true,
            '{' => block_start = Some(lines.len()),
            _ => cur.push(c),
        }
    }
    if let Some(line) = block_start {
        return Err(AsmError::new(line, "unterminated { comment"));
    }
    if quote.is_some() {
        return Err(AsmError::new(lines.len(), "unterminated string"));
    }
    Ok(lines)
}

/// CE's anonymous labels: each `@@:` gets a unique name; `@f` names the next label of any kind
/// after the current line and `@b` the closest one before it (or on it).
fn anonymous_labels(mut lines: Vec<String>) -> Result<Vec<String>, AsmError> {
    let mut anon = 0;
    let mut defs: Vec<(usize, String)> = vec![];
    for (i, line) in lines.iter_mut().enumerate() {
        let Some((n, _)) = split_label(line.trim()) else { continue };
        let n = n.to_string();
        if n == "@@" {
            let name = format!("__anon{anon}");
            anon += 1;
            let t = line.trim_start();
            *line = format!("{name}{}", &t[2..]);
            defs.push((i, name));
        } else {
            defs.push((i, n));
        }
    }
    for (i, line) in lines.iter_mut().enumerate() {
        if !line.contains('@') {
            continue;
        }
        let mut out = String::with_capacity(line.len());
        let mut rest = line.as_str();
        while let Some(at) = rest.find('@') {
            let (before, tail) = rest.split_at(at);
            out.push_str(before);
            let word_end = tail[1..].find(|c: char| !is_ident_char(c)).map_or(tail.len(), |e| e + 1);
            let word = &tail[..word_end];
            let free = !before.ends_with(is_ident_char);
            let target = match word.to_ascii_lowercase().as_str() {
                "@f" if free => Some(
                    defs.iter().find(|(l, _)| *l > i).ok_or_else(|| AsmError::new(i + 1, "@f without a later label"))?,
                ),
                "@b" if free => Some(
                    defs.iter().rev().find(|(l, _)| *l <= i).ok_or_else(|| AsmError::new(i + 1, "@b without an earlier label"))?,
                ),
                _ => None,
            };
            out.push_str(target.map_or(word, |(_, n)| n.as_str()));
            rest = &tail[word_end..];
        }
        out.push_str(rest);
        *line = out;
    }
    Ok(lines)
}

/// Lowercased names of every `label:` in the source, so operands can tell labels from numbers.
fn defined_labels(lines: &[String]) -> HashSet<String> {
    lines.iter().filter_map(|l| split_label(l.trim()).map(|(name, _)| name.to_ascii_lowercase())).collect()
}

/// `name: rest` → (`name`, `rest`) when the statement starts with a label definition.
fn split_label(s: &str) -> Option<(&str, &str)> {
    let end = s.find(|c: char| !is_ident_char(c)).unwrap_or(s.len());
    if end == 0 {
        return None;
    }
    let rest = s[end..].trim_start().strip_prefix(':')?;
    let name = &s[..end];
    // `fs:[0]`-style operands never start a statement, but don't mistake a lone segment for a label.
    if register(name).is_some() {
        return None;
    }
    Some((name, rest))
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '$' | '#')
}

struct Parser<'a> {
    labels: &'a HashSet<String>,
    is_symbol: &'a dyn Fn(&str) -> bool,
    bits: Bits,
}

type PResult<T> = Result<T, String>;

impl Parser<'_> {
    /// `r`, unless it only exists in 64-bit code and this is 32-bit code.
    fn exists(&self, r: Register, text: &str) -> PResult<Register> {
        if self.bits == Bits::B32 && only_in_64_bit(r) {
            return Err(format!("{} doesn't exist in 32-bit code", text.trim().to_ascii_lowercase()));
        }
        Ok(r)
    }

    /// A base or index register: 64-bit in 64-bit code, 32-bit in 32-bit code.
    fn address_reg(&self, r: Register, text: &str) -> PResult<Register> {
        let r = self.exists(r, text)?;
        match self.bits {
            Bits::B64 => gpr64(r, text),
            Bits::B32 if r.is_gpr32() => Ok(r),
            Bits::B32 => Err(format!("{text} is not a 32-bit address register")),
        }
    }

    fn statement(&self, mut s: &str, line: usize, out: &mut Vec<Stmt>) -> PResult<()> {
        if let Some((name, rest)) = split_label(s) {
            out.push(Stmt { line, kind: Line::Label(name.to_string()) });
            s = rest.trim();
        }
        if s.is_empty() {
            return Ok(());
        }
        let mut prefixes = vec![];
        loop {
            let (word, rest) = split_word(s);
            let lower = word.to_ascii_lowercase();
            let p = match lower.as_str() {
                "lock" => Prefix::Lock,
                "rep" => Prefix::Rep,
                "repe" | "repz" => Prefix::Repe,
                "repne" | "repnz" => Prefix::Repne,
                _ => break,
            };
            prefixes.push(p);
            s = rest;
        }
        let (word, rest) = split_word(s);
        let lower = word.to_ascii_lowercase();
        let width = match lower.as_str() {
            "db" => Some(1),
            "dw" => Some(2),
            "dd" => Some(4),
            "dq" => Some(8),
            _ => None,
        };
        if let Some(width) = width {
            if !prefixes.is_empty() {
                return Err("prefix before data".into());
            }
            let items = self.data_items(rest, width)?;
            out.push(Stmt { line, kind: Line::Data { width, items } });
            return Ok(());
        }
        if lower == "align" {
            if !prefixes.is_empty() {
                return Err("prefix before align".into());
            }
            let mut args = rest.split([' ', '\t', ',']).filter(|a| !a.is_empty());
            let n = args.next().and_then(number).filter(|n| (1..=0x1000).contains(n)).ok_or("align needs a size of 1–1000")?;
            let fill = match args.next() {
                Some(f) => number(f).filter(|f| (0..=0xff).contains(f)).ok_or(format!("bad align fill {f:?}"))?,
                None => 0x90,
            };
            if args.next().is_some() {
                return Err("align takes a size and a fill byte".into());
            }
            out.push(Stmt { line, kind: Line::Align { n: n as u64, fill: fill as u8 } });
            return Ok(());
        }
        if !word.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("expected an instruction, found {word:?}"));
        }
        let operands = if rest.trim().is_empty() {
            vec![]
        } else {
            split_top_level(rest, ',')
                .into_iter()
                .map(|o| self.operand(o.trim()))
                .collect::<PResult<Vec<_>>>()?
        };
        let mnemonic = alias(&lower, self.bits).unwrap_or(lower);
        // CE's operand-less x87 pops mean `st(1),st`.
        let operands = if operands.is_empty() && matches!(mnemonic.as_str(), "faddp" | "fsubp" | "fsubrp" | "fmulp" | "fdivp" | "fdivrp") {
            vec![Operand::Reg(Register::ST1), Operand::Reg(Register::ST0)]
        } else {
            operands
        };
        // CE assembles `push eax` / `pop r8d` as the full 64-bit register (in 64-bit code).
        let operands = if self.bits == Bits::B64 && matches!(mnemonic.as_str(), "push" | "pop") {
            operands
                .into_iter()
                .map(|o| match o {
                    Operand::Reg(r) if r.is_gpr32() => Operand::Reg(r.full_register()),
                    o => o,
                })
                .collect()
        } else {
            operands
        };
        // `nop N` is N single-byte nops (CE's injection templates); a memory operand is the long form.
        if mnemonic == "nop" {
            if let [Operand::Imm(e)] = &operands[..] {
                let n = match e {
                    Expr::Num(n) if prefixes.is_empty() && (1..=0x40).contains(n) => *n as usize,
                    _ => return Err("nop count must be 1–40".into()),
                };
                for _ in 0..n {
                    out.push(Stmt {
                        line,
                        kind: Line::Insn { prefixes: vec![], mnemonic: "nop".into(), operands: vec![] },
                    });
                }
                return Ok(());
            }
        }
        out.push(Stmt { line, kind: Line::Insn { prefixes, mnemonic, operands } });
        Ok(())
    }

    fn data_items(&self, s: &str, width: u8) -> PResult<Vec<DataItem>> {
        let mut items = vec![];
        for tok in data_tokens(s)? {
            if let Some(q) = tok.strip_prefix(['\'', '"']) {
                if width != 1 {
                    return Err("strings are only allowed in db".into());
                }
                items.push(DataItem::Bytes(q[..q.len() - 1].as_bytes().to_vec()));
                continue;
            }
            let lower = tok.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("(int)") {
                let n: i128 = v.parse().map_err(|_| format!("bad int {v:?}"))?;
                items.push(DataItem::Value(Expr::Num(n)));
                continue;
            }
            if let Some(v) = lower.strip_prefix("(float)") {
                let f: f32 = v.parse().map_err(|_| format!("bad float {v:?}"))?;
                if width != 4 {
                    return Err("(float) needs dd".into());
                }
                items.push(DataItem::Bytes(f.to_le_bytes().to_vec()));
                continue;
            }
            if let Some(v) = lower.strip_prefix("(double)") {
                let f: f64 = v.parse().map_err(|_| format!("bad double {v:?}"))?;
                if width != 8 {
                    return Err("(double) needs dq".into());
                }
                items.push(DataItem::Bytes(f.to_le_bytes().to_vec()));
                continue;
            }
            items.push(DataItem::Value(self.expr(&tok)?));
        }
        if items.is_empty() {
            // A bare `dd` reserves one zero value, as in CE.
            items.push(DataItem::Value(Expr::Num(0)));
        }
        Ok(items)
    }

    fn operand(&self, s: &str) -> PResult<Operand> {
        if s.is_empty() {
            return Err("missing operand".into());
        }
        let lower = s.to_ascii_lowercase();
        // Size keyword, optional `ptr`.
        let mut size = None;
        let mut rest = s;
        // CE also takes the keyword glued to the bracket: `byte[rdi]`, `byte ptr[rcx]`.
        let kw = [
            ("xmmword", MemSize::Xmmword),
            ("qword", MemSize::Qword),
            ("tword", MemSize::Tword),
            ("dword", MemSize::Dword),
            ("byte", MemSize::Byte),
            ("word", MemSize::Word),
        ]
        .into_iter()
        .find(|(k, _)| lower.strip_prefix(k).is_some_and(|r| r.starts_with(|c: char| c.is_whitespace() || c == '[')));
        if let Some((k, m)) = kw {
            size = Some(m);
            rest = s[k.len()..].trim_start();
            if rest.len() >= 3 && rest[..3].eq_ignore_ascii_case("ptr") && rest[3..].starts_with(|c: char| c.is_whitespace() || c == '[') {
                rest = &rest[3..];
            }
            rest = rest.trim();
        }
        // Segment override outside the brackets: `fs:[…]`.
        let mut seg = None;
        if let Some((pre, post)) = rest.split_once(':') {
            if !pre.contains('[') {
                seg = Some(segment(pre.trim())?);
                rest = post.trim();
            }
        }
        if let Some(inner) = rest.strip_prefix('[') {
            let inner = inner.strip_suffix(']').ok_or("missing ]")?;
            return self.memory(inner, size, seg);
        }
        if size.is_some() || seg.is_some() {
            return Err(format!("expected a memory operand in {s:?}"));
        }
        if let Some(r) = register(&lower) {
            return Ok(Operand::Reg(self.exists(r, s)?));
        }
        if let Some(v) = cast_value(s)? {
            return Ok(Operand::Imm(Expr::Num(v)));
        }
        Ok(Operand::Imm(self.expr(s)?))
    }

    fn memory(&self, inner: &str, size: Option<MemSize>, mut seg: Option<Register>) -> PResult<Operand> {
        let mut inner = inner.trim();
        if let Some((pre, post)) = inner.split_once(':') {
            if seg.is_some() {
                return Err("two segment overrides".into());
            }
            seg = Some(segment(pre.trim())?);
            inner = post.trim();
        }
        let (mut base, mut index, mut scale) = (None, None, 1u8);
        let mut num: i128 = 0;
        let mut sym: Option<String> = None;
        for (neg, term) in terms(inner)? {
            let lower = term.to_ascii_lowercase();
            if let Some((a, b)) = lower.split_once('*') {
                let (a, b) = (a.trim(), b.trim());
                let (r, f) = match (register(a), register(b)) {
                    (Some(r), None) => (r, b),
                    (None, Some(r)) => (r, a),
                    _ => return Err(format!("bad scaled index {term:?}")),
                };
                let f = number(f).ok_or_else(|| format!("bad scale {f:?}"))?;
                if neg || index.is_some() || !matches!(f, 1 | 2 | 4 | 8) {
                    return Err(format!("bad index {term:?}"));
                }
                index = Some(self.address_reg(r, term)?);
                scale = f as u8;
                continue;
            }
            if let Some(r) = register(&lower) {
                let r = self.address_reg(r, term)?;
                if neg {
                    return Err(format!("can't subtract register {term}"));
                }
                if base.is_none() {
                    base = Some(r);
                } else if index.is_none() {
                    index = Some(r);
                } else {
                    return Err("too many registers".into());
                }
                continue;
            }
            match self.atom(term)? {
                Expr::Num(n) => num += if neg { -n } else { n },
                Expr::Sym { name, .. } => {
                    if neg || sym.is_some() {
                        return Err(format!("can't use symbol {name} here"));
                    }
                    sym = Some(name);
                }
            }
        }
        let disp = match sym {
            Some(name) => Expr::Sym { name, addend: to_addend(num)? },
            None => Expr::Num(num),
        };
        Ok(Operand::Mem { size, seg, base, index, scale, disp })
    }

    /// `name`, `name±n`, `n`, `-n`, sums of numbers.
    fn expr(&self, s: &str) -> PResult<Expr> {
        let mut num: i128 = 0;
        let mut sym = None;
        // `#-45000` is a negative decimal.
        let s = s.replace("#-", "-#").replace("#+", "+#");
        for (neg, term) in terms(&s)? {
            if register(&term.to_ascii_lowercase()).is_some() {
                return Err(format!("register {term} not allowed here"));
            }
            match self.atom(term)? {
                Expr::Num(n) => num += if neg { -n } else { n },
                Expr::Sym { name, .. } => {
                    if neg || sym.is_some() {
                        return Err(format!("can't use symbol {name} here"));
                    }
                    sym = Some(name);
                }
            }
        }
        Ok(match sym {
            Some(name) => Expr::Sym { name, addend: to_addend(num)? },
            None => Expr::Num(num),
        })
    }

    /// One number or name. Quoted names are always symbols.
    fn atom(&self, term: &str) -> PResult<Expr> {
        if let Some(q) = term.strip_prefix('"') {
            return Ok(Expr::Sym { name: q.trim_end_matches('"').to_string(), addend: 0 });
        }
        let known = self.labels.contains(&term.to_ascii_lowercase()) || (self.is_symbol)(term);
        if !known {
            if let Some(n) = number(term) {
                return Ok(Expr::Num(n));
            }
        }
        if term.is_empty() || !term.chars().all(is_ident_char) || term.starts_with('#') {
            return Err(format!("bad value {term:?}"));
        }
        Ok(Expr::Sym { name: term.to_string(), addend: 0 })
    }
}

/// CE's typed immediates: `(float)1.5` is the IEEE single's bits, `(int)100` is decimal and
/// `(double)1.5` the IEEE double's bits. None when `s` isn't a cast.
fn cast_value(s: &str) -> PResult<Option<i128>> {
    let t = s.trim();
    let Some(close) = t.find(')') else { return Ok(None) };
    if !t.starts_with('(') {
        return Ok(None);
    }
    let kind = t[1..close].trim().to_ascii_lowercase();
    let v = t[close + 1..].trim();
    let bad = |what: &str| format!("bad {what} {v:?}");
    Ok(Some(match kind.as_str() {
        "float" => v.parse::<f32>().map_err(|_| bad("float"))?.to_bits() as i128,
        "double" => v.parse::<f64>().map_err(|_| bad("double"))?.to_bits() as i128,
        "int" => v.parse::<i128>().map_err(|_| bad("int"))?,
        _ => return Ok(None),
    }))
}

fn to_addend(n: i128) -> PResult<i64> {
    i64::try_from(n).map_err(|_| "offset out of range".to_string())
}

/// First whitespace-separated word and the rest (trimmed).
fn split_word(s: &str) -> (&str, &str) {
    let s = s.trim();
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], s[i..].trim_start()),
        None => (s, ""),
    }
}

/// Split on `sep` outside brackets and quotes.
fn split_top_level(s: &str, sep: char) -> Vec<&str> {
    let (mut out, mut depth, mut quote, mut start) = (vec![], 0i32, None, 0);
    for (i, c) in s.char_indices() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"') => quote = Some(c),
            (None, '[' | '(') => depth += 1,
            (None, ']' | ')') => depth -= 1,
            (None, _) if c == sep && depth == 0 => {
                out.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// Data items: separated by commas and/or whitespace; quoted strings kept whole (with quotes).
fn data_tokens(s: &str) -> PResult<Vec<String>> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote = None;
    for c in s.chars() {
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                quote = None;
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        match c {
            '\'' | '"' if cur.is_empty() => {
                quote = Some(c);
                cur.push(c);
            }
            ',' | ' ' | '\t' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if quote.is_some() {
        return Err("unterminated string".into());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

/// Split `a + b*4 - c` into signed terms. Quoted names are one term (quotes kept on the left).
fn terms(s: &str) -> PResult<Vec<(bool, &str)>> {
    let mut out = vec![];
    let mut neg = false;
    let mut rest = s.trim();
    if rest.is_empty() {
        return Err("missing value".into());
    }
    loop {
        rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix('-') {
            neg = !neg;
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('+') {
            rest = r;
            continue;
        }
        if rest.is_empty() {
            return Err("missing value after operator".into());
        }
        let end = if rest.starts_with('"') {
            1 + rest[1..].find('"').ok_or("unterminated name")? + 1
        } else {
            rest.find(['+', '-']).unwrap_or(rest.len())
        };
        let term = rest[..end].trim();
        if term.is_empty() {
            return Err("missing value".into());
        }
        out.push((neg, term));
        neg = false;
        rest = rest[end..].trim_start();
        if rest.is_empty() {
            return Ok(out);
        }
        if !rest.starts_with(['+', '-']) {
            return Err(format!("unexpected {rest:?}"));
        }
    }
}

/// `#123` decimal, `0x1F` hex, `1F` hex (D2). Sign is handled by the caller.
pub fn number(s: &str) -> Option<i128> {
    let (digits, radix) = if let Some(d) = s.strip_prefix('#') {
        (d, 10)
    } else if let Some(d) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        (d, 16)
    } else {
        (s, 16)
    };
    if digits.is_empty() || digits.len() > 20 || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    i128::from_str_radix(digits, radix).ok()
}

fn segment(s: &str) -> PResult<Register> {
    match s.to_ascii_lowercase().as_str() {
        "fs" => Ok(Register::FS),
        "gs" => Ok(Register::GS),
        _ => Err(format!("unsupported segment override {s:?}")),
    }
}

fn gpr64(r: Register, text: &str) -> PResult<Register> {
    if r.is_gpr64() {
        Ok(r)
    } else {
        Err(format!("{text} is not a 64-bit address register"))
    }
}

/// Registers 32-bit code has no encoding for: 64-bit GPRs, r8–r15 at any width, spl/bpl/sil/dil,
/// xmm8–xmm15.
fn only_in_64_bit(r: Register) -> bool {
    if r.is_gpr64() {
        return true;
    }
    if r.is_gpr() {
        let full = r.full_register();
        return full.number() >= 8 || matches!(r, Register::SPL | Register::BPL | Register::SIL | Register::DIL);
    }
    r.is_xmm() && r.number() >= 8
}

/// Registers the assembler accepts, by lowercase name.
pub fn register(lower: &str) -> Option<Register> {
    static MAP: OnceLock<HashMap<String, Register>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut m = HashMap::new();
        for r in Register::values() {
            let ok = r.is_gpr()
                || (r.is_xmm() && r.number() < 16)
                || matches!(r, Register::FS | Register::GS);
            if ok {
                m.insert(format!("{r:?}").to_ascii_lowercase(), r);
            }
        }
        // x87 stack registers: `st` = `st(0)`, `st(i)`, and CE's `st0`–`st7`.
        let st = [Register::ST0, Register::ST1, Register::ST2, Register::ST3, Register::ST4, Register::ST5, Register::ST6, Register::ST7];
        for (i, r) in st.into_iter().enumerate() {
            m.insert(format!("st{i}"), r);
            m.insert(format!("st({i})"), r);
        }
        m.insert("st".into(), Register::ST0);
        // iced calls the low bytes of r8–r15 `r8l`; Intel syntax says `r8b`.
        for n in 8..16 {
            let r = m[&format!("r{n}l")];
            m.insert(format!("r{n}b"), r);
        }
        m
    })
    .get(lower)
    .copied()
}

/// CE / Intel alternative mnemonics → iced's name.
fn alias(m: &str, bits: Bits) -> Option<String> {
    match (m, bits) {
        ("retn", _) => return Some("ret".into()),
        ("pushf", Bits::B64) => return Some("pushfq".into()),
        ("popf", Bits::B64) => return Some("popfq".into()),
        ("pushf", Bits::B32) => return Some("pushfd".into()),
        ("popf", Bits::B32) => return Some("popfd".into()),
        // In 32-bit code these are the 32-bit forms (`60`/`61`), as in CE and MASM.
        ("pusha", Bits::B32) => return Some("pushad".into()),
        ("popa", Bits::B32) => return Some("popad".into()),
        _ => {}
    }
    let (head, cc) = ["cmov", "set", "j"].iter().find_map(|h| m.strip_prefix(h).map(|cc| (*h, cc)))?;
    let canon = match cc {
        "z" => "e",
        "nz" => "ne",
        "c" | "nae" => "b",
        "nc" | "nb" => "ae",
        "na" => "be",
        "nbe" => "a",
        "nge" => "l",
        "nl" => "ge",
        "ng" => "le",
        "nle" => "g",
        "pe" => "p",
        "po" => "np",
        _ => return None,
    };
    Some(format!("{head}{canon}"))
}
