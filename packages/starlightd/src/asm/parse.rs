//! CE-style assembly text → statements (see the module doc in `asm` for the accepted syntax).
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
    Xmmword,
}

impl MemSize {
    pub fn bytes(self) -> usize {
        match self {
            MemSize::Byte => 1,
            MemSize::Word => 2,
            MemSize::Dword => 4,
            MemSize::Qword => 8,
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
}

/// One statement and the 1-based source line it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stmt {
    pub line: usize,
    pub kind: Line,
}

/// Parse `source`. `is_symbol` tells whether a name is a supplied symbol, which decides whether a
/// hex-looking identifier like `ab` is a number or a symbol (D2).
pub fn parse(source: &str, is_symbol: &dyn Fn(&str) -> bool) -> Result<Vec<Stmt>, AsmError> {
    let lines = strip_comments(source)?;
    let labels = defined_labels(&lines);
    let p = Parser { labels: &labels, is_symbol };
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
}

type PResult<T> = Result<T, String>;

impl Parser<'_> {
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
        let mnemonic = alias(&lower).unwrap_or(lower);
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
            return Err("data directive without items".into());
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
        let (word, after) = split_word(&lower);
        let kw = match word {
            "byte" => Some(MemSize::Byte),
            "word" => Some(MemSize::Word),
            "dword" => Some(MemSize::Dword),
            "qword" => Some(MemSize::Qword),
            "xmmword" => Some(MemSize::Xmmword),
            _ => None,
        };
        if let Some(k) = kw {
            size = Some(k);
            rest = &s[s.len() - after.len()..];
            let (w, a) = split_word(rest);
            if w.eq_ignore_ascii_case("ptr") {
                rest = a;
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
            return Ok(Operand::Reg(r));
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
                index = Some(gpr64(r, term)?);
                scale = f as u8;
                continue;
            }
            if let Some(r) = register(&lower) {
                let r = gpr64(r, term)?;
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
        for (neg, term) in terms(s)? {
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
fn alias(m: &str) -> Option<String> {
    if m == "retn" {
        return Some("ret".into());
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
