//! Typed value matching for scans (D19): parse the user's strings, compare raw memory bytes.
use crate::aob::Pattern;
use crate::rpc::{to_hex, RpcError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanType {
    Int8,
    Uint8,
    Int16,
    Uint16,
    Int32,
    Uint32,
    Int64,
    Uint64,
    Float,
    Double,
    String,
    Bytes,
}

impl ScanType {
    pub fn parse(s: &str) -> Result<ScanType, RpcError> {
        use ScanType::*;
        Ok(match s {
            "int8" => Int8,
            "uint8" => Uint8,
            "int16" => Int16,
            "uint16" => Uint16,
            "int32" => Int32,
            "uint32" => Uint32,
            "int64" => Int64,
            "uint64" => Uint64,
            "float" => Float,
            "double" => Double,
            "string" => String,
            "bytes" => Bytes,
            other => return Err(RpcError::invalid_params(format!("unknown scan type: {other:?}"))),
        })
    }

    /// Byte width of a numeric type; `None` for `string` and `bytes`, whose width is the value's.
    pub fn size(&self) -> Option<usize> {
        use ScanType::*;
        match self {
            Int8 | Uint8 => Some(1),
            Int16 | Uint16 => Some(2),
            Int32 | Uint32 | Float => Some(4),
            Int64 | Uint64 | Double => Some(8),
            String | Bytes => None,
        }
    }

    fn is_float(&self) -> bool {
        matches!(self, ScanType::Float | ScanType::Double)
    }

    /// Inclusive range of an integer type.
    fn int_range(&self) -> (i128, i128) {
        use ScanType::*;
        match self {
            Int8 => (i8::MIN.into(), i8::MAX.into()),
            Uint8 => (0, u8::MAX.into()),
            Int16 => (i16::MIN.into(), i16::MAX.into()),
            Uint16 => (0, u16::MAX.into()),
            Int32 => (i32::MIN.into(), i32::MAX.into()),
            Uint32 => (0, u32::MAX.into()),
            Int64 => (i64::MIN.into(), i64::MAX.into()),
            _ => (0, u64::MAX.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16Le,
}

impl Encoding {
    pub fn parse(s: Option<&str>) -> Result<Encoding, RpcError> {
        match s {
            None | Some("utf-8") => Ok(Encoding::Utf8),
            Some("utf-16le") => Ok(Encoding::Utf16Le),
            Some(other) => Err(RpcError::invalid_params(format!("unknown encoding: {other:?}"))),
        }
    }
}

/// A decoded memory value. Integers of every width fit in `i128` without loss.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Num {
    Int(i128),
    Float(f64),
}

/// A typed operand the user typed. Floats carry the tolerance implied by the decimals typed.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Operand {
    Int(i128),
    Float { v: f64, tol: f64 },
}

#[derive(Debug, Clone, PartialEq)]
enum Test {
    Any,
    Exact(Operand),
    Bigger(Operand),
    Smaller(Operand),
    Range(Operand, Operand),
    Increased,
    Decreased,
    IncreasedBy(Operand),
    DecreasedBy(Operand),
    Changed,
    Unchanged,
    Literal(Vec<u8>),
    Pattern(Pattern),
}

/// One scan step's comparison, built from the wire request.
#[derive(Debug, Clone)]
pub struct Matcher {
    ty: ScanType,
    width: usize,
    test: Test,
}

impl Matcher {
    /// First-scan modes: `exact`, `bigger`, `smaller`, `range`, `unknown`.
    pub fn first(
        ty: ScanType,
        mode: &str,
        value: Option<&str>,
        min: Option<&str>,
        max: Option<&str>,
        encoding: Option<&str>,
    ) -> Result<Matcher, RpcError> {
        if !matches!(mode, "exact" | "bigger" | "smaller" | "range" | "unknown") {
            return Err(RpcError::invalid_params(format!("mode {mode:?} is not allowed in a first scan")));
        }
        Self::build(ty, mode, value, min, max, encoding)
    }

    /// Next-scan modes: `exact`, `bigger`, `smaller`, `range`, `changed`, `unchanged`, `increased`,
    /// `decreased`, `increased_by`, `decreased_by`.
    pub fn next(
        ty: ScanType,
        mode: &str,
        value: Option<&str>,
        min: Option<&str>,
        max: Option<&str>,
        encoding: Option<&str>,
    ) -> Result<Matcher, RpcError> {
        if mode == "unknown" {
            return Err(RpcError::invalid_params("mode \"unknown\" is only allowed in a first scan"));
        }
        Self::build(ty, mode, value, min, max, encoding)
    }

    fn build(
        ty: ScanType,
        mode: &str,
        value: Option<&str>,
        min: Option<&str>,
        max: Option<&str>,
        encoding: Option<&str>,
    ) -> Result<Matcher, RpcError> {
        let enc = Encoding::parse(encoding)?;
        fn need<'a>(v: Option<&'a str>, mode: &str, key: &str) -> Result<&'a str, RpcError> {
            v.ok_or_else(|| RpcError::invalid_params(format!("mode {mode:?} needs {key}")))
        }
        if let Some(width) = ty.size() {
            let op = |v: Option<&str>, key: &str| need(v, mode, key).and_then(|s| parse_operand(ty, s));
            let test = match mode {
                "unknown" => Test::Any,
                "exact" => Test::Exact(op(value, "value")?),
                "bigger" => Test::Bigger(op(value, "value")?),
                "smaller" => Test::Smaller(op(value, "value")?),
                "range" => Test::Range(op(min, "min")?, op(max, "max")?),
                "changed" => Test::Changed,
                "unchanged" => Test::Unchanged,
                "increased" => Test::Increased,
                "decreased" => Test::Decreased,
                "increased_by" => Test::IncreasedBy(op(value, "value")?),
                "decreased_by" => Test::DecreasedBy(op(value, "value")?),
                other => return Err(RpcError::invalid_params(format!("unknown mode: {other:?}"))),
            };
            return Ok(Matcher { ty, width, test });
        }
        // string / bytes: only exact, changed and unchanged.
        let test = match mode {
            "exact" => {
                let v = need(value, mode, "value")?;
                if ty == ScanType::Bytes {
                    Test::Pattern(Pattern::parse(v)?)
                } else if v.is_empty() {
                    return Err(RpcError::invalid_params("value must not be empty"));
                } else {
                    Test::Literal(match enc {
                        Encoding::Utf8 => v.as_bytes().to_vec(),
                        Encoding::Utf16Le => v.encode_utf16().flat_map(u16::to_le_bytes).collect(),
                    })
                }
            }
            "changed" => Test::Changed,
            "unchanged" => Test::Unchanged,
            other => {
                return Err(RpcError::invalid_params(format!("mode {other:?} is not allowed for {ty:?} scans")))
            }
        };
        let width = match &test {
            Test::Literal(b) => b.len(),
            Test::Pattern(p) => p.len(),
            _ => 0, // set from the session by the caller (changed/unchanged keep the first scan's width)
        };
        Ok(Matcher { ty, width, test })
    }

    /// Bytes per candidate, or 0 for a string/bytes `changed`/`unchanged`, which take the session's width.
    pub fn width(&self) -> usize {
        self.width
    }

    /// `unknown`: every slot is a candidate.
    pub fn is_unknown(&self) -> bool {
        self.test == Test::Any
    }

    /// Whether `cur` (the candidate's bytes now) passes, given `prev` (its bytes at the last scan).
    /// Both slices are exactly the scan's width. Tests that need `prev` fail without it.
    pub fn matches(&self, cur: &[u8], prev: Option<&[u8]>) -> bool {
        match &self.test {
            Test::Any => true,
            Test::Changed => prev.is_some_and(|p| p != cur),
            Test::Unchanged => prev.is_some_and(|p| p == cur),
            Test::Literal(b) => cur == b.as_slice(),
            Test::Pattern(p) => p.matches_window(cur),
            test => {
                let x = decode(self.ty, cur);
                let old = || prev.map(|p| decode(self.ty, p));
                match test {
                    Test::Exact(v) => near(x, *v),
                    Test::Bigger(v) => cmp(x, *v).is_some_and(|o| o.is_gt()),
                    Test::Smaller(v) => cmp(x, *v).is_some_and(|o| o.is_lt()),
                    Test::Range(lo, hi) => {
                        cmp(x, *lo).is_some_and(|o| o.is_ge()) && cmp(x, *hi).is_some_and(|o| o.is_le())
                    }
                    Test::Increased => old().is_some_and(|o| gt(x, o)),
                    Test::Decreased => old().is_some_and(|o| gt(o, x)),
                    Test::IncreasedBy(by) => old().is_some_and(|o| near(diff(x, o), *by)),
                    Test::DecreasedBy(by) => old().is_some_and(|o| near(diff(o, x), *by)),
                    _ => unreachable!("handled above"),
                }
            }
        }
    }
}

/// Parse an operand for numeric type `ty`. Integers must fit the type (decimal, or `0x` hex).
fn parse_operand(ty: ScanType, s: &str) -> Result<Operand, RpcError> {
    let s = s.trim();
    let bad = || RpcError::invalid_params(format!("{s:?} is not a valid {ty:?} value"));
    if ty.is_float() {
        let v: f64 = s.parse().map_err(|_| bad())?;
        if !v.is_finite() {
            return Err(bad());
        }
        return Ok(Operand::Float { v, tol: tolerance(s) });
    }
    let (neg, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let magnitude = match digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")) {
        Some(hex) => i128::from_str_radix(hex, 16),
        None => digits.parse::<i128>(),
    };
    let magnitude = magnitude.ok().filter(|m| *m >= 0 && !digits.starts_with(['+', '-'])).ok_or_else(bad)?;
    let v = if neg { -magnitude } else { magnitude };
    let (lo, hi) = ty.int_range();
    if v < lo || v > hi {
        return Err(RpcError::invalid_params(format!("{s} is out of range for {ty:?}")));
    }
    Ok(Operand::Int(v))
}

/// Half a unit in the last decimal typed: "100" → 0.5, "1.5" → 0.05, "2.5e-3" → 0.00005.
fn tolerance(s: &str) -> f64 {
    let (mantissa, exp) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], s[i + 1..].parse::<i32>().unwrap_or(0)),
        None => (s, 0),
    };
    let decimals = mantissa.split_once('.').map_or(0, |(_, frac)| frac.len() as i32) - exp;
    0.5 * 10f64.powi(-decimals)
}

fn decode(ty: ScanType, b: &[u8]) -> Num {
    use ScanType::*;
    let a = |n: usize| -> [u8; 8] {
        let mut x = [0u8; 8];
        x[..n].copy_from_slice(&b[..n]);
        x
    };
    match ty {
        Int8 => Num::Int((b[0] as i8).into()),
        Uint8 => Num::Int(b[0].into()),
        Int16 => Num::Int(i16::from_le_bytes([b[0], b[1]]).into()),
        Uint16 => Num::Int(u16::from_le_bytes([b[0], b[1]]).into()),
        Int32 => Num::Int(i32::from_le_bytes([b[0], b[1], b[2], b[3]]).into()),
        Uint32 => Num::Int(u32::from_le_bytes([b[0], b[1], b[2], b[3]]).into()),
        Int64 => Num::Int(i64::from_le_bytes(a(8)).into()),
        Uint64 => Num::Int(u64::from_le_bytes(a(8)).into()),
        Float => Num::Float(f32::from_le_bytes([b[0], b[1], b[2], b[3]]).into()),
        Double => Num::Float(f64::from_le_bytes(a(8))),
        String | Bytes => unreachable!("not numeric"),
    }
}

fn cmp(x: Num, v: Operand) -> Option<std::cmp::Ordering> {
    match (x, v) {
        (Num::Int(x), Operand::Int(v)) => Some(x.cmp(&v)),
        (Num::Float(x), Operand::Float { v, .. }) => x.partial_cmp(&v),
        _ => None,
    }
}

fn gt(a: Num, b: Num) -> bool {
    match (a, b) {
        (Num::Int(a), Num::Int(b)) => a > b,
        (Num::Float(a), Num::Float(b)) => a > b,
        _ => false,
    }
}

/// `a - b` without wrapping (`i128` holds every difference of two 64-bit values).
fn diff(a: Num, b: Num) -> Num {
    match (a, b) {
        (Num::Int(a), Num::Int(b)) => Num::Int(a - b),
        (Num::Float(a), Num::Float(b)) => Num::Float(a - b),
        _ => Num::Float(f64::NAN),
    }
}

/// Integers: equal. Floats: `v - tol <= x < v + tol` (the value typed, rounded to its decimals).
fn near(x: Num, v: Operand) -> bool {
    match (x, v) {
        (Num::Int(x), Operand::Int(v)) => x == v,
        (Num::Float(x), Operand::Float { v, tol }) => x >= v - tol && x < v + tol,
        _ => false,
    }
}

/// Display text of a candidate's bytes: decimal numbers, UTF-8 text, or hex for `bytes`.
pub fn format(ty: ScanType, bytes: &[u8]) -> String {
    match ty {
        ScanType::String => String::from_utf8_lossy(bytes).into_owned(),
        ScanType::Bytes => to_hex(bytes),
        _ => match decode(ty, bytes) {
            Num::Int(v) => v.to_string(),
            Num::Float(v) if ty == ScanType::Float => (v as f32).to_string(),
            Num::Float(v) => v.to_string(),
        },
    }
}

/// `format`, decoding strings with the scan's encoding.
pub fn format_encoded(ty: ScanType, enc: Encoding, bytes: &[u8]) -> String {
    if ty == ScanType::String && enc == Encoding::Utf16Le {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    format(ty, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact(ty: ScanType, v: &str) -> Matcher {
        Matcher::first(ty, "exact", Some(v), None, None, None).unwrap()
    }

    #[test]
    fn float_exact_matches_rounded_input() {
        let m = exact(ScanType::Float, "100");
        assert!(m.matches(&99.6f32.to_le_bytes(), None));
        assert!(m.matches(&100.4f32.to_le_bytes(), None));
        assert!(m.matches(&99.5f32.to_le_bytes(), None), "the lower bound is inclusive");
        assert!(!m.matches(&100.6f32.to_le_bytes(), None));
        assert!(!m.matches(&100.5f32.to_le_bytes(), None), "the upper bound is exclusive");
        let m = exact(ScanType::Float, "1.5");
        assert!(m.matches(&1.54f32.to_le_bytes(), None));
        assert!(!m.matches(&1.56f32.to_le_bytes(), None));
        let m = exact(ScanType::Double, "3.14");
        assert!(m.matches(&std::f64::consts::PI.to_le_bytes(), None));
        assert!(exact(ScanType::Double, "3.142").matches(&std::f64::consts::PI.to_le_bytes(), None), "3.14159 rounds to 3.142");
        assert!(!exact(ScanType::Double, "3.141").matches(&std::f64::consts::PI.to_le_bytes(), None));
    }

    #[test]
    fn int64_values_are_lossless() {
        let n: i64 = 9007199254740993; // 2^53 + 1: not representable as f64
        let m = exact(ScanType::Int64, "9007199254740993");
        assert!(m.matches(&n.to_le_bytes(), None));
        assert!(!m.matches(&(n - 1).to_le_bytes(), None));
        let m = exact(ScanType::Uint64, "18446744073709551615");
        assert!(m.matches(&u64::MAX.to_le_bytes(), None));
        assert!(exact(ScanType::Int64, "-1").matches(&[0xff; 8], None));
        assert!(!exact(ScanType::Uint64, "9223372036854775807").matches(&[0xff; 8], None));
    }

    #[test]
    fn increased_by_uses_typed_arithmetic() {
        let m = Matcher::next(ScanType::Uint8, "increased_by", Some("10"), None, None, None).unwrap();
        assert!(!m.matches(&[4], Some(&[250])), "250 -> 4 wrapped; it did not increase by 10");
        assert!(m.matches(&[14], Some(&[4])));
        let m = Matcher::next(ScanType::Uint8, "increased", None, None, None, None).unwrap();
        assert!(!m.matches(&[4], Some(&[250])));
        assert!(m.matches(&[250], Some(&[4])), "unsigned: 250 is bigger than 4");
        let m = Matcher::next(ScanType::Int8, "increased", None, None, None, None).unwrap();
        assert!(m.matches(&[4], Some(&[250])), "signed: -6 -> 4 increased");
        let m = Matcher::next(ScanType::Float, "decreased_by", Some("0.5"), None, None, None).unwrap();
        assert!(m.matches(&1.0f32.to_le_bytes(), Some(&1.5f32.to_le_bytes())));
        assert!(!m.matches(&1.0f32.to_le_bytes(), Some(&2.0f32.to_le_bytes())));
    }

    #[test]
    fn bytes_scan_accepts_wildcards() {
        let m = exact(ScanType::Bytes, "DE AD ?? EF");
        assert_eq!(m.width(), 4);
        assert!(m.matches(&[0xde, 0xad, 0x00, 0xef], None));
        assert!(m.matches(&[0xde, 0xad, 0x77, 0xef], None));
        assert!(!m.matches(&[0xde, 0xad, 0x77, 0xee], None));
        assert_eq!(format(ScanType::Bytes, &[0xde, 0xad, 0x77, 0xef]), "dead77ef");
    }

    #[test]
    fn string_scan_rejects_increased() {
        for mode in ["increased", "bigger", "range", "unknown"] {
            let e = Matcher::next(ScanType::String, mode, Some("a"), Some("a"), Some("b"), None).unwrap_err();
            assert_eq!(e.code, -32602, "{mode}");
        }
        let e = Matcher::first(ScanType::Bytes, "smaller", Some("00"), None, None, None).unwrap_err();
        assert_eq!(e.code, -32602);
    }

    #[test]
    fn utf16_strings_encode_and_format() {
        let m = Matcher::first(ScanType::String, "exact", Some("Hé"), None, None, Some("utf-16le")).unwrap();
        let bytes = [0x48, 0x00, 0xe9, 0x00];
        assert_eq!(m.width(), 4);
        assert!(m.matches(&bytes, None));
        assert_eq!(format_encoded(ScanType::String, Encoding::Utf16Le, &bytes), "Hé");
        assert_eq!(Encoding::parse(Some("latin1")).unwrap_err().code, -32602);
    }

    #[test]
    fn operands_are_checked_against_the_type() {
        for (ty, v) in [(ScanType::Uint8, "256"), (ScanType::Uint32, "-1"), (ScanType::Int8, "128"), (ScanType::Int32, "1.5"), (ScanType::Float, "nan"), (ScanType::Int32, "--1")] {
            assert_eq!(Matcher::first(ty, "exact", Some(v), None, None, None).unwrap_err().code, -32602, "{ty:?} {v}");
        }
        assert!(exact(ScanType::Int8, "-128").matches(&[0x80], None));
        assert!(exact(ScanType::Int32, "0x10").matches(&16i32.to_le_bytes(), None));
        let m = Matcher::first(ScanType::Int32, "range", None, Some("-5"), Some("5"), None).unwrap();
        assert!(m.matches(&(-5i32).to_le_bytes(), None) && m.matches(&5i32.to_le_bytes(), None));
        assert!(!m.matches(&6i32.to_le_bytes(), None));
        assert_eq!(Matcher::first(ScanType::Int32, "exact", None, None, None, None).unwrap_err().code, -32602);
    }

    #[test]
    fn changed_and_unchanged_compare_bytes() {
        let c = Matcher::next(ScanType::Float, "changed", None, None, None, None).unwrap();
        let u = Matcher::next(ScanType::Float, "unchanged", None, None, None, None).unwrap();
        let (a, b) = (0.0f32.to_le_bytes(), (-0.0f32).to_le_bytes());
        assert!(c.matches(&a, Some(&b)), "0.0 and -0.0 differ in bytes");
        assert!(!u.matches(&a, Some(&b)));
        assert!(u.matches(&a, Some(&a)));
        assert!(!c.matches(&a, None) && !u.matches(&a, None), "no previous value: no match");
    }

    #[test]
    fn formats_numbers() {
        assert_eq!(format(ScanType::Int32, &(-3i32).to_le_bytes()), "-3");
        assert_eq!(format(ScanType::Uint32, &u32::MAX.to_le_bytes()), "4294967295");
        assert_eq!(format(ScanType::Float, &1.5f32.to_le_bytes()), "1.5");
        assert_eq!(format(ScanType::Double, &0.1f64.to_le_bytes()), "0.1");
        assert_eq!(format(ScanType::String, b"Hero"), "Hero");
    }
}
